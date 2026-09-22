import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/autoactualizar.sh', import.meta.url));
const SCRIPTS = path.dirname(SCRIPT);

// Estas pruebas reproducen las CUATRO relaciones posibles entre el repositorio
// local y el remoto usando repositorios git de verdad, en directorios
// temporales. Existen por una regresión concreta y grave: el script sólo
// contemplaba "detrás" y "divergido", así que en cuanto se commiteaba desde
// esta misma máquina —justo lo que hace la automodificación— lo tomaba por una
// divergencia y se negaba a actualizar para siempre. Como además abortaba ANTES
// del respaldo, aquellos commits no se subían nunca: bloqueo definitivo.

/** Monta un entorno hermético: repo de código, repo del cerebro y sus remotos. */
async function crearEntorno() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-ramas-'));
  const code = path.join(dir, 'codigo');
  const brain = path.join(dir, 'brain');

  const gitEn = (d) => (args, opciones = {}) => execFileAsync('git', args, { cwd: d, ...opciones });
  const prepararRepo = async (d, remoto, primerFichero) => {
    const git = gitEn(d);
    await fs.mkdir(d, { recursive: true });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Prueba']);
    await git(['config', 'user.email', 'prueba@test.local']);
    await fs.writeFile(path.join(d, primerFichero), 'contenido');
    await git(['add', '-A']);
    await git(['commit', '-qm', 'inicial']);
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
    await git(['remote', 'add', 'origin', remoto]);
    await git(['push', '-q', '-u', 'origin', 'main']);
    return git;
  };

  const git = await prepararRepo(code, path.join(dir, 'remoto.git'), 'a.txt');
  // El propio actualizador busca aquí su script de respaldo: se copia para que
  // el entorno se parezca al repositorio real.
  await fs.mkdir(path.join(code, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(SCRIPTS, 'backup.sh'), path.join(code, 'scripts', 'backup.sh'));
  await git(['add', '-A']);
  await git(['commit', '-qm', 'scripts']);
  await git(['push', '-q', 'origin', 'main']);

  await prepararRepo(brain, path.join(dir, 'brain-remoto.git'), 'n.md');

  return { dir, code, brain, git, gitEn };
}

/** Lanza el actualizador contra el entorno, sin tocar el servicio real. */
async function correr(entorno, args = []) {
  const opciones = {
    env: {
      ...process.env,
      JARVIS_CODE_DIR: entorno.code,
      JARVIS_BRAIN_DIR: entorno.brain,
      JARVIS_UPDATE_STATE: path.join(entorno.dir, 'state'),
      JARVIS_UPDATE_FLAG: path.join(entorno.dir, 'bandera'),
      // Un puerto muerto: así no se cree que hay un reinicio pendiente y el
      // script nunca intenta reiniciar nada durante las pruebas.
      JARVIS_STATUS_URL: 'http://127.0.0.1:9/noexiste'
    }
  };
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SCRIPT, ...args], opciones);
    return { salida: `${stdout}\n${stderr}`, code: 0 };
  } catch (error) {
    return { salida: `${error.stdout || ''}\n${error.stderr || ''}`, code: error.code ?? 1 };
  }
}

const commitLocal = async (entorno, nombre) => {
  await fs.writeFile(path.join(entorno.code, nombre), 'local');
  await entorno.git(['add', '-A']);
  await entorno.git(['commit', '-qm', nombre]);
};

/** Publica un commit desde "otra máquina", vía un clon del remoto. */
async function commitRemoto(entorno, nombre) {
  const clon = path.join(entorno.dir, 'clon');
  await execFileAsync('git', ['clone', '-q', path.join(entorno.dir, 'remoto.git'), clon]);
  const git = entorno.gitEn(clon);
  await git(['config', 'user.name', 'Otro']);
  await git(['config', 'user.email', 'otro@test.local']);
  await fs.writeFile(path.join(clon, nombre), 'remoto');
  await git(['add', '-A']);
  await git(['commit', '-qm', nombre]);
  await git(['push', '-q', 'origin', 'main']);
}

test('rama al día: el actualizador no hace nada', async (t) => {
  const entorno = await crearEntorno();
  t.after(() => fs.rm(entorno.dir, { recursive: true, force: true }));

  const { salida, code } = await correr(entorno, ['--check']);
  assert.match(salida, /Ya está al día/);
  assert.equal(code, 0);
});

test('rama por delante: NO es una divergencia y no bloquea', async (t) => {
  // Éste es el caso que dejó la automodificación bloqueada: un commit hecho en
  // la propia máquina y todavía sin subir.
  const entorno = await crearEntorno();
  t.after(() => fs.rm(entorno.dir, { recursive: true, force: true }));
  await commitLocal(entorno, 'local.txt');

  const { salida, code } = await correr(entorno, ['--check']);
  assert.match(salida, /Local va 1 commit\(s\) por delante/);
  assert.match(salida, /no es divergencia/);
  assert.doesNotMatch(salida, /divergido/);
  assert.equal(code, 0, 'ir por delante no puede bloquear la actualización');
});

test('rama detrás: detecta las novedades y las marca como aplicables', async (t) => {
  const entorno = await crearEntorno();
  t.after(() => fs.rm(entorno.dir, { recursive: true, force: true }));
  await commitRemoto(entorno, 'remoto.txt');

  const { salida, code } = await correr(entorno, ['--check']);
  assert.match(salida, /Hay novedades/);
  assert.equal(code, 0);
});

test('rama divergida de verdad: aborta sin tocar nada', async (t) => {
  const entorno = await crearEntorno();
  t.after(() => fs.rm(entorno.dir, { recursive: true, force: true }));
  await commitLocal(entorno, 'local.txt');
  await commitRemoto(entorno, 'remoto.txt');

  const { salida, code } = await correr(entorno, ['--check']);
  assert.match(salida, /divergido DE VERDAD/);
  assert.equal(code, 1, 'una divergencia real sí debe abortar');
});

test('rama por delante en modo real: respalda los commits locales', async (t) => {
  // Sin systemd no se puede ejercitar el camino completo (el script exige poder
  // reiniciar el servicio), así que en ese caso se omite en vez de fallar.
  try {
    await execFileAsync('systemctl', ['list-unit-files', 'jarvis.service']);
  } catch {
    t.skip('sin systemd/jarvis.service: no se puede probar el camino completo');
    return;
  }

  const entorno = await crearEntorno();
  t.after(() => fs.rm(entorno.dir, { recursive: true, force: true }));
  await commitLocal(entorno, 'local.txt');

  const revList = (repo, rango) =>
    execFileAsync('git', ['rev-list', '--count', rango], { cwd: repo }).then((r) => r.stdout.trim());
  const antes = await revList(path.join(entorno.dir, 'remoto.git'), 'main');

  // Sin argumentos: el modo por defecto es "actualizar".
  const { salida, code } = await correr(entorno);

  const despues = await revList(path.join(entorno.dir, 'remoto.git'), 'main');
  assert.match(salida, /Commits locales respaldados/);
  assert.ok(
    Number(despues) > Number(antes),
    `el remoto debía recibir el commit (${antes} → ${despues})`
  );
  assert.equal(await revList(entorno.code, 'origin/main..HEAD'), '0', 'no debe quedar nada sin subir');
  assert.equal(code, 0);
});
