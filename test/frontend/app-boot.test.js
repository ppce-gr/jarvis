import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba de arranque de la interfaz.
 * ------------------------------------------------------------------
 * Carga `public/app.js` con un DOM mínimo y comprueba que arranca sin errores,
 * que el inicio pinta las ideas como tarjetas y que se puede abrir una idea y
 * volver al inicio.
 *
 * POR QUÉ EXISTE: el peor fallo posible de esta interfaz no es que algo se vea
 * mal, sino que una excepción en el arranque deje la pantalla MUDA —sin ideas,
 * sin mensaje y sin pista—. Ocurrió de verdad: `bindEvents()` llamaba a una
 * función que no existía y la aplicación entera dejaba de pintar. Desde fuera
 * parecía que Jarvis no tenía ideas.
 *
 * No hay navegador aquí, pero sí lo suficiente para detectar referencias rotas
 * y respuestas inesperadas.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '..', '..', 'public', 'app.js');
const INDEX = path.resolve(__dirname, '..', '..', 'public', 'index.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Monta un DOM de mentira y ejecuta el frontend. Devuelve lo que se pintó. */
async function arrancarInterfaz({ respuestas = {} } = {}) {
  const registro = new Map();
  const errores = [];

  const fakeEl = (id = '') => ({
    id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    _hijos: [], disabled: false, placeholder: '', scrollHeight: 0, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    appendChild(c) {
      this._hijos.push(c);
      this.innerHTML += (c.innerHTML || c.textContent || '');
    },
    remove() {}, closest() { return null; }, querySelectorAll() { return []; },
    showModal() {}, close() {}, setAttribute() {}, focus() {}
  });

  global.document = {
    querySelector(sel) {
      if (!registro.has(sel)) registro.set(sel, fakeEl(sel));
      return registro.get(sel);
    },
    querySelectorAll() { return []; },
    getElementById(id) { return this.querySelector('#' + id); },
    createElement(tag) { const e = fakeEl(); e.tagName = tag; return e; },
    addEventListener() {},
    hidden: false,
    body: fakeEl('body')
  };
  global.window = {
    matchMedia: () => ({ matches: false }),
    location: { href: '' },
    addEventListener() {}
  };
  global.EventSource = class { constructor() {} close() {} };
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  global.fetch = async (url) => {
    for (const [clave, valor] of Object.entries(respuestas)) {
      if (url.includes(clave)) return { ok: true, json: async () => valor };
    }
    return { ok: true, json: async () => ({}) };
  };

  process.on('uncaughtException', (e) => errores.push(e.message));

  const src = fs.readFileSync(APP_JS, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  await new Promise((r) => setTimeout(r, 250));

  return { registro, errores, jarvis: global.window.Jarvis };
}

/** Abre una idea y deja que se asienten los fetch encadenados. */
async function abrirIdea(jarvis, id = 'idea-uno') {
  await jarvis.selectProject(id);
  await sleep(80);
}

const RESPUESTAS_BASE = {
  '/api/projects': {
    projects: [
      { id: 'idea-uno', name: 'idea-uno', description: 'La primera idea' },
      { id: 'idea-dos', name: 'idea-dos' }
    ]
  },
  '/conceptual': {
    notes: [{ id: '_indice', title: 'Indice', frontmatter: {}, content: 'hola' }]
  },
  '/chat/stream': {},
  '/chat': { messages: [], status: { status: 'idle' } },
  '/files': { files: [] },
  '/tasks': { tasks: [] },
  '/system/status': {
    commitCorto: 'abc1234', runningCommitCorto: 'abc1234',
    branch: 'main', dirty: false, lastGoodCorto: null
  },
  '/models/health': { checking: false, checkedAt: null, results: {} },
  '/git/status': { git: { isRepository: true, dirty: false, files: [] } }
};

test('la interfaz arranca sin lanzar errores', async () => {
  const { errores } = await arrancarInterfaz({ respuestas: RESPUESTAS_BASE });
  assert.deepEqual(errores, [], `la interfaz lanzó: ${errores.join(' | ')}`);
});

test('el inicio pinta las ideas como tarjetas', async () => {
  const { registro, errores } = await arrancarInterfaz({ respuestas: RESPUESTAS_BASE });
  assert.deepEqual(errores, []);
  const grid = registro.get('#idea-grid');
  assert.ok(grid, 'debe existir la rejilla de ideas');
  assert.match(grid.innerHTML, /idea-uno/);
  assert.match(grid.innerHTML, /idea-dos/);
  // Cada tarjeta lleva su estructura propia, no una lista de árbol.
  assert.match(grid.innerHTML, /idea-card-title/);
  assert.match(grid.innerHTML, /idea-card-mark/);
});

test('sin ideas avisa y ofrece crear la primera', async () => {
  const { registro, errores } = await arrancarInterfaz({
    respuestas: { ...RESPUESTAS_BASE, '/api/projects': { projects: [] } }
  });
  assert.deepEqual(errores, []);
  assert.match(registro.get('#home-empty').innerHTML, /Sin ideas/);
  // Aun sin ideas, el acceso a crear sigue a la vista (tarjeta "Nueva idea").
  assert.match(registro.get('#idea-grid').innerHTML, /Nueva idea/);
});

test('una respuesta inesperada NO deja la pantalla muda', async () => {
  // El servidor devuelve algo sin `notes`: antes esto rompía el render.
  const { registro, errores } = await arrancarInterfaz({
    respuestas: { ...RESPUESTAS_BASE, '/conceptual': {} }
  });
  assert.deepEqual(errores, [], 'no debe propagarse una excepción sin capturar');
  // Lo importante: las ideas siguen viéndose en el inicio.
  assert.match(registro.get('#idea-grid').innerHTML, /idea-uno/);
});

test('si no hay proyectos, el inicio avisa en vez de quedar en blanco', async () => {
  const { registro } = await arrancarInterfaz({
    respuestas: { '/api/projects': { error: 'caído' } }
  });
  const html = registro.get('#home-empty').innerHTML;
  assert.match(html, /Sin ideas/, 'debe quedar constancia visible del problema');
});

test('la interfaz declara inicio, idea y el botón de volver', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  assert.match(html, /id="view-home"/, 'debe existir la vista de inicio');
  assert.match(html, /id="view-idea"/, 'debe existir la vista de idea');
  assert.match(html, /id="back-btn"/, 'debe existir el botón de volver al inicio');
  assert.match(html, /id="new-idea-btn"/, 'debe existir el botón de nueva idea en el inicio');
  assert.match(html, /id="idea-grid"/, 'debe existir la rejilla de tarjetas');
});

test('abrir una idea muestra su título y entra en la vista de idea', async () => {
  const { registro, errores, jarvis } = await arrancarInterfaz({ respuestas: RESPUESTAS_BASE });
  assert.deepEqual(errores, []);
  await abrirIdea(jarvis, 'idea-uno');
  assert.equal(jarvis.state.view, 'idea');
  assert.equal(registro.get('#idea-title').textContent, 'idea-uno');
});

test('volver al inicio recupera las tarjetas y suelta la idea', async () => {
  const { registro, errores, jarvis } = await arrancarInterfaz({ respuestas: RESPUESTAS_BASE });
  assert.deepEqual(errores, []);
  await abrirIdea(jarvis, 'idea-uno');
  assert.equal(jarvis.state.view, 'idea');
  await jarvis.goHome();
  assert.equal(jarvis.state.view, 'home');
  assert.equal(jarvis.state.currentProjectId, null);
  assert.match(registro.get('#idea-grid').innerHTML, /idea-uno/);
});

/* ================================================================
   Selector de modelos: disponibles arriba, no disponibles abajo
   ================================================================ */

const CONFIG_MODELOS = {
  current: { model: '["p","bueno"]', supportsEffort: true },
  options: [
    {
      id: 'model',
      category: 'model',
      options: [
        {
          group: 'p',
          name: 'Proveedor P',
          options: [
            { value: '["p","bueno"]', name: 'Bueno', health: { status: 'ok' } },
            { value: '["p","sin-cuota"]', name: 'Sin cuota', health: { status: 'quota' } },
            {
              value: '["p","roto"]',
              name: 'Roto',
              health: { status: 'broken', error: 'model not found' }
            },
            { value: '["p","sin-confirmar"]', name: 'Sin confirmar', health: { status: 'unknown' } }
          ]
        }
      ]
    }
  ],
  health: { checking: false, results: {} }
};

async function arrancarConModelos() {
  // `/chat/config` va primero para que el fetch falso lo prefiera sobre `/api/projects`.
  const { registro, errores, jarvis } = await arrancarInterfaz({
    respuestas: { '/chat/config': CONFIG_MODELOS, ...RESPUESTAS_BASE }
  });
  await abrirIdea(jarvis, 'idea-uno');
  return { registro, errores };
}

test('el selector separa los disponibles de los que no funcionan', async () => {
  const { registro, errores } = await arrancarConModelos();
  assert.deepEqual(errores, [], `la interfaz lanzó: ${errores.join(' | ')}`);

  const menu = registro.get('#chat-model-menu');
  assert.ok(menu, 'debe existir el menú de modelos');
  const html = menu.innerHTML;
  const iDisponibles = html.indexOf('Disponibles');
  const iNoFuncionan = html.indexOf('No funcionan');
  assert.ok(iDisponibles >= 0 && iNoFuncionan > iDisponibles,
    'primero los disponibles y debajo los que no funcionan');

  const arriba = html.slice(0, iNoFuncionan);
  const abajo = html.slice(iNoFuncionan);
  assert.match(arriba, /Bueno/);
  assert.match(arriba, /Sin cuota/);
  assert.doesNotMatch(arriba, /Roto/);
  // Los "sin confirmar" cuentan como no disponibles: van abajo.
  assert.doesNotMatch(arriba, /Sin confirmar/);
  assert.match(abajo, /Roto/);
  assert.match(abajo, /Sin confirmar/);
});

test('cada modelo lleva su icono de estado y su botón de refrescar', async () => {
  const { registro } = await arrancarConModelos();
  const html = registro.get('#chat-model-menu').innerHTML;
  const iNoFuncionan = html.indexOf('No funcionan');
  const arriba = html.slice(0, iNoFuncionan);
  const abajo = html.slice(iNoFuncionan);

  assert.match(arriba, /🟢/);
  assert.match(arriba, /🟡/);
  assert.match(abajo, /🔴/);
  assert.match(abajo, /⚪/);

  // Un botón de refresco por modelo, no uno global.
  assert.equal((html.match(/data-refresh=/g) || []).length, 4);
  assert.match(html, /class="model-refresh"/);
});

test('el botón del desplegable muestra el modelo elegido con su icono', async () => {
  const { registro } = await arrancarConModelos();
  assert.match(registro.get('#chat-model-label').textContent, /🟢 Bueno/);
});

/*
 * La pista del ratón debe dar el NOMBRE COMPLETO y el estado. En pantalla el
 * nombre puede quedar recortado con puntos suspensivos (la fila es una rejilla
 * con ancho máximo), así que el `title` es el único sitio donde se lee entero.
 */
test('la pista de cada modelo da el nombre completo y el estado', async () => {
  const { registro } = await arrancarConModelos();
  const html = registro.get('#chat-model-menu').innerHTML;
  assert.match(html, /title="Bueno - Se puede usar"/, 'disponible: nombre y estado');
  assert.match(
    html,
    /title="Sin cuota - Sin cuota: podrá usarse cuando se restablezca"/,
    'sin cuota: nombre y explicación'
  );
  assert.match(html, /title="Roto - model not found"/, 'roto: nombre y error');
  assert.match(html, /title="Sin confirmar - Sin comprobar"/, 'sin confirmar: nombre y estado');
});

test('el botón cerrado del selector da nombre y estado del modelo actual', async () => {
  const { registro } = await arrancarConModelos();
  assert.equal(registro.get('#chat-model-btn').title, 'Bueno - Se puede usar');
});

/* ================================================================
   Traza de actividad: herramientas y razonamiento plegables
   ================================================================ */

test('la traza se pinta como líneas plegables y guarda el detalle', async () => {
  // `/chat` debe ir primero (para ganar a `/api/projects`) y con el historial.
  const base = { ...RESPUESTAS_BASE };
  delete base['/chat'];
  const { registro, errores, jarvis } = await arrancarInterfaz({
    respuestas: {
      '/chat': {
        messages: [
          { role: 'user', text: 'hola' },
          {
            role: 'tool',
            id: 't1',
            text: 'read_file · nota.md',
            status: 'completed',
            detail: 'Entrada:\nnota.md\n\nSalida:\ncontenido'
          },
          { role: 'thought', id: 'r1', text: 'Razonamiento', detail: 'pensando…' },
          { role: 'assistant', text: 'listo' }
        ],
        status: { status: 'idle' }
      },
      ...base
    }
  });
  await abrirIdea(jarvis, 'idea-uno');
  assert.deepEqual(errores, [], `la interfaz lanzó: ${errores.join(' | ')}`);

  const html = registro.get('#chat-messages').innerHTML;
  assert.match(html, /data-activity-id="t1"/);
  assert.match(html, /data-activity-id="r1"/);
  assert.match(html, /<details/);
  assert.match(html, /read_file/);
  assert.match(html, /Razonamiento/);
  assert.match(html, /Entrada:/);
  // Todo nace plegado.
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});
