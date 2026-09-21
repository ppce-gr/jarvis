import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { JsonRpcStdioClient } from '../../src/infrastructure/conversation/JsonRpcStdioClient.js';
import { DshSdkConversationAdapter } from '../../src/infrastructure/conversation/DshSdkConversationAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(__dirname, '..', 'helpers', 'fake-dsh-sdk.js');

/** Lanza el servidor falso en lugar del `dsh` real. */
function fakeSpawn(extraEnv = {}) {
  return (_bin, _args, opts) => spawn(process.execPath, [FAKE_SERVER], {
    ...opts,
    env: { ...opts.env, ...extraEnv }
  });
}

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-chat-'));
  await fs.mkdir(path.join(dir, 'projects', 'demo', 'logs'), { recursive: true });
  return dir;
}

/** Espera a que se cumpla una condición, con límite. */
async function waitFor(predicate, { timeoutMs = 3000, everyMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error('waitFor: se agotó el tiempo');
}

/* ================================================================
   Transporte JSON-RPC
   ================================================================ */

test('JsonRpcStdioClient resuelve peticiones por id y enruta notificaciones', async () => {
  const child = fakeSpawn()('x', [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const rpc = new JsonRpcStdioClient(child);

  const notifications = [];
  rpc.on('notification', (method, params) => notifications.push({ method, params }));

  const result = await rpc.request('initialize', { cwd: '/tmp' });
  assert.equal(result.serverInfo.name, 'deepseek-harness-sdk-runtime');

  await rpc.request('session/prompt', { sessionId: 's1', contentBlocks: [{ type: 'text', text: 'hola' }] });
  await waitFor(() => notifications.some((n) => n.method === 'session.event'));

  assert.ok(notifications.some((n) => n.method === 'session.status'));
  assert.ok(notifications.some((n) => n.method === 'session.event'));

  child.kill('SIGKILL');
});

test('JsonRpcStdioClient ignora líneas malformadas del servidor', async () => {
  // El servidor escupe basura por stdout antes de responder: el cliente
  // debe ignorarla (contrato del protocolo) y resolver igualmente.
  const child = fakeSpawn({ FAKE_DSH_GARBAGE: '1' })('x', [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });
  const rpc = new JsonRpcStdioClient(child);

  const malformed = [];
  rpc.on('malformed', (line) => malformed.push(line));

  const result = await rpc.request('initialize', { cwd: '/tmp' });
  assert.equal(result.serverInfo.name, 'deepseek-harness-sdk-runtime');
  await waitFor(() => malformed.length >= 2);
  assert.equal(malformed.length, 2);

  child.kill('SIGKILL');
});

test('JsonRpcStdioClient rechaza con el error del servidor', async () => {
  const child = fakeSpawn()('x', [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const rpc = new JsonRpcStdioClient(child);

  await assert.rejects(
    () => rpc.request('metodo/inexistente', {}),
    /método desconocido/
  );

  child.kill('SIGKILL');
});

/* ================================================================
   Adaptador de conversación
   ================================================================ */

test('extractText une sólo los bloques de texto', () => {
  const content = [
    { type: 'reasoning', text: 'pensando' },
    { type: 'text', text: 'Hola' },
    { type: 'tool-call', name: 'read' },
    { type: 'text', text: 'mundo' }
  ];
  assert.equal(DshSdkConversationAdapter.extractText(content), 'Hola\nmundo');
  assert.equal(DshSdkConversationAdapter.extractText(undefined), '');
  assert.equal(DshSdkConversationAdapter.extractText([{ type: 'text' }]), '');
});

test('buildOutgoingMessage da contexto sólo en el primer mensaje', () => {
  const first = DshSdkConversationAdapter.buildOutgoingMessage('demo', 'hola', true);
  assert.match(first, /proyecto "demo"/);
  assert.match(first, /conceptual\//);
  assert.match(first, /hola$/);

  const later = DshSdkConversationAdapter.buildOutgoingMessage('demo', 'sigue', false);
  assert.equal(later, 'sigue');
});

test('el contexto del proyecto se inyecta sólo en el primer turno', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new DshSdkConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_DSH_RECORD: record })
  });

  await adapter.send('demo', 'primer turno');
  await waitFor(async () => {
    try { return (await fs.readFile(record, 'utf8')).includes('session/prompt'); } catch { return false; }
  });
  await adapter.send('demo', 'segundo turno');
  await waitFor(async () => {
    try {
      const raw = await fs.readFile(record, 'utf8');
      return raw.trim().split('\n').filter((l) => l.includes('session/prompt')).length >= 2;
    } catch { return false; }
  });

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const prompts = calls.filter((c) => c.method === 'session/prompt');

  assert.match(prompts[0].params.contentBlocks[0].text, /proyecto "demo"/);
  assert.equal(prompts[1].params.contentBlocks[0].text, 'segundo turno');

  // El transcript guarda lo que escribió el usuario, sin el preámbulo.
  const history = await adapter.history('demo');
  assert.equal(history[0].text, 'primer turno');

  await adapter.closeAll();
});

test('send valida la entrada', async () => {
  const adapter = new DshSdkConversationAdapter({ spawnFn: fakeSpawn() });
  await assert.rejects(() => adapter.send('', 'hola'), /PROJECT_ID_REQUIRED/);
  await assert.rejects(() => adapter.send('demo', '   '), /MESSAGE_REQUIRED/);
});

test('send inicializa la sesión con el cwd del proyecto y el modelo', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new DshSdkConversationAdapter({
    workspaceRoot: ws,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    spawnFn: fakeSpawn({ FAKE_DSH_RECORD: record })
  });

  await adapter.send('demo', 'hola');
  await waitFor(async () => {
    try {
      return (await fs.readFile(record, 'utf8')).includes('initialize');
    } catch { return false; }
  });

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const init = calls.find((c) => c.method === 'initialize');

  assert.equal(init.params.cwd, path.join(ws, 'projects', 'demo'));
  assert.equal(init.params.provider, 'deepseek-official');
  assert.equal(init.params.model, 'deepseek-v4-flash');
  assert.equal(init.params.reasoningEffort, 'high');

  const prompt = calls.find((c) => c.method === 'session/prompt');
  assert.equal(prompt.params.sessionId, 'jarvis-demo');
  // El primer mensaje lleva el preámbulo de contexto del proyecto.
  assert.equal(prompt.params.contentBlocks.length, 1);
  assert.equal(prompt.params.contentBlocks[0].type, 'text');
  assert.match(prompt.params.contentBlocks[0].text, /proyecto "demo"/);
  assert.match(prompt.params.contentBlocks[0].text, /hola$/);

  await adapter.closeAll();
});

