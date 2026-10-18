import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManageAppSettingsUseCase } from '../../src/application/ManageAppSettingsUseCase.js';

/**
 * Ajustes de TODA la aplicación, no de un chat. El caso de uso debe poder
 * leerlos y guardarlos con el adaptador de conversación, sin pedir una idea.
 */
function adaptadorFalso(initial = 'script') {
  const estado = { fetch_mode: initial };
  return {
    estado,
    async getSettings() { return { ...estado }; },
    async setConfig(id, value) {
      if (id !== 'fetch_mode') throw new Error(`CONFIG_ID_NOT_SUPPORTED: ${id}`);
      estado.fetch_mode = value;
    }
  };
}

test('lee y guarda el modo de descargas sin depender de una idea', async () => {
  const adaptador = adaptadorFalso('script');
  const caso = new ManageAppSettingsUseCase(adaptador);

  assert.equal((await caso.get()).fetch_mode, 'script');

  const tras = await caso.set('fetch_mode', 'ia');
  assert.equal(tras.fetch_mode, 'ia');
  assert.equal(adaptador.estado.fetch_mode, 'ia');
});

test('rechaza ajustes que no son de aplicación', async () => {
  const caso = new ManageAppSettingsUseCase(adaptadorFalso());
  await assert.rejects(() => caso.set('model', 'x'), /CONFIG_ID_NOT_SUPPORTED/);
  await assert.rejects(() => caso.set('fetch_mode', ''), /CONFIG_VALUE_REQUIRED/);
});

test('si el adaptador no soporta ajustes, lo dice', async () => {
  const caso = new ManageAppSettingsUseCase({});
  await assert.rejects(() => caso.get(), /APP_SETTINGS_NOT_SUPPORTED/);
});
