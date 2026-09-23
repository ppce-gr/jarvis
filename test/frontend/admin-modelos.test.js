import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba de la sección de administración de modelos.
 * ------------------------------------------------------------------
 * No hay navegador aquí, así que se comprueba lo comprobable: que la interfaz
 * declara el botón y el diálogo, que el botón de re-comprobar existe y que el
 * frontend llama a las rutas de salud/refresco. Si alguien quita una pieza,
 * la sección se queda muerta sin que nada más falle.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');
const APP = path.join(PUBLIC_DIR, 'app.js');

const indexHtml = () => fs.readFileSync(INDEX, 'utf8');
const appJs = () => fs.readFileSync(APP, 'utf8');

test('la interfaz declara el acceso a la administración de modelos', () => {
  const html = indexHtml();
  assert.match(html, /id="admin-btn"/, 'debe existir el botón de admin');
  assert.match(html, /id="admin-dialog"/, 'debe existir el diálogo de admin');
});

test('el diálogo tiene el botón de re-comprobar y la lista de modelos', () => {
  const html = indexHtml();
  assert.match(html, /id="models-refresh"/, 'debe existir el botón de re-comprobar');
  assert.match(html, /id="admin-models"/, 'debe existir la lista de modelos');
  assert.match(html, /id="admin-summary"/, 'debe existir el resumen');
});

test('el frontend consulta la salud y lanza la comprobación', () => {
  const src = appJs();
  assert.match(src, /\/api\/models\/health/, 'debe leer la salud de los modelos');
  assert.match(src, /\/api\/models\/refresh/, 'debe poder lanzar la comprobación');
  assert.match(src, /function abrirAdmin/, 'debe existir la apertura del panel');
  assert.match(src, /function comprobarModelos/, 'debe existir la acción de comprobar');
});

test('cada modelo del desplegable tiene su propio icono de refrescar', () => {
  const html = indexHtml();
  assert.match(html, /id="chat-model-menu"/, 'debe existir el menú de modelos');
  assert.doesNotMatch(html, /id="chat-models-refresh"/, 'no debe quedar un refresco global en el selector');
  const src = appJs();
  assert.match(src, /data-refresh=/, 'cada fila debe llevar su botón de refresco');
  assert.match(src, /function recargarModelo/, 'debe existir la recarga de un solo modelo');
  assert.match(src, /modelStatusInfo/, 'debe existir la lógica de iconos por estado');
  assert.match(src, /function esModeloDisponible/, 'sin confirmar debe contar como no disponible');
});
