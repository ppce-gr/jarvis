import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prueba del favicon.
 * ------------------------------------------------------------------
 * POR QUÉ EXISTE: un favicon no rompe nada si falta —el navegador pide
 * /favicon.svg, recibe un 404 y sigue— y por eso es justo el tipo de detalle
 * que se queda roto sin que nadie se entere: el `<link>` apunta a un fichero
 * que ya no está, o el SVG deja de parsear. No hay navegador aquí, así que
 * comprobamos lo comprobable: que la interfaz lo declara y que el fichero
 * declarado existe y es un SVG en condiciones.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');

/** Devuelve el href del <link rel="icon">, o lanza si no lo declara. */
function hrefDelFavicon() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const link = html.match(/<link[^>]*\brel="icon"[^>]*>/);
  assert.ok(link, 'index.html debe declarar un <link rel="icon">');
  const href = link[0].match(/\bhref="([^"]+)"/);
  assert.ok(href, 'el <link rel="icon"> debe tener href');
  return href[1];
}

test('la interfaz declara un favicon', () => {
  assert.match(hrefDelFavicon(), /\.svg$/, 'debe apuntar a un SVG');
});

test('el favicon declarado existe', () => {
  const href = hrefDelFavicon();
  const ruta = path.join(PUBLIC_DIR, href.replace(/^\//, ''));
  assert.ok(fs.existsSync(ruta), `no existe el favicon declarado: ${href}`);
});

test('el favicon es un SVG válido y sin dependencias de fuentes', () => {
  const href = hrefDelFavicon();
  const svg = fs.readFileSync(path.join(PUBLIC_DIR, href.replace(/^\//, '')), 'utf8');
  assert.match(svg, /<svg[\s>]/, 'debe contener un elemento <svg>');
  assert.match(svg, /viewBox=/, 'debe declarar viewBox para escalar');
  // Un favicon con <text> se ve distinto (o vacío) según las fuentes del
  // dispositivo. La marca va dibujada con trazos.
  assert.doesNotMatch(svg, /<text[\s>]/, 'no debe depender de fuentes del sistema');
});
