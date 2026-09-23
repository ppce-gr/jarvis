import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_STATUS,
  classifyModelFailure,
  isRemovable,
  effortOption,
  flattenModels,
  applyModelHealth
} from '../../src/domain/ModelHealth.js';

/* ================================================================
   Clasificación de fallos
   ================================================================ */

test('la cuota agotada se conserva, no se retira', () => {
  for (const mensaje of [
    'insufficient quota for this account',
    'You exceeded your current quota, please check your plan',
    'Your balance is exhausted',
    'quota exhausted',
    '429 RESOURCE_EXHAUSTED: quota exceeded',
    'out of credits'
  ]) {
    const r = classifyModelFailure(mensaje);
    assert.equal(r.status, MODEL_STATUS.QUOTA, `debe ser cuota: ${mensaje}`);
    assert.equal(isRemovable(r.status), false);
  }
});

test('un modelo inexistente o no disponible se puede retirar', () => {
  for (const mensaje of [
    'model_not_found: deepseek-v4-galaxy',
    'unknown model: gemini-99',
    'The model does not exist',
    'model is not available in your region',
    'this model is deprecated',
    'You do not have access to the model gemini-ultra',
    'model is not supported'
  ]) {
    const r = classifyModelFailure(mensaje);
    assert.equal(r.status, MODEL_STATUS.BROKEN, `debe ser roto: ${mensaje}`);
    assert.equal(isRemovable(r.status), true);
  }
});

test('un fallo transitorio no retira el modelo', () => {
  for (const mensaje of [
    'invalid api key',
    '401 Unauthorized',
    '403 Forbidden: permission denied',
    'Rate limit reached, retry later',
    'too many requests',
    'request timed out',
    'fetch failed: ECONNRESET',
    'the context window was exceeded',
    'input is too long for this model'
  ]) {
    const r = classifyModelFailure(mensaje);
    assert.equal(r.status, MODEL_STATUS.UNKNOWN, `debe ser transitorio: ${mensaje}`);
    assert.equal(isRemovable(r.status), false);
  }
});

test('un fallo de esfuerzo no marca el modelo como roto', () => {
  for (const mensaje of [
    'UNSUPPORTED_REASONING_EFFORT',
    'provider "x" model "y" does not support reasoning effort "high"',
    'unknown reasoning effort for x/y: max'
  ]) {
    const r = classifyModelFailure(mensaje);
    assert.equal(r.status, MODEL_STATUS.OK, `debe ser ok: ${mensaje}`);
    assert.equal(r.kind, 'effort');
  }
});

test('un mensaje desconocido queda en unknown (no se retira)', () => {
  const r = classifyModelFailure('algo raro pasó');
  assert.equal(r.status, MODEL_STATUS.UNKNOWN);
  assert.equal(isRemovable(r.status), false);
  assert.equal(classifyModelFailure('').status, MODEL_STATUS.UNKNOWN);
});

/* ================================================================
   Catálogo
   ================================================================ */

const CATALOGO = [
  {
    id: 'model',
    category: 'model',
    currentValue: '["p","a"]',
    options: [
      {
        group: 'p',
        name: 'Proveedor P',
        options: [
          { value: '["p","a"]', name: 'Modelo A' },
          { value: '["p","b"]', name: 'Modelo B' },
          { value: '["p","c"]', name: 'Modelo C' }
        ]
      }
    ]
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    currentValue: 'high',
    options: [{ value: 'high', name: 'Alto' }]
  }
];

test('effortOption sólo aparece si el catálogo la trae', () => {
  assert.ok(effortOption(CATALOGO));
  assert.equal(effortOption([CATALOGO[0]]), null);
});

test('flattenModels aplana proveedores y modelos', () => {
  const modelos = flattenModels(CATALOGO);
  assert.deepEqual(modelos.map((m) => m.value), ['["p","a"]', '["p","b"]', '["p","c"]']);
  assert.equal(modelos[0].provider, 'p');
});

test('applyModelHealth retira los rotos y anota el resto', () => {
  const filtrado = applyModelHealth(CATALOGO, {
    '["p","b"]': { status: MODEL_STATUS.BROKEN, error: 'no existe' },
    '["p","c"]': { status: MODEL_STATUS.QUOTA, error: 'sin cuota' }
  });
  const modelos = flattenModels(filtrado);
  assert.deepEqual(modelos.map((m) => m.value), ['["p","a"]', '["p","c"]']);

  const opcionModelo = filtrado.find((o) => o.id === 'model');
  const itemC = opcionModelo.options[0].options.find((i) => i.value === '["p","c"]');
  assert.equal(itemC.health.status, MODEL_STATUS.QUOTA);
  assert.match(itemC.health.error, /sin cuota/);
});

test('applyModelHealth no toca la opción de esfuerzo', () => {
  const filtrado = applyModelHealth(CATALOGO, { '["p","a"]': { status: MODEL_STATUS.BROKEN } });
  assert.ok(filtrado.find((o) => o.id === 'reasoning_effort'));
});
