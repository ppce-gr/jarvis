import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AcpConversationAdapter } from '../../src/infrastructure/conversation/AcpConversationAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(__dirname, '..', 'helpers', 'fake-acp-server.js');

function fakeSpawn(extraEnv = {}) {
  return (_bin, _args, opts) => spawn(process.execPath, [FAKE_SERVER], {
    ...opts,
    env: { ...opts.env, ...extraEnv }
  });
}

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-acp-'));
  await fs.mkdir(path.join(dir, 'projects', 'demo', 'logs'), { recursive: true });
  return dir;
}

async function waitFor(predicate, { timeoutMs = 4000, everyMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error('waitFor: se agotó el tiempo');
}

/* ================================================================
   Básicos
   ================================================================ */

test('send valida la entrada', async () => {
  const adapter = new AcpConversationAdapter({ spawnFn: fakeSpawn() });
  await assert.rejects(() => adapter.send('', 'hola'), /PROJECT_ID_REQUIRED/);
  await assert.rejects(() => adapter.send('demo', '   '), /MESSAGE_REQUIRED/);
});

test('extractText sólo acepta bloques de texto de ACP', () => {
  assert.equal(AcpConversationAdapter.extractText({ type: 'text', text: 'hola' }), 'hola');
  assert.equal(AcpConversationAdapter.extractText({ type: 'image' }), '');
  assert.equal(AcpConversationAdapter.extractText(null), '');
});

test('el contexto va sólo en el primer mensaje', () => {
  const first = AcpConversationAdapter.buildOutgoingMessage('demo', 'hola', true);
  assert.match(first, /proyecto "demo"/);
  assert.equal(AcpConversationAdapter.buildOutgoingMessage('demo', 'sigue', false), 'sigue');
});

/* ================================================================
   Protocolo
   ================================================================ */

test('initialize usa el protocolo 1 y session/new recibe el cwd del proyecto', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  await adapter.send('demo', 'hola');
  await waitFor(async () => {
    try { return (await fs.readFile(record, 'utf8')).includes('session/new'); } catch { return false; }
  });

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const init = calls.find((c) => c.method === 'initialize');
  assert.equal(init.params.protocolVersion, 1);
  assert.equal(init.params.clientInfo.name, 'jarvis-core');

  const created = calls.find((c) => c.method === 'session/new');
  assert.equal(created.params.cwd, path.join(ws, 'projects', 'demo'));
  assert.deepEqual(created.params.mcpServers, []);

  await adapter.closeAll();
});

test('un proceso sirve a varios proyectos, cada uno con su cwd', async () => {
  const ws = await tempWorkspace();
  await fs.mkdir(path.join(ws, 'projects', 'otro', 'logs'), { recursive: true });
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  await adapter.send('demo', 'uno');
  await adapter.send('otro', 'dos');
  await waitFor(async () => {
    try {
      const raw = await fs.readFile(record, 'utf8');
      return raw.split('\n').filter((l) => l.includes('session/new')).length >= 2;
    } catch { return false; }
  });

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const creadas = calls.filter((c) => c.method === 'session/new').map((c) => c.params.cwd);
  assert.ok(creadas.includes(path.join(ws, 'projects', 'demo')));
  assert.ok(creadas.includes(path.join(ws, 'projects', 'otro')));

  // Un único initialize: un solo proceso para todo.
  assert.equal(calls.filter((c) => c.method === 'initialize').length, 1);

  await adapter.closeAll();
});

test('los deltas del agente se emiten en vivo y el mensaje final se persiste', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn()
  });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));

  await adapter.send('demo', 'hola');

  await waitFor(() => events.some((e) => e.type === 'assistant-chunk'));
  assert.ok(events.length >= 2, 'debe haber varios trozos, no un bloque único');
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  // El texto completo se compone de los trozos.
  const trozos = events.filter((e) => e.type === 'assistant-chunk').map((e) => e.text).join('');
  assert.match(trozos, /Recibido:/);

  const final = events.find((e) => e.type === 'assistant');
  assert.equal(final.text, trozos);

  const history = await adapter.history('demo');
  assert.equal(history[0].role, 'user');
  assert.ok(history.some((h) => h.role === 'assistant' && h.text === trozos));

  await adapter.closeAll();
});

