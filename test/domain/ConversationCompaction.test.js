import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactarConversacion,
  MAX_TEXTO_ANTIGUO
} from '../../src/domain/ConversationCompaction.js';

test('conserva resúmenes y texto, y descarta la traza antigua', () => {
  const mensajes = [
    { role: 'user', text: 'viejo' },
    { role: 'assistant', text: 'respuesta vieja' },
    { role: 'tool', id: 't1', text: 'bash', detail: 'x'.repeat(100) },
    { role: 'thought', detail: 'razonamiento viejo' },
    { role: 'subchat', n: 2, resumen: 'resumen del tramo' },
    { role: 'user', text: 'actual' },
    { role: 'tool', id: 't2', text: 'read', detail: 'traza actual' }
  ];

  const compactados = compactarConversacion(mensajes);
  assert.ok(compactados.some((m) => m.text === 'viejo'), 'el texto antiguo se conserva');
  assert.ok(compactados.some((m) => m.text === 'respuesta vieja'));
  assert.ok(compactados.some((m) => m.role === 'subchat'), 'el resumen se conserva');
  assert.ok(compactados.some((m) => m.id === 't2'), 'la traza del chat actual se conserva');
  assert.ok(!compactados.some((m) => m.id === 't1'), 'la traza antigua se descarta');
  assert.ok(!compactados.some((m) => m.role === 'thought'), 'el razonamiento antiguo se descarta');
});

test('sin marcas no toca la conversación', () => {
  const mensajes = [
    { role: 'user', text: 'uno' },
    { role: 'assistant', text: 'dos' },
    { role: 'tool', id: 't1' }
  ];
  assert.equal(compactarConversacion(mensajes).length, mensajes.length);
});

test('limita el texto antiguo pero conserva todas las marcas', () => {
  const mensajes = [];
  for (let i = 0; i < MAX_TEXTO_ANTIGUO + 5; i += 1) {
    mensajes.push({ role: 'user', text: `antiguo ${i}` });
  }
  mensajes.push({ role: 'subchat', n: 2, resumen: 'resumen' });
  mensajes.push({ role: 'user', text: 'actual' });

  const compactados = compactarConversacion(mensajes);
  const texto = compactados.filter((m) => m.role === 'user' || m.role === 'assistant');
  assert.equal(texto.length, MAX_TEXTO_ANTIGUO + 1, 'conserva el máximo de texto antiguo y el actual');
  assert.ok(compactados.some((m) => m.role === 'subchat'));
  assert.ok(!compactados.some((m) => m.text === 'antiguo 0'), 'se van los más antiguos');
});
