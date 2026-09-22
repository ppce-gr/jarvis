import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { LocalSystemUpdateAdapter } from '../../src/infrastructure/system/LocalSystemUpdateAdapter.js';

const execFileAsync = promisify(execFile);

/** Crea un repositorio git de verdad, porque el adaptador habla con git real. */
async function repoDePrueba() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-sys-'));
  const code = path.join(dir, 'codigo');
  await fs.mkdir(code, { recursive: true });
  const git = (args) => execFileAsync('git', args, { cwd: code });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@test.local']);
  await fs.writeFile(path.join(code, 'README.md'), 'hola');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'inicial']);

  const adapter = new LocalSystemUpdateAdapter({
    codeDir: code,
    stateDir: path.join(dir, '.update-state'),
    flagFile: path.join(dir, '.update-request'),
    branch: 'main',
    // Ruta propia de la prueba: así no se compara con el actualizador real de la
    // máquina, que no tiene nada que ver con estos repositorios temporales.
    updaterFile: path.join(dir, 'jarvis-actualizar')
  });
  return { dir, code, git, adapter };
}

test('getStatus informa de la versión y de que el árbol está limpio', async () => {
  const { adapter } = await repoDePrueba();
  const estado = await adapter.getStatus();

  assert.match(estado.commit, /^[0-9a-f]{40}$/);
  assert.equal(estado.commitCorto, estado.commit.slice(0, 7));
  assert.equal(estado.branch, 'main');
  assert.equal(estado.dirty, false);
  assert.equal(estado.canUpdate, true);
  assert.equal(estado.updateRequested, false);
  assert.equal(estado.lastGood, null);
});

test('getStatus detecta cambios sin commitear y bloquea la actualización', async () => {
  const { adapter, code } = await repoDePrueba();
  await fs.writeFile(path.join(code, 'nuevo.txt'), 'sin commitear');

  const estado = await adapter.getStatus();
  assert.equal(estado.dirty, true);
  assert.equal(estado.canUpdate, false, 'con el árbol sucio no se puede actualizar');
});

test('requestUpdate deja la bandera que vigila systemd', async () => {
  const { adapter } = await repoDePrueba();
  const res = await adapter.requestUpdate();

  assert.equal(res.requested, true);
  const contenido = JSON.parse(await fs.readFile(adapter.flagFile, 'utf8'));
  assert.ok(contenido.requestedAt, 'la bandera lleva marca de tiempo');

  const estado = await adapter.getStatus();
  assert.equal(estado.updateRequested, true);
});

test('requestUpdate se niega con el árbol sucio', async () => {
  const { adapter, code } = await repoDePrueba();
  await fs.writeFile(path.join(code, 'nuevo.txt'), 'sin commitear');

  await assert.rejects(() => adapter.requestUpdate(), /WORKING_TREE_DIRTY/);
  // Y no debe haber dejado bandera: el actualizador no llegará a arrancar.
  await assert.rejects(() => fs.access(adapter.flagFile));
});

test('getStatus lee el ancla de reversión y el registro del actualizador', async () => {
  const { adapter } = await repoDePrueba();
  const head = (await adapter.getStatus()).commit;

  await fs.mkdir(adapter.stateDir, { recursive: true });
  await fs.writeFile(path.join(adapter.stateDir, 'last-good'), `${head}\n`);
  await fs.writeFile(path.join(adapter.stateDir, 'autoactualizacion.log'), 'linea1\nlinea2\n');

  const estado = await adapter.getStatus();
  assert.equal(estado.lastGood, head);
  assert.equal(estado.lastGoodCorto, head.slice(0, 7));
  assert.match(estado.lastRun, /linea2/);
});

test('checkForUpdates avisa cuando no hay remoto en vez de romper', async () => {
  const { adapter } = await repoDePrueba();
  const res = await adapter.checkForUpdates();

  assert.ok(res.error, 'sin remoto debe informar del problema');
  assert.match(res.error, /remoto/);
});

test('checkForUpdates detecta novedades y si son fast-forward', async () => {
  const { adapter, code, git } = await repoDePrueba();

  // Un remoto de verdad: otro repositorio desnudo al que empujar.
  const remoto = path.join(path.dirname(code), 'remoto.git');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
  await git(['remote', 'add', 'origin', remoto]);
  await git(['push', '-q', '-u', 'origin', 'main']);

  // Al día: no hay novedades.
  let res = await adapter.checkForUpdates();
  assert.equal(res.relacion, 'igual');
  assert.equal(res.hayNovedades, false, 'recién empujado, no hay novedades');

  // Se añade un commit en el remoto (simulando que otro lo publica).
  const otro = path.join(path.dirname(code), 'otro');
  await execFileAsync('git', ['clone', '-q', remoto, otro]);
  await execFileAsync('git', ['config', 'user.name', 'Otro'], { cwd: otro });
  await execFileAsync('git', ['config', 'user.email', 'otro@test.local'], { cwd: otro });
  await fs.writeFile(path.join(otro, 'nuevo.md'), 'contenido');
  await execFileAsync('git', ['add', '-A'], { cwd: otro });
  await execFileAsync('git', ['commit', '-qm', 'novedad'], { cwd: otro });
  await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: otro });

  res = await adapter.checkForUpdates();
  assert.equal(res.hayNovedades, true);
  assert.equal(res.relacion, 'detras');
  assert.equal(res.fastForward, true, 'un commit por delante es fast-forward limpio');
  assert.equal(res.aviso, null);
});