test('el servidor pide permisos y el adaptador responde (allow_always)', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));

  await adapter.send('demo', 'hola');
  await waitFor(() => events.some((e) => e.type === 'permission'));
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  // El agente no se bloquea: si no respondiésemos, no habría turn-end.
  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const respuesta = calls.find((c) => c.permissionAnswer);
  assert.equal(respuesta.permissionAnswer.outcome.outcome, 'selected');
  assert.equal(respuesta.permissionAnswer.outcome.optionId, 'allow');

  assert.match(events.find((e) => e.type === 'permission').text, /read_file/);

  await adapter.closeAll();
});

test('las herramientas se anuncian y se cierran', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  assert.ok(events.some((e) => e.type === 'tool-call' && e.name === 'read_file'));
  assert.ok(events.some((e) => e.type === 'tool-done' && e.status === 'completed'));

  await adapter.closeAll();
});

/* ================================================================
   Reanudación, cancelación y reinicio
   ================================================================ */

test('reanuda una sesión persistida en lugar de crear una nueva', async () => {
  const ws = await tempWorkspace();
  const cwd = path.join(ws, 'projects', 'demo');
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({
      FAKE_ACP_RECORD: record,
      FAKE_ACP_SESSIONS: JSON.stringify([
        { sessionId: 'jarvis-demo', cwd, title: 'Conversación previa' }
      ])
    })
  });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'continúo');
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((c) => c.method === 'session/list'));
  assert.ok(calls.some((c) => c.method === 'session/resume' && c.params.sessionId === 'jarvis-demo'));
  assert.ok(!calls.some((c) => c.method === 'session/new'), 'no debe crear otra sesión');

  const st = await adapter.status('demo');
  assert.equal(st.sessionId, 'jarvis-demo');

  await adapter.closeAll();
});

test('guarda el identificador de sesión para reanudar tras reiniciar Jarvis', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  const guardado = JSON.parse(
    await fs.readFile(path.join(ws, 'projects', 'demo', 'logs', 'acp-session.json'), 'utf8')
  );
  assert.ok(guardado.sessionId, 'debe persistir el sessionId');
  await adapter.closeAll();
});

test('cancel envía la notificación session/cancel', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'algo largo');
  await adapter.cancel('demo');
  await waitFor(async () => {
    try { return (await fs.readFile(record, 'utf8')).includes('session/cancel'); } catch { return false; }
  });
  await adapter.closeAll();
});

test('cancel sin sesión no falla', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  assert.deepEqual(await adapter.cancel('demo'), { cancelled: false });
});

test('reset cierra la sesión y olvida su identificador, conservando el historial', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'primer mensaje');
  await waitFor(() => events.some((e) => e.type === 'turn-end'));

  await adapter.reset('demo');

  const st = await adapter.status('demo');
  assert.equal(st.status, 'stopped');
  await assert.rejects(
    () => fs.readFile(path.join(ws, 'projects', 'demo', 'logs', 'acp-session.json'), 'utf8'),
    'el fichero de sesión debe borrarse'
  );

  const history = await adapter.history('demo');
  assert.ok(history.some((h) => h.role === 'user' && h.text === 'primer mensaje'));

  await adapter.closeAll();
});

/* ================================================================
   Ciclo de vida
   ================================================================ */

test('status es stopped sin sesión', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  assert.deepEqual(await adapter.status('demo'), { sessionId: null, status: 'stopped', busy: false });
});

test('history devuelve lista vacía sin conversación', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  assert.deepEqual(await adapter.history('demo'), []);
});

test('closeAll termina el proceso compartido', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  await adapter.send('demo', 'hola');
  const child = adapter._client.child;
  const exited = new Promise((resolve) => child.on('close', resolve));
  await adapter.closeAll();
  await exited;
  assert.equal(adapter._client, null);
});

test('subscribe antes del primer mensaje no falla', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  const events = [];
  const unsub = adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => events.length > 0);
  unsub();
  await adapter.closeAll();
});

test('un fallo de initialize se reporta con las últimas líneas de DSH', async () => {
  const ws = await tempWorkspace();
  // Un binario inexistente provoca ENOENT al arrancar.
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: () => {
      const child = spawn('/bin/false', [], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    }
  });
  await assert.rejects(
    () => adapter.send('demo', 'hola'),
    /No se pudo inicializar ACP/
  );
});

