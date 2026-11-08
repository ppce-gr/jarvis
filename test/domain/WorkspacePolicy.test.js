import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_DIR, workspacePolicyLines } from '../../src/domain/WorkspacePolicy.js';

test('la política separa temporales de entregables', () => {
  const lineas = workspacePolicyLines('mi-idea', '/home/jarvis/jarvis/tmp');
  const texto = lineas.join('\n');
  assert.match(texto, /\/home\/jarvis\/jarvis\/tmp\/mi-idea\//);
  assert.match(texto, /code\/output\//);
  assert.match(texto, /ignorado por Git/);
  assert.equal(OUTPUT_DIR, 'code/output');
});

test('el recordatorio corto también nombra ambas rutas', () => {
  const texto = workspacePolicyLines('mi-idea', '/tmp/jarvis', { short: true }).join('\n');
  assert.match(texto, /\/tmp\/jarvis\/mi-idea\//);
  assert.match(texto, /code\/output\//);
});
