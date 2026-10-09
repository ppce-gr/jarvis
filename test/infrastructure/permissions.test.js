import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { FileSystemPermissionAdapter } from '../../src/infrastructure/persistence/FileSystemPermissionAdapter.js';
import { ManagePermissionsUseCase } from '../../src/application/ManagePermissionsUseCase.js';

/** Helper de root falso: escribe el resultado y cierra, como el real. */
function helperFalso({ escribir = true, codigo = 0, err = '' } = {}) {
  const llamadas = { pin: '', args: null };
  const spawnFn = (bin, args) => {
    llamadas.args = args;
    const hijo = new EventEmitter();
    hijo.stdout = new EventEmitter();
    hijo.stderr = new EventEmitter();
    hijo.stdin = { write: (d) => { llamadas.pin += d; }, end: () => {} };
    if (escribir) {
      const pendiente = args[3];
      const destino = path.join(path.dirname(path.dirname(pendiente)), 'resultados', path.basename(pendiente));
      const entrada = JSON.parse(fsSync.readFileSync(pendiente, 'utf8'));
      fsSync.mkdirSync(path.dirname(destino), { recursive: true });
      fsSync.writeFileSync(destino, JSON.stringify({ ...entrada, estado: 'ejecutada', aprobado: true, codigo: 0, salida: 'hecho' }));
      fsSync.rmSync(pendiente, { force: true });
    }
    setTimeout(() => {
      if (err) hijo.stderr.emit('data', err);
      hijo.emit('close', codigo);
    }, 0);
    return hijo;
  };
  return { spawnFn, llamadas };
}

async function conPermisos(opciones = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-perm-'));
  const { spawnFn, llamadas } = helperFalso(opciones);
  const adapter = new FileSystemPermissionAdapter({ brainDir: dir, spawnFn });
  return { dir, adapter, caso: new ManagePermissionsUseCase(adapter), llamadas };
}

test('pedir permiso deja una petición pendiente (no ejecuta nada)', async () => {
  const { caso } = await conPermisos();
  const p = await caso.request('idea', 'systemctl restart nginx', 'para probar');
  assert.ok(p.id);

  const { pendientes } = await caso.list('idea');
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].comando, 'systemctl restart nginx');
  assert.equal(pendientes[0].motivo, 'para probar');
  assert.equal(pendientes[0].estado, 'pendiente');
});

test('aprobar manda el PIN al helper y devuelve el resultado', async () => {
  const { caso, llamadas } = await conPermisos();
  const p = await caso.request('idea', 'echo hola', 'motivo');

  const r = await caso.approve('idea', p.id, 'secreto123');
  assert.equal(llamadas.pin, 'secreto123\n', 'el PIN va por stdin, una vez');
  assert.deepEqual(llamadas.args.slice(0, 3), ['-n', '/usr/local/sbin/jarvis-permiso', 'aprobar']);
  assert.equal(r.aprobado, true);
  assert.equal(r.salida, 'hecho');

  const { pendientes, resultados } = await caso.list('idea');
  assert.equal(pendientes.length, 0);
  assert.equal(resultados.length, 1);
  assert.equal(resultados[0].estado, 'ejecutada');
});

test('aprobar sin PIN no llama al helper', async () => {
  const { caso, llamadas } = await conPermisos();
  const p = await caso.request('idea', 'echo hola', '');
  await assert.rejects(() => caso.approve('idea', p.id, ''), /PERMISSION_PIN_REQUIRED/);
  assert.equal(llamadas.args, null);
});

test('si el helper falla (PIN malo), se propaga su error y queda pendiente', async () => {
  const { caso } = await conPermisos({ escribir: false, codigo: 1, err: 'PIN incorrecto' });
  const p = await caso.request('idea', 'echo hola', '');
  await assert.rejects(() => caso.approve('idea', p.id, 'malo'), /PIN incorrecto/);
  const { pendientes } = await caso.list('idea');
  assert.equal(pendientes.length, 1);
});

test('rechazar mueve la petición a resultados como rechazada', async () => {
  const { caso } = await conPermisos();
  const p = await caso.request('idea', 'echo hola', '');
  const r = await caso.reject('idea', p.id, 'no hace falta');
  assert.equal(r.aprobado, false);

  const { pendientes, resultados } = await caso.list('idea');
  assert.equal(pendientes.length, 0);
  assert.equal(resultados[0].estado, 'rechazada');
  assert.match(resultados[0].salida, /no hace falta/);
});

test('un id con ruta no vale', async () => {
  const { caso } = await conPermisos();
  await assert.rejects(() => caso.approve('idea', '../fuera', 'x'), /PERMISSION_ID_INVALID/);
  await assert.rejects(() => caso.reject('idea', 'a/b', ''), /PERMISSION_ID_INVALID/);
});
