import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba de la parada con confirmación.
 * ------------------------------------------------------------------
 * No hay navegador aquí, así que se comprueba lo comprobable: que existe el
 * diálogo de confirmación y que el frontend convierte el botón de enviar en
 * uno de detener mientras el agente trabaja. Si alguien quita una pieza, el
 * botón dejaría de responder sin que nada más falle.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');
const APP = path.join(PUBLIC_DIR, 'app.js');

const indexHtml = () => fs.readFileSync(INDEX, 'utf8');
const appJs = () => fs.readFileSync(APP, 'utf8');

test('la interfaz declara el diálogo de confirmación de parada', () => {
  const html = indexHtml();
  assert.match(html, /id="stop-dialog"/, 'debe existir el diálogo de parada');
  assert.match(html, /id="stop-confirm"/, 'debe existir el botón de confirmar');
  assert.match(html, /id="chat-send"/, 'debe existir el botón de enviar');
});

test('el botón de enviar se convierte en detener mientras el agente trabaja', () => {
  const src = appJs();
  assert.match(src, /is-stop/, 'debe marcar el botón como detener');
  assert.match(src, /enviar\.textContent = state\.chat\.busy \? '■ Detener' : 'Enviar'/);
});

test('detener pasa por la confirmación antes de cancelar', () => {
  const src = appJs();
  assert.match(src, /function preguntarDetener/, 'debe existir la confirmación');
  assert.match(src, /function cancelarTurno/, 'debe existir la cancelación real');
  assert.match(src, /#stop-confirm/, 'el botón de confirmar debe estar enlazado');
});
