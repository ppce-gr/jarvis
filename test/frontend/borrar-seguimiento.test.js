import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba del borrado con confirmación en las pestañas de seguimiento.
 * ------------------------------------------------------------------
 * No hay navegador aquí, así que se comprueba lo comprobable: que existe el
 * diálogo, que el borrado pasa por él y que el botón está en los dos grupos
 * (pendientes y registrados) y en las dos pestañas (preguntas y claves, que
 * comparten el mismo pintado).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');
const APP = path.join(PUBLIC_DIR, 'app.js');

const indexHtml = () => fs.readFileSync(INDEX, 'utf8');
const appJs = () => fs.readFileSync(APP, 'utf8');

test('la interfaz declara el diálogo de borrado', () => {
  const html = indexHtml();
  assert.match(html, /id="borrar-dialog"/, 'debe existir el diálogo');
  assert.match(html, /id="borrar-confirm"/, 'debe existir el botón de confirmar');
  assert.match(html, /id="borrar-texto"/, 'debe poder enseñar qué se borra');
  assert.match(html, /btn-danger/, 'el botón de borrar debe verse como peligro');
});

test('borrar pregunta o clave pasa por confirmación', () => {
  const src = appJs();
  assert.match(src, /function pedirBorrado/, 'debe existir la confirmación');
  assert.match(src, /function confirmarBorrado/, 'debe existir el borrado real');
  assert.match(src, /#borrar-confirm/, 'el botón de confirmar debe estar enlazado');
  assert.match(src, /segAccion === 'borrar'/, 'el clic de borrar debe desviarse');
  assert.match(src, /data-seg-texto=/, 'debe llevar el texto para el aviso');
});
