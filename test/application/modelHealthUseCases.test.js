import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetModelHealthUseCase } from '../../src/application/GetModelHealthUseCase.js';
import { RefreshModelsUseCase } from '../../src/application/RefreshModelsUseCase.js';

/** Adaptador de mentira: sólo comprueba que el caso de uso delega. */
function fakeAdapter() {
  return {
    refreshed: 0,
    health: { checking: false, checkedAt: '2026-01-01T00:00:00.000Z', results: { m: { status: 'ok' } } },
    async getModelHealth() { return this.health; },
    async refreshModels() {
      this.refreshed += 1;
      return { started: true, checking: true };
    }
  };
}

test('GetModelHealthUseCase devuelve la salud del adaptador', async () => {
  const adapter = fakeAdapter();
  const health = await new GetModelHealthUseCase(adapter).execute();
  assert.equal(health.results.m.status, 'ok');
});

test('RefreshModelsUseCase pide la re-comprobación', async () => {
  const adapter = fakeAdapter();
  const result = await new RefreshModelsUseCase(adapter).execute();
  assert.deepEqual(result, { started: true, checking: true });
  assert.equal(adapter.refreshed, 1);
});
