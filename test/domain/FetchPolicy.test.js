import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FETCH_MODE,
  normalizarFetchMode,
  fetchPolicyLines
} from '../../src/domain/FetchPolicy.js';

test('por defecto el fetch va por scripts', () => {
  assert.equal(DEFAULT_FETCH_MODE, 'script');
  assert.equal(normalizarFetchMode(undefined), 'script');
  assert.equal(normalizarFetchMode(''), 'script');
  assert.equal(normalizarFetchMode('cualquier-cosa'), 'script');
});

test('reconoce el modo IA', () => {
  assert.equal(normalizarFetchMode('ia'), 'ia');
  assert.equal(normalizarFetchMode('AI'), 'ia');
});

test('el modo script prohíbe el fetch de la IA y manda curl/wget', () => {
  const txt = fetchPolicyLines('script').join('\n');
  assert.match(txt, /NO uses la herramienta de fetch/i);
  assert.match(txt, /curl/);
  assert.match(txt, /wget/);
  assert.match(txt, /memoria/i);
});

test('el modo ia permite pasar la URL al modelo', () => {
  const txt = fetchPolicyLines('ia').join('\n');
  assert.match(txt, /Puedes pasar la URL/);
  assert.doesNotMatch(txt, /NO uses/);
});
