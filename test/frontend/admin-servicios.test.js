import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * La sección de servicios vive dentro del panel de administración. Como aquí
 * no hay navegador, comprobamos que las piezas (contenedor y llamadas) existen.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

test('el panel de admin incluye la sección de servicios', () => {
  assert.match(indexHtml, /id="admin-servicios"/, 'debe existir la lista de servicios');
  assert.match(indexHtml, /id="servicios-summary"/, 'debe existir el resumen de servicios');
});

test('el frontend consulta y conmuta los servicios', () => {
  assert.match(appJs, /\/api\/system\/services/, 'debe llamar a la API de servicios');
  assert.match(appJs, /function cargarServicios/, 'debe existir la carga de servicios');
  assert.match(appJs, /function renderServicios/, 'debe existir el pintado de servicios');
  assert.match(appJs, /function accionServicio/, 'debe existir la acción de conmutar');
});
