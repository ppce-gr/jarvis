import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba de arranque de la interfaz.
 * ------------------------------------------------------------------
 * Carga `public/app.js` con un DOM mínimo y comprueba que arranca sin errores
 * y que pinta las ideas.
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

  return { registro, errores };
}

const RESPUESTAS_BASE = {
  '/api/projects': {
    projects: [
      { id: 'idea-uno', name: 'idea-uno' },
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
  '/git/status': { git: { isRepository: true, dirty: false, files: [] } }
};

test('la interfaz arranca sin lanzar errores', async () => {
  const { errores } = await arrancarInterfaz({ respuestas: RESPUESTAS_BASE });
  assert.deepEqual(errores, [], `la interfaz lanzó: ${errores.join(' | ')}`);
});

test('las ideas se pintan en el panel', async () => {
  const { registro } = await arrancarInterfaz({ respuestas: RESPUESTAS_BASE });
  const lista = registro.get('#project-list');
  assert.ok(lista, 'debe existir el panel de ideas');
  assert.match(lista.innerHTML, /idea-uno/);
  assert.match(lista.innerHTML, /idea-dos/);
});

test('sin ideas avisa en vez de quedarse en blanco', async () => {
  const { registro, errores } = await arrancarInterfaz({
    respuestas: { ...RESPUESTAS_BASE, '/api/projects': { projects: [] } }
  });
  assert.deepEqual(errores, []);
  assert.match(registro.get('#project-list').innerHTML, /Sin ideas/);
});

test('una respuesta inesperada NO deja la pantalla muda', async () => {
  // El servidor devuelve algo sin `notes`: antes esto rompía el render.
  const { registro, errores } = await arrancarInterfaz({
    respuestas: { ...RESPUESTAS_BASE, '/conceptual': {} }
  });
  assert.deepEqual(errores, [], 'no debe propagarse una excepción sin capturar');
  // Lo importante: las ideas siguen viéndose.
  assert.match(registro.get('#project-list').innerHTML, /idea-uno/);
});

test('si el servidor no responde, el fallo se VE en pantalla', async () => {
  const { registro } = await arrancarInterfaz({
    respuestas: { '/api/projects': { error: 'caído' } }
  });
  const html = registro.get('#project-list').innerHTML;
  assert.match(html, /⚠️|Sin ideas/, 'debe quedar constancia visible del problema');
});
