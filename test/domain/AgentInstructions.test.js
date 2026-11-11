import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFirstMessage, buildFollowupMessage } from '../../src/domain/AgentInstructions.js';

test('el prompt ordena estático, resumen, historial, estado y mensaje', () => {
  const texto = buildFirstMessage({
    projectId: 'demo',
    text: 'última acción',
    fetchMode: 'script',
    tmpDir: '/tmp/jarvis',
    summary: 'RESUMEN ACUMULADO',
    history: [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'respuesta' }],
    resume: { contenido: 'ESTADO ACTUAL', modificadoEn: '2026-11-08T10:00:00Z' }
  });
  const iStatic = texto.indexOf('Trabajas dentro del proyecto "demo"');
  const iSummary = texto.indexOf('RESUMEN ACUMULADO');
  const iHistory = texto.indexOf('Usuario: hola');
  const iResume = texto.indexOf('ESTADO ACTUAL');
  const iUser = texto.indexOf('última acción');
  assert.ok(iStatic >= 0 && iSummary > iStatic && iHistory > iSummary && iResume > iHistory && iUser > iResume);
  assert.ok(texto.trimEnd().endsWith('última acción'));
});

test('un turno posterior pone las políticas antes del input', () => {
  const texto = buildFollowupMessage({ projectId: 'demo', text: 'sigue', fetchMode: 'script', tmpDir: '/tmp/jarvis' });
  assert.ok(texto.indexOf('Descargas y Fetch') < texto.indexOf('sigue'));
  assert.ok(texto.trimEnd().endsWith('sigue'));
});
