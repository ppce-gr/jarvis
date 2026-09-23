import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba de las dudas del agente en un apartado propio.
 * ------------------------------------------------------------------
 * Separa las preguntas que hace el usuario (`preguntas.md`) de las dudas que
 * tiene el agente (`dudas.md`), que el usuario responde una a una.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');
const APP = path.join(PUBLIC_DIR, 'app.js');

const indexHtml = () => fs.readFileSync(INDEX, 'utf8');
const appJs = () => fs.readFileSync(APP, 'utf8');

test('la interfaz declara la pestaña y el panel de Dudas', () => {
  const html = indexHtml();
  assert.match(html, /data-tab="dudas"/, 'debe existir la pestaña');
  assert.match(html, /id="pane-dudas"/, 'debe existir el panel');
  assert.match(html, /id="dudas-list"/, 'debe existir la lista');
  assert.match(html, /id="badge-dudas"/, 'debe existir el aviso de pendientes');
});

test('el frontend pinta y responde las dudas del agente', () => {
  const src = appJs();
  assert.match(src, /dudas: \{ nota: 'dudas'/, 'la nota es conceptual/dudas.md');
  assert.match(src, /function manejarRespuestaDuda/, 'debe atender el envío de respuestas');
  assert.match(src, /#dudas-list/, 'debe estar enlazado el panel');
  assert.match(src, /editarLineaSeguimiento/, 'debe haber una edición de línea reutilizable');
});
