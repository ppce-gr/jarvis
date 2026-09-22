import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DshHeadlessOrchestratorAdapter } from '../../src/infrastructure/orchestrator/DshHeadlessOrchestratorAdapter.js';

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-orch-'));
  await fs.mkdir(path.join(dir, 'demo', 'conceptual'), { recursive: true });
  return dir;
}

/** Espera a que la cola interna del adaptador drene. */
async function drain(adapter) {
  await adapter._chain;
}

test('executeTask valida la entrada', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    runner: async () => ({ code: 0, stdout: '' })
  });
  await assert.rejects(() => adapter.executeTask('', 'algo'), /PROJECT_ID_REQUIRED/);
  await assert.rejects(() => adapter.executeTask('p', ''), /INSTRUCTION_REQUIRED/);
  await assert.rejects(() => adapter.executeTask('p', '   '), /INSTRUCTION_REQUIRED/);
});

test('executeTask devuelve acuse inmediato sin esperar al agente', async () => {
  const ws = await tempWorkspace();
  let release;
  const gate = new Promise((r) => { release = r; });
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    runner: async () => { await gate; return { code: 0, stdout: 'hecho' }; }
  });

  const ack = await adapter.executeTask('demo', 'haz algo');
  assert.equal(ack.accepted, true);
  assert.equal(ack.status, 'queued');
  assert.ok(ack.taskId);

  // El acuse llegó antes de que el runner terminase.
  const running = await adapter.listTasks('demo');
  assert.equal(running.length, 1);

  release();
  await drain(adapter);
});

test('una tarea completada escribe bitácora y respuesta final', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    runner: async ({ onStderr }) => {
      onStderr('pensando...\n');
      return { code: 0, stdout: 'Tarea completada con éxito' };
    }
  });

  const { taskId } = await adapter.executeTask('demo', 'crea el backend');
  await drain(adapter);

  const [task] = await adapter.listTasks('demo');
  assert.equal(task.taskId, taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.exitCode, 0);
  assert.equal(task.answer, 'Tarea completada con éxito');

  const log = await fs.readFile(
    path.join(ws, 'demo', task.logFile),
    'utf8'
  );
  assert.match(log, /## Orden/);
  assert.match(log, /crea el backend/);
  assert.match(log, /pensando\.\.\./);
  assert.match(log, /Tarea completada con éxito/);

  const summary = await fs.readFile(
    path.join(ws, 'demo', 'logs', 'orchestrator.log'),
    'utf8'
  );
  assert.match(summary, /COMPLETED/);
});

test('un fallo del agente se registra como failed con su exit code', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    runner: async () => ({ code: 1, stdout: '', stderr: 'boom' })
  });

  await adapter.executeTask('demo', 'algo imposible');
  await drain(adapter);

  const [task] = await adapter.listTasks('demo');
  assert.equal(task.status, 'failed');
  assert.equal(task.exitCode, 1);
});

test('un timeout se registra como timeout', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    runner: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true })
  });

  await adapter.executeTask('demo', 'tarea eterna');
  await drain(adapter);

  const [task] = await adapter.listTasks('demo');
  assert.equal(task.status, 'timeout');
});

test('el runner recibe cwd del proyecto y el perfil configurado', async () => {
  const ws = await tempWorkspace();
  let seen = null;
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    profile: 'headless',
    dshHome: '/tmp/fake-home',
    runner: async (opts) => { seen = opts; return { code: 0, stdout: 'ok' }; }
  });

  await adapter.executeTask('demo', 'revisa esto');
  await drain(adapter);

  assert.equal(seen.cwd, path.join(ws, 'demo'));
  assert.deepEqual(seen.args.slice(0, 2), ['--profile', 'headless']);
  assert.match(seen.args[2], /revisa esto/);
  assert.equal(seen.env.DSH_HOME, '/tmp/fake-home');
});

test('las tareas se ejecutan en serie (cola de uno)', async () => {
  const ws = await tempWorkspace();
  let active = 0;
  let maxActive = 0;
  const adapter = new DshHeadlessOrchestratorAdapter({
    brainDir: ws,
    runner: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return { code: 0, stdout: 'ok' };
    }
  });

  await Promise.all([
    adapter.executeTask('demo', 'tarea 1'),
    adapter.executeTask('demo', 'tarea 2'),
    adapter.executeTask('demo', 'tarea 3')
  ]);
  await drain(adapter);

  assert.equal(maxActive, 1, 'nunca debe haber dos agentes a la vez en la Pi');
  assert.equal((await adapter.listTasks('demo')).length, 3);
});
