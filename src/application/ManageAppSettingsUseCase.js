/**
 * Capa de Aplicación: ManageAppSettingsUseCase
 * ==================================================================
 * Ajustes de TODA la aplicación (no de un chat ni de una idea). Hoy el
 * único es el **modo de descargas** (`fetch_mode`): con scripts o con la
 * herramienta de fetch de la IA.
 *
 * Viven en `chat-config.json`, el mismo fichero que la preferencia de
 * modelo, pero se leen y se escriben **sin necesidad de tener una idea
 * abierta**: el panel de Administración está en la cabecera y debe
 * funcionar desde el inicio.
 */
export class ManageAppSettingsUseCase {
  constructor(conversationAdapter) {
    this.conversationAdapter = conversationAdapter;
  }

  async get() {
    if (typeof this.conversationAdapter.getSettings !== 'function') {
      throw new Error('APP_SETTINGS_NOT_SUPPORTED');
    }
    return await this.conversationAdapter.getSettings();
  }

  async set(configId, value) {
    if (configId !== 'fetch_mode') {
      throw new Error(`CONFIG_ID_NOT_SUPPORTED: ${configId}`);
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error('CONFIG_VALUE_REQUIRED');
    }
    await this.conversationAdapter.setConfig(String(configId), String(value));
    return await this.get();
  }
}
