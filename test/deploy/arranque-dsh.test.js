import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Pruebas del arranque del DSH web.
 * ------------------------------------------------------------------
 * Este arranque vivía suelto en el HOME y empezaba con
 * `killall -9 node socat python3`. Como `jarvis.service` corre con el mismo
 * usuario y su proceso es `node`, cada arranque mataba a Jarvis (SIGKILL).
 * Estas pruebas vigilan que el peligro no vuelva y que la configuración
 * (IP, versión, puertos) sea de verdad configurable.
 */

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(RAIZ, 'deploy', 'dsh-web', 'arrancar-dsh.sh');
const REDIRECT = path.join(RAIZ, 'deploy', 'dsh-web', 'redireccionar.py');
const INSTALADOR = path.join(RAIZ, 'deploy', 'instalar-dsh-web.sh');
const PLANTILLA = path.join(RAIZ, 'deploy', 'systemd', 'jarvis-dsh-web.service.in');

async function sinComentarios(fichero) {
  const texto = await fs.readFile(fichero, 'utf8');
  return texto
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
}

test('el script de arranque es bash válido y ya no usa killall', async () => {
  execFileSync('bash', ['-n', SCRIPT]);

  const codigo = await sinComentarios(SCRIPT);
  assert.doesNotMatch(
    codigo,
    /killall/,
    'ha vuelto `killall`: mataría también a jarvis.service (mismo usuario)'
  );
  assert.match(codigo, /pkill -9 -f/, 'la limpieza tiene que ser dirigida, con pkill -f');

  // La limpieza sólo debe apuntar a procesos de ESTE servicio.
  for (const patron of ['@deepseek-ai/dsh', 'dsh web --no-open', 'redireccionar.py']) {
    assert.match(codigo, new RegExp(patron.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `falta el patrón de limpieza: ${patron}`);
  }
});

test('la versión de dsh está FIJADA, no @latest', async () => {
  const codigo = await sinComentarios(SCRIPT);
  assert.doesNotMatch(codigo, /dsh@latest/, 'no se puede re-resolver/descargar en cada arranque');
  assert.match(codigo, /JARVIS_DSH_WEB_VERSION:-[0-9]/, 'debe haber una versión por defecto fijada');
});

test('comprobar resuelve la configuración del entorno', () => {
  const salida = execFileSync('bash', [SCRIPT, 'comprobar'], {
    env: {
      ...process.env,
      JARVIS_DSH_WEB_HOST: '10.9.8.7',
      JARVIS_DSH_WEB_VERSION: '1.2.3-rc.1',
      JARVIS_DSH_WEB_MAX_OLD_SPACE: '256',
      JARVIS_DSH_WEB_PORT: '4001',
      JARVIS_DSH_WEB_PROXY_PORT: '4002',
      JARVIS_DSH_WEB_PUBLIC_PORT: '4003'
    },
    encoding: 'utf8'
  });
  assert.match(salida, /host\s+: 10\.9\.8\.7/);
  assert.match(salida, /version\s+: 1\.2\.3-rc\.1/);
  assert.match(salida, /max_old_space : 256/);
  assert.match(salida, /puerto\s+: 4001/);
  assert.match(salida, /puerto_proxy\s+: 4002/);
  assert.match(salida, /puerto_publico: 4003/);
});

test('limpiar mata sólo lo de este servicio, nunca `node` a secas', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-dsh-'));
  const log = path.join(tmp, 'pkill.log');
  // Suplantamos pkill para ver EXACTAMENTE qué patrones se le pasan.
  const shim = path.join(tmp, 'pkill');
  await fs.writeFile(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`, 'utf8');
  await fs.chmod(shim, 0o755);

  execFileSync('bash', [SCRIPT, 'limpiar'], {
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, JARVIS_DSH_WEB_PROXY_PORT: '5555' },
    encoding: 'utf8'
  });

  const llamadas = (await fs.readFile(log, 'utf8')).trim().split('\n');
  assert.equal(llamadas.length, 4, 'deben ser exactamente los patrones de limpieza');
  for (const llamada of llamadas) {
    assert.match(llamada, /^-9 -f /, `pkill sin -9 -f: ${llamada}`);
    assert.doesNotMatch(llamada, /(^|\s)node(\s|$)/, `patrón demasiado ancho, mataría node: ${llamada}`);
  }
  assert.ok(llamadas.some((l) => l.includes('@deepseek-ai/dsh')));
  assert.ok(llamadas.some((l) => l.includes('socat TCP-LISTEN:5555')),
    'el patrón de socat debe usar el puerto configurado');
});

test('el redirector es Python válido y recibe el puerto', async () => {
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', REDIRECT]);
  const texto = await fs.readFile(REDIRECT, 'utf8');
  assert.match(texto, /sys\.argv\[3\]/, 'debe poder recibir el puerto público');
  assert.match(texto, /302/);
});

test('la unidad no tiene rutas fijas de usuario y el instalador resuelve todos sus marcadores', async () => {
  const plantilla = await fs.readFile(PLANTILLA, 'utf8');
  assert.doesNotMatch(plantilla, /\/home\//, 'la unidad no debe atar rutas de usuario');
  assert.doesNotMatch(
    await sinComentarios(PLANTILLA),
    /killall/,
    'la unidad no debe contener limpiezas a lo bruto'
  );
  assert.match(plantilla, /JARVIS_DSH_WEB_HOST/, 'la IP debe ser configuración, no una constante');

  const instalador = await fs.readFile(INSTALADOR, 'utf8');
  const resueltas = new Set();
  for (const m of instalador.matchAll(/-e "s\|@([A-Z_]+)@\|/g)) resueltas.add(m[1]);
  assert.ok(resueltas.size >= 8, 'no he podido leer las sustituciones del instalador');

  for (const marcador of new Set(plantilla.match(/@[A-Z_]+@/g) || [])) {
    const nombre = marcador.slice(1, -1);
    assert.ok(resueltas.has(nombre),
      `${marcador} quedaría sin sustituir: el instalador no lo resuelve`);
  }
});

test('el instalador es bash válido y sabe desinstalar', async () => {
  execFileSync('bash', ['-n', INSTALADOR]);
  const texto = await fs.readFile(INSTALADOR, 'utf8');
  assert.match(texto, /--quitar/);
  // No debe borrar la unidad antigua: `--quitar` tiene que poder restaurarla.
  assert.doesNotMatch(texto, /rm -f .*init_deep_deep_seek/);
});