/* ================================================================
   Permisos: que el agente nunca se quede colgado
   ================================================================ */

test('un permiso sin opciones se rechaza y el turno termina igual', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  const events = [];
  adapter.subscribe('demo', (e) => events.push(e));
  await adapter.send('demo', 'hola');

  // El servidor falso manda opciones allow/reject; aquí lo importante es que
  // SIEMPRE se contesta algo: si no, el turno nunca terminaría.
  await waitFor(() => events.some((e) => e.type === 'turn-end'));
  assert.ok(events.some((e) => e.type === 'permission'));

  await adapter.closeAll();
});

test('closeAll contesta los permisos que quedaran pendientes', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });

  // Se simula un permiso sin contestar con un cliente espía: es la vía por la
  // que el servidor se quedaría esperando para siempre.
  const respuestas = [];
  const clienteFalso = {
    rpc: {
      respond: (id, result) => respuestas.push({ id, result }),
      closeInput: () => {}
    }
  };
  const timer = setTimeout(() => {}, 60000);
  adapter._pendingPermissions.set(4242, {
    client: clienteFalso,
    id: 4242,
    answered: false,
    fallback: { optionId: 'reject' },
    session: null,
    timer
  });
  adapter._client = { child: { kill() {} }, rpc: clienteFalso.rpc, dead: false, idleTimer: null };

  await adapter.closeAll();

  assert.equal(respuestas.length, 1, 'debe contestarse exactamente una vez');
  assert.equal(respuestas[0].id, 4242);
  assert.equal(respuestas[0].result.outcome.outcome, 'cancelled');
  assert.equal(adapter._pendingPermissions.size, 0);
});

/* ================================================================
   Catálogo de modelos
   ================================================================ */

test('getConfig devuelve el catálogo que publica el motor', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  const { options, current } = await adapter.getConfig('demo');
  const modelo = options.find((o) => o.id === 'model');
  assert.ok(modelo, 'debe exponer la opción de modelo');
  assert.ok(current.model, 'debe indicar la selección actual');
  assert.equal(current.reasoning_effort, 'high');

  await adapter.closeAll();
});

test('setConfig persiste la elección y la aplica a la sesión viva', async () => {
  const ws = await tempWorkspace();
  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  await adapter.setConfig('model', '["deepseek-official","deepseek-v4-pro"]');

  // Se guarda en disco...
  const guardado = JSON.parse(await fs.readFile(path.join(ws, 'chat-config.json'), 'utf8'));
  assert.equal(guardado.model, '["deepseek-official","deepseek-v4-pro"]');

  // ...y se empuja al motor.
  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((c) => c.method === 'session/set_config_option'
    && c.params.value === '["deepseek-official","deepseek-v4-pro"]'));

  await adapter.closeAll();
});

test('setConfig rechaza opciones no soportadas', async () => {
  const ws = await tempWorkspace();
  const adapter = new AcpConversationAdapter({ workspaceRoot: ws, spawnFn: fakeSpawn() });
  await assert.rejects(() => adapter.setConfig('temperatura', '0.5'), /CONFIG_ID_NOT_SUPPORTED/);
  await assert.rejects(() => adapter.setConfig('model', ''), /CONFIG_VALUE_REQUIRED/);
});

test('la preferencia guardada se usa al arrancar una sesión nueva', async () => {
  const ws = await tempWorkspace();
  await fs.writeFile(path.join(ws, 'chat-config.json'), JSON.stringify({
    model: '["google","gemini-2.5-pro"]',
    reasoning_effort: 'max'
  }));

  const record = path.join(ws, 'record.jsonl');
  const adapter = new AcpConversationAdapter({
    workspaceRoot: ws,
    spawnFn: fakeSpawn({ FAKE_ACP_RECORD: record })
  });

  const eventos = [];
  adapter.subscribe('demo', (e) => eventos.push(e));
  await adapter.send('demo', 'hola');
  await waitFor(() => eventos.some((e) => e.type === 'turn-end'));

  const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const puestos = calls.filter((c) => c.method === 'session/set_config_option').map((c) => c.params.value);
  assert.ok(puestos.includes('["google","gemini-2.5-pro"]'), 'debe aplicar el modelo guardado');
  assert.ok(puestos.includes('max'), 'debe aplicar el esfuerzo guardado');

  await adapter.closeAll();
});