test('checkForUpdates avisa si las ramas han divergido', async () => {
  const { adapter, code, git } = await repoDePrueba();

  const remoto = path.join(path.dirname(code), 'remoto.git');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
  await git(['remote', 'add', 'origin', remoto]);
  await git(['push', '-q', '-u', 'origin', 'main']);

  // Commit local Y commit remoto: divergen.
  await fs.writeFile(path.join(code, 'local.txt'), 'local');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'local']);

  const otro = path.join(path.dirname(code), 'otro');
  await execFileAsync('git', ['clone', '-q', remoto, otro]);
  await execFileAsync('git', ['config', 'user.name', 'Otro'], { cwd: otro });
  await execFileAsync('git', ['config', 'user.email', 'otro@test.local'], { cwd: otro });
  await fs.writeFile(path.join(otro, 'remoto.txt'), 'remoto');
  await execFileAsync('git', ['add', '-A'], { cwd: otro });
  await execFileAsync('git', ['commit', '-qm', 'remoto'], { cwd: otro });
  await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: otro });

  const res = await adapter.checkForUpdates();
  assert.equal(res.hayNovedades, true);
  assert.equal(res.fastForward, false);
  assert.match(res.aviso, /divergido/);
  assert.equal(res.relacion, 'divergido');
  assert.equal(res.pendienteDeSubir, 1);
});

test('checkForUpdates NO avisa de divergencia cuando lo local va por delante', async () => {
  // Éste es exactamente el caso que bloqueó la automodificación: un commit
  // hecho en la propia máquina. NO es una divergencia —aquí está todo lo del
  // remoto—, así que no debe haber aviso y el actualizador debe poder seguir
  // para respaldarlo.
  const { adapter, code, git } = await repoDePrueba();

  const remoto = path.join(path.dirname(code), 'remoto.git');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
  await git(['remote', 'add', 'origin', remoto]);
  await git(['push', '-q', '-u', 'origin', 'main']);

  await fs.writeFile(path.join(code, 'local.txt'), 'local');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'commit local sin subir']);

  const res = await adapter.checkForUpdates();
  assert.equal(res.relacion, 'delante');
  assert.equal(res.aviso, null, 'ir por delante NO es divergir');
  assert.equal(res.fastForward, false, 'no hay nada que traerse del remoto');
  assert.equal(res.hayNovedades, false, 'el remoto no trae nada nuevo');
  assert.equal(res.pendienteDeSubir, 1, 'hay un commit local sin subir');
});

test('getStatus avisa si la copia instalada del actualizador está desfasada', async () => {
  // El actualizador no se actualiza solo: systemd ejecuta una copia de root, así
  // que si nadie compara las dos versiones, la instalada se queda vieja —con sus
  // bugs— en silencio. Eso fue justo lo que bloqueó la automodificación.
  const { code, adapter } = await repoDePrueba();

  await fs.mkdir(path.join(code, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(code, 'scripts', 'autoactualizar.sh'), 'versión nueva\n');
  await fs.writeFile(adapter.updaterFile, 'versión vieja\n');

  let estado = await adapter.getStatus();
  assert.equal(estado.actualizadorComprobado, true);
  assert.equal(estado.actualizadorDesfasado, true, 'debe avisar del desfase');

  // Si coinciden, no hay nada que avisar.
  await fs.writeFile(adapter.updaterFile, 'versión nueva\n');
  estado = await adapter.getStatus();
  assert.equal(estado.actualizadorComprobado, true);
  assert.equal(estado.actualizadorDesfasado, false);

  // Y si no se puede comparar, no se inventa un aviso.
  await fs.rm(adapter.updaterFile);
  estado = await adapter.getStatus();
  assert.equal(estado.actualizadorComprobado, false);
  assert.equal(estado.actualizadorDesfasado, false, 'no se avisa de lo que no se ha podido comprobar');
});

test('requestUpdate retira una bandera vieja antes de escribir la nueva', async () => {
  const { adapter } = await repoDePrueba();

  // Resto de un intento anterior: si no se quitara, el .path de systemd no
  // volvería a disparar y la petición no haría nada.
  await fs.mkdir(path.dirname(adapter.flagFile), { recursive: true });
  await fs.writeFile(adapter.flagFile, '{"requestedAt":"vieja"}');

  await adapter.requestUpdate();
  const contenido = JSON.parse(await fs.readFile(adapter.flagFile, 'utf8'));
  assert.notEqual(contenido.requestedAt, 'vieja', 'debe ser la petición nueva');
});
