import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AcpConversationAdapter } from '../../src/infrastructure/conversation/AcpConversationAdapter.js';
import { DshSdkConversationAdapter } from '../../src/infrastructure/conversation/DshSdkConversationAdapter.js';

/**
 * Sub-chats: cuando el hilo engorda, Jarvis lo parte en una sesión nueva
 * sembrada con un resumen, sin que el usuario note el cambio. El resumen lo
 * pide con un turno oculto (no se pinta).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(__dirname, '..', 'helpers', 'fake-acp-server.js');
const FAKE_SDK = path.join(__dirname, '..', 'helpers', 'fake-dsh-sdk.js');

function fakeSpawn() {
  return (_bin, _args, opts) => spawn(process.execPath, [FAKE_SERVER], { ...opts });
}

function fakeSpawnSdk() {
  return (_bin, _args, opts) => spawn(process.execPath, [FAKE_SDK], { ...opts });
}

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-subchat-'));
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

test('al pasar el umbral parte en un sub-chat con resumen', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({
    brainDir: ws,
    spawnFn: fakeSpawn(),
    subchatLimits: { maxTokens: 1, maxBytes: 1 } // siempre parte
  });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));

  await adapter.send('demo', 'primero');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  // El segundo mensaje ya encuentra historial y dispara la partición.
  await adapter.send('demo', 'segundo');
  await waitFor(() => eventos.some((e) => e.type === 'subchat'));
  await waitFor(() => eventos.filter((e) => e.type === 'turn-end').length >= 2);

  const history = await adapter.history('demo');
  const marca = history.find((h) => h.role === 'subchat');
  assert.ok(marca, 'debe guardar la marca de sub-chat');
  assert.equal(marca.n, 2);
  assert.match(marca.resumen, /RESUMEN_FAKE/);

  const evento = eventos.find((e) => e.type === 'subchat');
  assert.equal(evento.n, 2);
  assert.match(evento.resumen, /RESUMEN_FAKE/);

  // El turno siguió en la sesión nueva, después de la marca.
  const iMarca = history.findIndex((h) => h.role === 'subchat');
  const iSegundo = history.findIndex((h) => h.role === 'user' && h.text === 'segundo');
  assert.ok(iSegundo > iMarca, 'el mensaje nuevo va después de la marca');

  await adapter.closeAll();
});

test('sin pasar el umbral no parte el hilo', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ brainDir: ws, spawnFn: fakeSpawn() });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  const history = await adapter.history('demo');
  assert.ok(!history.some((h) => h.role === 'subchat'));
  assert.ok(!eventos.some((e) => e.type === 'subchat'));

  await adapter.closeAll();
});

test('continuar arma un sub-chat con resumen del hilo guardado', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ brainDir: ws, spawnFn: fakeSpawn() });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  // «Continuar»: se resetea la sesión y se arma el resumen.
  await adapter.reset('demo');
  await adapter.summarizeNext('demo');

  await adapter.send('demo', 'sigo');
  await waitFor(() => eventos.some((e) => e.type === 'subchat'));
  const history = await adapter.history('demo');
  const marca = history.find((h) => h.role === 'subchat');
  assert.ok(marca);
  assert.match(marca.resumen, /RESUMEN_FAKE/);

  await adapter.closeAll();
});

/* ================================================================
   Sub-chats en el protocolo SDK (proceso por proyecto, sin reanudación)
   ================================================================ */

test('el protocolo SDK también parte en sub-chats con resumen', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({
    brainDir: ws,
    spawnFn: fakeSpawnSdk(),
    subchatLimits: { maxTokens: 1, maxBytes: 1 } // siempre parte
  });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));

  await adapter.send('demo', 'primero');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  await adapter.send('demo', 'segundo');
  await waitFor(() => eventos.some((e) => e.type === 'subchat'));
  await waitFor(() => eventos.filter((e) => e.type === 'turn-end').length >= 2);

  const history = await adapter.history('demo');
  const marca = history.find((h) => h.role === 'subchat');
  assert.ok(marca, 'debe guardar la marca de sub-chat');
  assert.equal(marca.n, 2);
  assert.match(marca.resumen, /RESUMEN_FAKE/);

  const evento = eventos.find((e) => e.type === 'subchat');
  assert.equal(evento.n, 2);
  assert.match(evento.resumen, /RESUMEN_FAKE/);

  const iMarca = history.findIndex((h) => h.role === 'subchat');
  const iSegundo = history.findIndex((h) => h.role === 'user' && h.text === 'segundo');
  assert.ok(iSegundo > iMarca, 'el mensaje nuevo va después de la marca');

  await adapter.closeAll();
});

test('SDK: sin pasar el umbral no parte el hilo', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ brainDir: ws, spawnFn: fakeSpawnSdk() });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  const history = await adapter.history('demo');
  assert.ok(!history.some((h) => h.role === 'subchat'));
  assert.ok(!eventos.some((e) => e.type === 'subchat'));

  await adapter.closeAll();
});

test('SDK: continuar arma un sub-chat con resumen del hilo guardado', async () => {
  const ws = await tempWorkspace();
  const adapter = new DshSdkConversationAdapter({ brainDir: ws, spawnFn: fakeSpawnSdk() });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  // «Continuar»: se resetea la sesión y se arma el resumen.
  await adapter.reset('demo');
  await adapter.summarizeNext('demo');

  await adapter.send('demo', 'sigo');
  await waitFor(() => eventos.some((e) => e.type === 'subchat'));
  const history = await adapter.history('demo');
  const marca = history.find((h) => h.role === 'subchat');
  assert.ok(marca);
  assert.match(marca.resumen, /RESUMEN_FAKE/);

  await adapter.closeAll();
});
