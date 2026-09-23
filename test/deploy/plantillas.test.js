import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const SYSTEMD = path.join(RAIZ, 'deploy', 'systemd');
const INSTALAR = path.join(RAIZ, 'deploy', 'instalar.sh');

// Las unidades de systemd NO pueden leer un .env: `User=`, `WorkingDirectory=` y
// `PathExists=` no expanden variables. Por eso son plantillas que `instalar.sh`
// rellena al instalar. Estas pruebas vigilan las dos formas de romperlo:
//   · que un marcador se quede sin sustituir (la unidad quedaría con @ALGO@);
//   · que alguien vuelva a meter una ruta fija dentro de una plantilla.

const UNIDADES = [
  'jarvis.service',
  'jarvis-backup.service',
  'jarvis-backup.timer',
  'jarvis-autoupdate.service',
  'jarvis-autoupdate.path',
  'jarvis-autoupdate.timer'
];

/** Variables que instalar.sh sabe resolver: las de sus bucles `for var in`. */
async function variablesResueltas() {
  const guion = await fs.readFile(INSTALAR, 'utf8');
  const resueltas = new Set();
  for (const coincidencia of guion.matchAll(/for var in([\s\S]*?); do/g)) {
    for (const nombre of coincidencia[1].trim().split(/\s+/)) {
      if (nombre) resueltas.add(nombre);
    }
  }
  return resueltas;
}

test('existen las seis plantillas y ya no quedan unidades sin plantilla', async () => {
  const ficheros = await fs.readdir(SYSTEMD);

  for (const unidad of UNIDADES) {
    assert.ok(ficheros.includes(`${unidad}.in`), `falta la plantilla ${unidad}.in`);
    assert.ok(
      !ficheros.includes(unidad),
      `${unidad} sigue ahí sin ser plantilla: instalar.sh ya no la copia, así que se quedaría obsoleta`
    );
  }
});

test('cada marcador de las plantillas lo sabe resolver instalar.sh', async () => {
  const resueltas = await variablesResueltas();
  assert.ok(resueltas.size > 10, 'no he podido leer la lista de variables de instalar.sh');

  for (const unidad of UNIDADES) {
    const texto = await fs.readFile(path.join(SYSTEMD, `${unidad}.in`), 'utf8');
    const marcadores = [...new Set(texto.match(/@[A-Z_]+@/g) || [])];
    for (const marcador of marcadores) {
      const nombre = marcador.slice(1, -1);
      assert.ok(
        resueltas.has(nombre),
        `${unidad}.in usa ${marcador}, que instalar.sh no resuelve: la unidad se instalaría con el marcador dentro`
      );
    }
  }
});

test('ninguna plantilla trae rutas fijas dentro', async () => {
  for (const unidad of UNIDADES) {
    const texto = await fs.readFile(path.join(SYSTEMD, `${unidad}.in`), 'utf8');
    assert.doesNotMatch(texto, /\/home\//, `${unidad}.in no debe llevar rutas de usuario fijas`);
    // Se comprueba el directorio de instalación, no todo /usr/local: un
    // `Environment=PATH=/usr/local/bin:...` es legítimo y no ata nada.
    assert.doesNotMatch(
      texto,
      /\/usr\/local\/sbin/,
      `${unidad}.in debe usar @JARVIS_SBIN_DIR@ en vez de /usr/local/sbin`
    );
  }
});

test('renderizadas con valores de prueba no queda ningún marcador', async () => {
  const resueltas = await variablesResueltas();
  const valores = {};
  for (const nombre of resueltas) valores[nombre] = `PRUEBA_${nombre}`;

  for (const unidad of UNIDADES) {
    const texto = await fs.readFile(path.join(SYSTEMD, `${unidad}.in`), 'utf8');
    const renderizado = texto.replace(/@([A-Z_]+)@/g, (entero, nombre) => valores[nombre] ?? entero);
    assert.doesNotMatch(
      renderizado,
      /@JARVIS_/,
      `tras renderizar ${unidad}.in queda algún marcador sin sustituir`
    );
    // Y ninguna unidad puede acabar apuntando a una ruta inventada.
    assert.doesNotMatch(renderizado, /@[A-Z_]+@/, `${unidad} quedó con marcadores dentro`);
  }
});

test('los scripts del despliegue ya no llevan rutas fijas como valor por defecto', async () => {
  const scripts = [
    'scripts/autoactualizar.sh',
    'deploy/mantenimiento.sh',
    'deploy/reinstalar-actualizador.sh'
  ];
  for (const relativo of scripts) {
    const texto = await fs.readFile(path.join(RAIZ, relativo), 'utf8');
    const codigo = texto
      .split('\n')
      .filter((linea) => !linea.trimStart().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(
      codigo,
      /\/home\/[a-z]+\//,
      `${relativo} tiene una ruta de usuario fija: debe deducirla o leerla de /etc/jarvis/jarvis.conf`
    );
  }
});

test('el asistente deduce la disposición por defecto del repositorio', async () => {
  // configurar.sh debe proponer, sin preguntar nada, la memoria y el estado como
  // hermanos del repositorio: es lo que hace que un clon funcione sin config.
  const texto = await fs.readFile(path.join(RAIZ, 'deploy', 'configurar.sh'), 'utf8');
  assert.match(texto, /DEF_BRAIN="\$BASE\/jarvis-vault"/);
  assert.match(texto, /DEF_ESTADO="\$BASE\/\.update-state"/);
  assert.match(texto, /DEF_BANDERA="\$BASE\/\.update-request"/);
});
