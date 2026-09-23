import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AcpConversationAdapter } from '../../src/infrastructure/conversation/AcpConversationAdapter.js';
import { MODEL_STATUS } from '../../src/domain/ModelHealth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(__dirname, '..', 'helpers', 'fake-acp-server.js');

const CATALOGO = {
  providers: [
    {
      id: 'p1',
      name: 'Proveedor 1',
      models: [
        { id: 'bueno', name: 'Bueno', reasoning: true },
        { id: 'sin-esfuerzo', name: 'Sin esfuerzo', reasoning: false },
        { id: 'roto', name: 'Roto', reasoning: false, fail: 'notfound' },
        { id: 'sin-cuota', name: 'Sin cuota', reasoning: true, fail: 'quota' }
      ]
    }
  ]
};

const BUENO = '["p1","bueno"]';
const SIN_ESFUERZO = '["p1","sin-esfuerzo"]';
const ROTO = '["p1","roto"]';
const SIN_CUOTA = '["p1","sin-cuota"]';

function fakeSpawn(extraEnv = {}) {
  return (_bin, _args, opts) => spawn(process.execPath, [FAKE_SERVER], {
    ...opts,
    env: { ...opts.env, FAKE_ACP_MODELS: JSON.stringify(CATALOGO), ...extraEnv }
  });
}

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-models-'));
  await fs.mkdir(path.join(dir, 'demo', 'logs'), { recursive: true });
  return dir;
}

async function waitFor(predicate, { timeoutMs = 8000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error('waitFor: se agotó el tiempo');
}

function modelosDe(options) {
  const opt = (options || []).find((o) => o.id === 'model');
  return (opt?.options || []).flatMap((g) => (g.options || []).map((i) => i.value));
}

/* ================================================================
   El parámetro de esfuerzo
   ================================================================ */

test('no se envía esfuerzo si el modelo no lo admite', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    brainDir: ws,
    provider: 'p1',
    model: 'sin-esfuerzo',
    reasoningEffort: 'max',
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const puestos = calls.filter((c) => c.method === 'session/set_config_option');
  assert.ok(puestos.some((c) => c.params.configId === 'model' && c.params.value === SIN_ESFUERZO));
  assert.ok(
    !puestos.some((c) => c.params.configId === 'reasoning_effort'),
    'no debe mandar esfuerzo a un modelo que no lo soporta'
  );

  await adapter.closeAll();
});

test('setConfig rechaza esfuerzo cuando el modelo no lo admite', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({
    brainDir: ws,
    provider: 'p1',
    model: 'bueno',
    spawnFn: fakeSpawn()
  });

  await adapter.getConfig('demo');
  await adapter.setConfig('model', SIN_ESFUERZO);
  await assert.rejects(
    () => adapter.setConfig('reasoning_effort', 'high'),
    /REASONING_NOT_SUPPORTED/
  );

  await adapter.closeAll();
});

/* ================================================================
   Comprobación completa
   ================================================================ */

test('refreshModels clasifica cada modelo y getConfig retira los rotos', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({
    brainDir: ws,
    provider: 'p1',
    model: 'bueno',
    spawnFn: fakeSpawn()
  });

  const arrancado = await adapter.refreshModels();
  assert.equal(arrancado.started, true);

  await waitFor(async () => (await adapter.getModelHealth()).checking === false, { timeoutMs: 15000 });
  const health = await adapter.getModelHealth();

  assert.equal(health.results[BUENO].status, MODEL_STATUS.OK);
  assert.equal(health.results[BUENO].supportsEffort, true);
  assert.equal(health.results[SIN_ESFUERZO].status, MODEL_STATUS.OK);
  assert.equal(health.results[SIN_ESFUERZO].supportsEffort, false);
  assert.equal(health.results[ROTO].status, MODEL_STATUS.BROKEN);
  assert.equal(health.results[SIN_CUOTA].status, MODEL_STATUS.QUOTA);

  const { options, current } = await adapter.getConfig('demo');
  const visibles = modelosDe(options);
  assert.ok(visibles.includes(BUENO));
  assert.ok(visibles.includes(SIN_CUOTA), 'los que no tienen cuota se conservan');
  assert.ok(visibles.includes(SIN_ESFUERZO));
  assert.ok(visibles.includes(ROTO), 'los rotos siguen en el catálogo, marcados aparte');
  const itemRoto = options.find((o) => o.id === 'model').options[0].options
    .find((i) => i.value === ROTO);
  assert.equal(itemRoto.health.status, MODEL_STATUS.BROKEN);
  assert.equal(current.supportsEffort, true);

  await adapter.closeAll();
});

test('un fallo real marca el modelo como roto', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({
    brainDir: ws,
    provider: 'p1',
    model: 'roto',
    spawnFn: fakeSpawn()
  });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'error'));

  await waitFor(async () => {
    const h = await adapter.getModelHealth();
    return h.results[ROTO]?.status === MODEL_STATUS.BROKEN;
  });

  const { options } = await adapter.getConfig('demo');
  const itemRoto = options.find((o) => o.id === 'model').options[0].options
    .find((i) => i.value === ROTO);
  assert.equal(itemRoto?.health.status, MODEL_STATUS.BROKEN);

  await adapter.closeAll();
});

test('la salud persiste entre reinicios del adaptador', async () => {
  const ws = await tempWorkspace();
  const primero = new AcpConversationAdapter({
    brainDir: ws,
    provider: 'p1',
    model: 'bueno',
    spawnFn: fakeSpawn()
  });
  await primero.refreshModels();
  await waitFor(async () => (await primero.getModelHealth()).checking === false, { timeoutMs: 15000 });
  await primero.closeAll();

  const segundo = new AcpConversationAdapter({ brainDir: ws, spawnFn: fakeSpawn() });
  const health = await segundo.getModelHealth();
  assert.equal(health.results[ROTO].status, MODEL_STATUS.BROKEN);
  assert.ok(health.checkedAt, 'debe recordar cuándo se comprobó');
});

/* ================================================================
   Refresco de un solo modelo
   ================================================================ */

test('refreshModel comprueba sólo el modelo pedido', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({
    brainDir: ws,
    provider: 'p1',
    model: 'bueno',
    spawnFn: fakeSpawn()
  });

  const res = await adapter.refreshModel(ROTO);
  assert.equal(res.model, ROTO);
  assert.equal(res.status, MODEL_STATUS.BROKEN);

  const health = await adapter.getModelHealth();
  assert.equal(health.results[ROTO].status, MODEL_STATUS.BROKEN);
  assert.equal(health.results[BUENO], undefined, 'no debe tocar los demás modelos');

  await adapter.closeAll();
});

test('refreshModel exige un modelo', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ brainDir: ws, spawnFn: fakeSpawn() });
  await assert.rejects(() => adapter.refreshModel(''), /MODEL_REQUIRED/);
});
