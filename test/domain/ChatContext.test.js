import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_LIMITS,
  estimarTokens,
  normalizarLimites,
  medirConversacion
} from '../../src/domain/ChatContext.js';

test('estimarTokens aproxima a 4 caracteres por token', () => {
  assert.equal(estimarTokens(''), 0);
  assert.equal(estimarTokens('abcd'), 1);
  assert.equal(estimarTokens('a'.repeat(401)), 101);
});

test('normalizarLimites usa los de por defecto si no valen', () => {
  assert.deepEqual(normalizarLimites({ maxTokens: 10, maxBytes: 20 }), { maxTokens: 10, maxBytes: 20 });
  assert.deepEqual(normalizarLimites({ maxTokens: 0, maxBytes: -1 }), CHAT_LIMITS);
  assert.deepEqual(normalizarLimites({}), CHAT_LIMITS);
  assert.deepEqual(normalizarLimites(), CHAT_LIMITS);
});

test('medirConversacion solo cuenta usuario y Jarvis', () => {
  const medido = medirConversacion([
    { role: 'user', text: 'a'.repeat(40) },
    { role: 'assistant', text: 'b'.repeat(40) },
    { role: 'tool', text: 'c'.repeat(4000) },
    { role: 'subchat', resumen: 'd'.repeat(4000) }
  ], { maxTokens: 1000, maxBytes: 100000 });
  assert.equal(medido.tokens, 20); // 80 caracteres / 4
  assert.equal(medido.mensajes, 2);
  assert.equal(medido.debePartir, false);
});

test('medirConversacion parte al pasar tokens o bytes', () => {
  const mensajes = [{ role: 'user', text: 'á'.repeat(100) }];
  assert.equal(medirConversacion(mensajes, { maxTokens: 1, maxBytes: 100000 }).debePartir, true);
  assert.equal(medirConversacion(mensajes, { maxTokens: 100000, maxBytes: 10 }).debePartir, true);
  assert.equal(medirConversacion(mensajes, { maxTokens: 100000, maxBytes: 100000 }).debePartir, false);
});
