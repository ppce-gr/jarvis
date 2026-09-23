import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets,
  truncateText,
  sanitizeActivity,
  summarizeToolInput,
  summarizeTool,
  formatToolInput,
  formatToolDetail
} from '../../src/domain/ActivityTrace.js';

/* ================================================================
   Redacción de secretos
   ================================================================ */

test('redacta claves y tokens típicos', () => {
  const casos = [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'xoxb-1234567890-abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'
  ];
  for (const secreto of casos) {
    const salida = redactSecrets(`valor: ${secreto} fin`);
    assert.doesNotMatch(salida, new RegExp(secreto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(salida, /REDACTADO|REDACTADA/);
  }
});

test('redacta Bearer, contraseñas y credenciales en URL', () => {
  assert.match(redactSecrets('Authorization: Bearer abcdefghijklmnop'), /Bearer \[REDACTADO\]/);
  assert.match(redactSecrets('password=SuperSecreto123'), /password=\[REDACTADO\]/);
  assert.match(redactSecrets('api_key: "abc123def456"'), /api_key: "?\[REDACTADO\]/);
  assert.match(redactSecrets('https://user:clave@example.com/x'), /user:\[REDACTADO\]@/);
});

test('redacta bloques de clave privada', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
  const salida = redactSecrets(pem);
  assert.match(salida, /CLAVE PRIVADA REDACTADA/);
  assert.doesNotMatch(salida, /MIIEow/);
});

test('no toca el texto normal', () => {
  const texto = 'He leído el fichero src/index.js y funciona.';
  assert.equal(redactSecrets(texto), texto);
});

/* ================================================================
   Recorte
   ================================================================ */

test('recorta por número de líneas', () => {
  const texto = Array.from({ length: 10 }, (_, i) => `línea ${i}`).join('\n');
  const { text, truncated } = truncateText(texto, { maxLines: 3, maxBytes: 10000 });
  assert.equal(truncated, true);
  assert.equal(text.split('\n').length, 3);
});

test('recorta por bytes y no parte un carácter', () => {
  const texto = 'á'.repeat(100);   // 2 bytes cada uno en UTF-8
  const { text, truncated } = truncateText(texto, { maxBytes: 11, maxLines: 1000 });
  assert.equal(truncated, true);
  assert.ok(new TextEncoder().encode(text).length <= 11);
});

test('sanitizeActivity redacta, recorta y avisa', () => {
  const entrada = `sk-abcdefghijklmnopqrstuvwxyz012345\n${'x'.repeat(100)}`;
  const salida = sanitizeActivity(entrada, { maxBytes: 20, maxLines: 1 });
  assert.match(salida, /REDACTADO/);
  assert.match(salida, /recortado/);
  assert.doesNotMatch(salida, /sk-abcdefghijklmnop/);
});

test('sin recorte no añade el aviso', () => {
  assert.equal(sanitizeActivity('corto', { maxBytes: 100, maxLines: 10 }), 'corto');
});

/* ================================================================
   Resumen de herramientas
   ================================================================ */

test('summarizeToolInput elige el campo más útil', () => {
  assert.equal(summarizeToolInput({ command: 'npm test' }), 'npm test');
  assert.equal(summarizeToolInput({ path: 'src/index.js' }), 'src/index.js');
  assert.equal(summarizeToolInput({ irrelevant: 1, file_path: '/tmp/x' }), '/tmp/x');
  assert.equal(summarizeToolInput('texto plano'), 'texto plano');
  assert.equal(summarizeToolInput(null), '');
});

test('summarizeTool compone la línea compacta', () => {
  assert.equal(summarizeTool('read_file', { path: 'a.md' }), 'read_file · a.md');
  assert.equal(summarizeTool('read_file', null), 'read_file');
});

test('formatToolDetail junta entrada y salida', () => {
  const detalle = formatToolDetail('npm test', 'todo verde');
  assert.match(detalle, /Entrada:\nnpm test/);
  assert.match(detalle, /Salida:\ntodo verde/);
  assert.equal(formatToolDetail('', ''), '');
  assert.equal(formatToolInput({ a: 1 }), '{\n  "a": 1\n}');
});
