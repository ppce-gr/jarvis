import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BACKUP = fileURLToPath(new URL('../../scripts/backup.sh', import.meta.url));

// Política de commits del respaldo automático:
//   · la MEMORIA (privada) se autosalva siempre: son notas irremplazables y da
//     igual que la historia tenga ruido;
//   · el CÓDIGO (público) sólo se sube, no se commitea solo. Su historia la lee
//     gente, y un "autosave" cada media hora con el trabajo a medias de un
//     agente la ensucia y puede dejar main sin pasar las pruebas.
// Estas pruebas fijan esa política, que antes no existía.

/** Monta copia + memoria, cada una con su remoto, y devuelve el entorno. */
async function entorno() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-backup-'));
  const code = path.join(dir, 'codigo');
  const brain = path.join(dir, 'brain');

  const preparar = async (d, nombreRemoto, fichero) => {
    await fs.mkdir(d, { recursive: true });
    const git = (args) => execFileAsync('git', args, { cwd: d });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Prueba']);
    await git(['config', 'user.email', 'prueba@test.local']);
    await fs.writeFile(path.join(d, fichero), 'contenido');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'inicial']);
    const remoto = path.join(dir, nombreRemoto);
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
    await git(['remote', 'add', 'origin', remoto]);
    await git(['push', '-q', '-u', 'origin', 'main']);
    return git;
  };

  const git = await preparar(code, 'remoto-codigo.git', 'a.txt');
  // El script se copia dentro del repositorio temporal porque deduce CODE_DIR de
  // su propia ubicación: así la prueba no toca el repositorio de verdad.
  await fs.mkdir(path.join(code, 'scripts'), { recursive: true });
  await fs.copyFile(BACKUP, path.join(code, 'scripts', 'backup.sh'));
  await git(['add', '-A']);
  await git(['commit', '-qm', 'scripts']);
  await git(['push', '-q', 'origin', 'main']);

  await preparar(brain, 'remoto-brain.git', 'n.md');

  const correr = (env = {}) =>
    execFileAsync('bash', [path.join(code, 'scripts', 'backup.sh')], {
      env: { ...process.env, JARVIS_BRAIN_DIR: brain, ...env }
    })
      .then((r) => ({ salida: `${r.stdout}${r.stderr}`, code: 0 }))
      .catch((e) => ({ salida: `${e.stdout || ''}${e.stderr || ''}`, code: e.code ?? 1 }));

  const commits = async (d = code) =>
    Number((await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: d })).stdout.trim());

  return { dir, code, brain, git, correr, commits };
}

test('con el árbol limpio no crea ningún commit', async (t) => {
  const e = await entorno();
  t.after(() => fs.rm(e.dir, { recursive: true, force: true }));

  const antes = await e.commits();
  const { salida } = await e.correr();
  assert.match(salida, /sin cambios en el árbol de trabajo/);
  assert.equal(await e.commits(), antes, 'no debe aparecer un commit de la nada');
});

test('el código sin commitear NO se autosalva, y se avisa', async (t) => {
  const e = await entorno();
  t.after(() => fs.rm(e.dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(e.code, 'a-medias.js'), 'trabajo en curso');
  const antes = await e.commits();

  const { salida } = await e.correr();
  assert.match(salida, /sin commitear que NO se respaldan/);
  assert.equal(await e.commits(), antes, 'el trabajo a medias no debe llegar a main');
});

test('la memoria SÍ se autosalva siempre', async (t) => {
  const e = await entorno();
  t.after(() => fs.rm(e.dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(e.brain, 'nota-nueva.md'), 'una idea');
  const antes = await e.commits(e.brain);

  const { salida } = await e.correr();
  assert.match(salida, /memoria \(privada\)/);
  assert.ok(await e.commits(e.brain) > antes, 'las notas irremplazables sí se guardan');
});

test('con JARVIS_BACKUP_COMMIT_CODE=1 el código también se autosalva', async (t) => {
  const e = await entorno();
  t.after(() => fs.rm(e.dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(e.code, 'a-medidas.js'), 'trabajo en curso');
  const antes = await e.commits();

  const { salida } = await e.correr({ JARVIS_BACKUP_COMMIT_CODE: '1' });
  assert.match(salida, /commit [0-9a-f]{7}/);
  assert.ok(await e.commits() > antes, 'forzado a mano sí debe commitear');
});

test('sube los commits pendientes aunque no haya cambios que commitear', async (t) => {
  const e = await entorno();
  t.after(() => fs.rm(e.dir, { recursive: true, force: true }));

  // Un commit local sin subir: el respaldo debe empujarlo.
  await fs.writeFile(path.join(e.code, 'b.txt'), 'nuevo');
  await e.git(['add', '-A']);
  await e.git(['commit', '-qm', 'local sin subir']);
  const pendientes = async () =>
    (await execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: e.code })).stdout.trim();
  assert.notEqual(await pendientes(), '0');

  const { salida } = await e.correr();
  assert.match(salida, /subido a origin\/main/);
  assert.equal(await pendientes(), '0', 'no debe quedarse nada sin subir');
});
