import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemConversationStoreAdapter } from '../../src/infrastructure/persistence/FileSystemConversationStoreAdapter.js';
import { ManageConversationsUseCase } from '../../src/application/ManageConversationsUseCase.js';

async function conConversaciones() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-conv-'));
  const logs = path.join(dir, 'idea', 'logs');
  await fs.mkdir(logs, { recursive: true });
  const store = new FileSystemConversationStoreAdapter(dir);
  const resets = [];
  const adapter = { async reset(id) { resets.push(id); } };
  const caso = new ManageConversationsUseCase(store, adapter);
  const escribir = (mensajes) => fs.writeFile(
    path.join(logs, 'conversacion.jsonl'),
    `${mensajes.map((m) => JSON.stringify(m)).join('\n')}\n`,
    'utf8'
  );
  return { dir, logs, store, caso, resets, escribir };
}

test('archivar guarda la conversación, la lista y reinicia la sesión', async () => {
  const { caso, resets, escribir, logs } = await conConversaciones();
  await escribir([{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'buenas' }]);

  const r = await caso.archive('idea');
  assert.ok(r.archivada, 'devuelve el nombre del archivo');
  assert.deepEqual(resets, ['idea'], 'reinicia la sesión del agente');
  await assert.rejects(() => fs.stat(path.join(logs, 'conversacion.jsonl')), 'la actual queda vacía');

  const list = await caso.list('idea');
  assert.equal(list.actual.mensajes, 0);
  assert.equal(list.archivadas.length, 1);
  assert.equal(list.archivadas[0].mensajes, 2);
  assert.equal(list.archivadas[0].inicio, 'hola', 'trae un extracto reconocible');
  assert.equal(list.archivadas[0].ultimo, 'buenas');
});

test('continuar trae una archivada como actual, conserva la previa y reinicia', async () => {
  const { caso, escribir, resets } = await conConversaciones();
  await escribir([{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'buenas' }]);
  const { archivada } = await caso.archive('idea');

  // Empieza una conversación nueva y luego vuelve a la guardada.
  await escribir([{ role: 'user', text: 'otra cosa' }]);
  const r = await caso.continue('idea', archivada);
  assert.equal(r.continuada, archivada);

  const { messages } = await caso.read('idea', 'actual');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, 'hola');
  assert.ok(resets.length >= 2, 'reinició al archivar y al continuar');

  const list = await caso.list('idea');
  assert.equal(list.archivadas.length, 1, 'la elegida se mueve; solo queda la previa');
  assert.notEqual(list.archivadas[0].nombre, archivada, 'la elegida deja de estar archivada');
  assert.equal(list.archivadas[0].inicio, 'otra cosa');
});

test('no se puede continuar algo que no existe', async () => {
  const { caso } = await conConversaciones();
  await assert.rejects(() => caso.continue('idea', 'no-existe.jsonl'), /CONVERSATION_NOT_FOUND/);
  await assert.rejects(() => caso.read('idea', '../fuera.jsonl'), /CONVERSATION_NAME_INVALID/);
});
