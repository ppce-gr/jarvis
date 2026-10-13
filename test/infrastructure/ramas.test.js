import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Prueba de las ramas de tarea.
 * ------------------------------------------------------------------
 * `scripts/ramas.sh` es la red de seguridad de la automodificación: cada tarea
 * va en `tarea/<slug>` y antes de abrirla se guarda un snapshot (commit base +
 * ficheros no seguidos) dentro de `.git/jarvis-ramas/`, que nunca se versiona.
 * Si algo sale mal, `restaurar` vuelve a `main` y devuelve la configuración.
 */
const execFileAsync = promisify(execFile);
const RAMAS = fileURLToPath(new URL('../../scripts/ramas.sh', import.meta.url));

/** Repo temporal con un fichero versionado y dos ignorados (config y clave). */
async function entorno() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-ramas-'));
  const git = (args) => execFileAsync('git', args, { cwd: dir });

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'Prueba']);
  await git(['config', 'user.email', 'prueba@test.local']);
  await fs.writeFile(path.join(dir, '.gitignore'), 'deploy/jarvis.conf\nclave.env\n');
  await fs.writeFile(path.join(dir, 'a.txt'), 'base');
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.copyFile(RAMAS, path.join(dir, 'scripts', 'ramas.sh'));
  await fs.mkdir(path.join(dir, 'deploy'), { recursive: true });
  await fs.writeFile(path.join(dir, 'deploy', 'jarvis.conf'), 'ORIGINAL');
  await fs.writeFile(path.join(dir, 'clave.env'), 'SECRETO=1');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'inicial']);

  const correr = (args) => execFileAsync(
    'bash',
    [path.join(dir, 'scripts', 'ramas.sh'), ...args],
    { cwd: dir, env: { ...process.env } }
  )
    .then((r) => ({ salida: `${r.stdout}${r.stderr}`, code: 0 }))
    .catch((e) => ({ salida: `${e.stdout || ''}${e.stderr || ''}`, code: e.code ?? 1 }));

  const rama = async () => (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const ramas = async () => (await git(['branch', '--format=%(refname:short)'])).stdout;

  return { dir, git, correr, rama, ramas };
}

test('abrir crea la rama y guarda los no seguidos en el snapshot', async () => {
  const e = await entorno();
  const { salida, code } = await e.correr(['abrir', 'demo']);
  assert.equal(code, 0, salida);
  assert.match(salida, /tarea\/demo/);
  assert.equal(await e.rama(), 'tarea/demo');

  const raiz = path.join(e.dir, '.git', 'jarvis-ramas');
  const entradas = await fs.readdir(raiz);
  const snap = entradas.find((n) => n.includes('demo'));
  assert.ok(snap, 'debe haber un snapshot de la tarea');
  const copiados = await fs.readdir(path.join(raiz, snap, 'files', 'deploy'));
  assert.deepEqual(copiados, ['jarvis.conf']);
});

test('no deja abrir una segunda tarea encima de la primera', async () => {
  const e = await entorno();
  await e.correr(['abrir', 'demo']);
  const { code, salida } = await e.correr(['abrir', 'otra']);
  assert.notEqual(code, 0);
  assert.match(salida, /ya hay una tarea abierta/);
});

test('restaurar vuelve a main, borra la rama y devuelve la configuración', async () => {
  const e = await entorno();
  await e.correr(['abrir', 'demo']);
  await fs.writeFile(path.join(e.dir, 'deploy', 'jarvis.conf'), 'CAMBIADO');
  await fs.writeFile(path.join(e.dir, 'clave.env'), 'SECRETO=2');

  const { salida, code } = await e.correr(['restaurar']);
  assert.equal(code, 0, salida);
  assert.match(salida, /restaurada/i);
  assert.equal(await e.rama(), 'main');
  assert.equal(await fs.readFile(path.join(e.dir, 'deploy', 'jarvis.conf'), 'utf8'), 'ORIGINAL');
  assert.equal(await fs.readFile(path.join(e.dir, 'clave.env'), 'utf8'), 'SECRETO=1');
  assert.doesNotMatch(await e.ramas(), /tarea\/demo/);
});

test('cerrar fusiona en main y borra la rama', async () => {
  const e = await entorno();
  await e.correr(['abrir', 'demo']);
  await fs.writeFile(path.join(e.dir, 'b.txt'), 'nuevo');
  await e.git(['add', '-A']);
  await e.git(['commit', '-qm', 'cambio de la tarea']);

  const { salida, code } = await e.correr(['cerrar']);
  assert.equal(code, 0, salida);
  assert.match(salida, /fusionada/i);
  assert.equal(await e.rama(), 'main');
  assert.equal(await fs.readFile(path.join(e.dir, 'b.txt'), 'utf8'), 'nuevo');
  assert.doesNotMatch(await e.ramas(), /tarea\/demo/);
});

test('volver devuelve main al commit del snapshot y restaura la configuración', async () => {
  const e = await entorno();
  const base = (await e.git(['rev-parse', 'HEAD'])).stdout.trim();
  await e.correr(['abrir', 'demo']);
  await fs.writeFile(path.join(e.dir, 'c.txt'), 'se pierde al volver');
  await e.git(['add', '-A']);
  await e.git(['commit', '-qm', 'cambio']);
  await e.correr(['cerrar']);

  const { code, salida } = await e.correr(['volver', 'ultimos']);
  assert.equal(code, 0, salida);
  assert.match(salida, /main devuelta/i);
  assert.equal((await e.git(['rev-parse', 'HEAD'])).stdout.trim(), base);
  assert.equal(await fs.readFile(path.join(e.dir, 'deploy', 'jarvis.conf'), 'utf8'), 'ORIGINAL');
});