test('los eventos del agente se emiten y se persisten en el transcript', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn()
  });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));

  await adapter.send('demo', '¿qué hay?');

  await waitFor(() => events.some((e) => e.type === 'assistant'));
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  assert.ok(events.some((e) => e.type === 'tool-call' && e.name === 'read'));
  assert.ok(events.some((e) => e.type === 'status' && e.status === 'running'));
  assert.ok(events.some((e) => e.type === 'status' && e.status === 'idle'));

  const assistant = events.find((e) => e.type === 'assistant');
  assert.equal(assistant.text, 'Respuesta de prueba');

  // El transcript en disco debe contener el mensaje del usuario y la respuesta.
  const history = await adapter.history('demo');
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].text, '¿qué hay?');
  assert.ok(history.some((h) => h.role === 'assistant' && h.text === 'Respuesta de prueba'));
  assert.ok(history.some((h) => h.role === 'tool' && h.text === 'read'));

  await adapter.closeAll();
});

test('history devuelve lista vacía sin conversación previa', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  assert.deepEqual(await adapter.history('demo'), []);
});

test('un fallo de initialize se reporta con las últimas líneas de DSH', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_DSH_FAIL_INIT: '1' })
  });

  await assert.rejects(
    () => adapter.send('demo', 'hola'),
    /No se pudo inicializar la conversación con DSH/
  );
  await adapter.closeAll();
});

test('reset reinicia la conversación y permite volver a hablar', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });

  await adapter.send('demo', 'primer mensaje');
  const before = await adapter.status('demo');
  assert.equal(before.sessionId, 'jarvis-demo');

  await adapter.reset('demo');

  const after = await adapter.status('demo');
  assert.equal(after.status, 'stopped');
  assert.equal(after.sessionId, null);

  // Tras reiniciar, se puede volver a escribir y el historial se conserva.
  await adapter.send('demo', 'segundo mensaje');
  const history = await adapter.history('demo');
  assert.equal(history.filter((h) => h.role === 'user').length, 2);

  await adapter.closeAll();
});

test('subscribe antes del primer mensaje no falla', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });

  const events = [];
  const unsubscribe = adapter.subscribe('demo', (e) => events.push(e));
  assert.equal(typeof unsubscribe, 'function');

  await adapter.send('demo', 'hola');
  await waitFor(() => events.length > 0);

  unsubscribe();
  await adapter.closeAll();
});

test('el estado es stopped cuando no hay sesión', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  assert.deepEqual(await adapter.status('demo'), { sessionId: null, status: 'stopped', busy: false });
});

test('closeAll termina los procesos vivos', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });

  await adapter.send('demo', 'hola');
  const session = adapter._sessions.get('demo');
  const exited = new Promise((resolve) => session.child.on('close', resolve));

  await adapter.closeAll();
  await exited;                        // si no muere, la prueba se queda colgada
  assert.equal(adapter._sessions.size, 0);
});
