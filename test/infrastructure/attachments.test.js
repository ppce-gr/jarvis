import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemAttachmentAdapter } from '../../src/infrastructure/persistence/FileSystemAttachmentAdapter.js';
import { ManageAttachmentsUseCase } from '../../src/application/ManageAttachmentsUseCase.js';

/**
 * Adjuntos de una idea (`<idea>/adjuntos/`).
 * Se prueba con un cerebro temporal: subir, listar, mover, desasociar
 * (sin borrar del disco), borrar, historial y los bloqueos de seguridad.
 */
async function conAdjuntos() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-adj-'));
  const adapter = new FileSystemAttachmentAdapter(dir);
  return { dir, adapter, caso: new ManageAttachmentsUseCase(adapter) };
}

const rutaAdjunto = (dir, ...trozos) => path.join(dir, 'idea', 'adjuntos', ...trozos);

test('subir guarda el fichero, lo lista y deja historial', async () => {
  const { dir, caso } = await conAdjuntos();
  await caso.save('idea', 'foto.png', Buffer.from('PNG'));
  const { adjuntos, historial } = await caso.list('idea');

  assert.equal(adjuntos.length, 1);
  assert.equal(adjuntos[0].nombre, 'foto.png');
  assert.equal(adjuntos[0].bytes, 3);
  assert.equal(adjuntos[0].presente, true);
  assert.equal(historial[0].accion, 'subido');
  assert.equal(await fs.readFile(rutaAdjunto(dir, 'foto.png'), 'utf8'), 'PNG');
});

test('mover lleva el fichero a su sitio sin borrarlo del disco', async () => {
  const { dir, caso } = await conAdjuntos();
  await caso.save('idea', 'foto.png', Buffer.from('PNG'));
  await caso.move('idea', 'foto.png', 'code/imagenes');

  const { adjuntos, historial } = await caso.list('idea');
  assert.equal(adjuntos.length, 0, 'ya no es un adjunto');
  assert.equal(historial[0].accion, 'movido');
  assert.equal(historial[0].destino, 'code/imagenes/foto.png');
  // El fichero sigue en el disco, ahora en su sitio.
  assert.equal(await fs.readFile(path.join(dir, 'idea', 'code', 'imagenes', 'foto.png'), 'utf8'), 'PNG');
});

test('desasociar quita de la lista pero NO borra del disco', async () => {
  const { dir, caso } = await conAdjuntos();
  await caso.save('idea', 'nota.txt', Buffer.from('hola'));
  await caso.detach('idea', 'nota.txt');

  const { adjuntos, historial } = await caso.list('idea');
  assert.equal(adjuntos.length, 0);
  assert.equal(historial[0].accion, 'desasociado');
  // Sigue donde estaba: no se ha tocado.
  assert.equal(await fs.readFile(rutaAdjunto(dir, 'nota.txt'), 'utf8'), 'hola');
});

test('borrar elimina el fichero del disco', async () => {
  const { dir, caso } = await conAdjuntos();
  await caso.save('idea', 'nota.txt', Buffer.from('hola'));
  await caso.remove('idea', 'nota.txt');

  const { adjuntos, historial } = await caso.list('idea');
  assert.equal(adjuntos.length, 0);
  assert.equal(historial[0].accion, 'borrado');
  await assert.rejects(() => fs.stat(rutaAdjunto(dir, 'nota.txt')));
});

test('rechaza nombres con ruta u ocultos, y destinos que se escapan', async () => {
  const { caso } = await conAdjuntos();
  await assert.rejects(() => caso.save('idea', '../fuera.txt', Buffer.from('x')), /ATTACHMENT_NAME_INVALID/);
  await assert.rejects(() => caso.save('idea', 'sub/dir.txt', Buffer.from('x')), /ATTACHMENT_NAME_INVALID/);
  await assert.rejects(() => caso.save('idea', '.oculto', Buffer.from('x')), /ATTACHMENT_NAME_INVALID/);

  await caso.save('idea', 'ok.txt', Buffer.from('x'));
  await assert.rejects(() => caso.move('idea', 'ok.txt', '../fuera'), /ATTACHMENT_DESTINATION_INVALID/);
  await assert.rejects(() => caso.move('idea', 'ok.txt', '/etc'), /ATTACHMENT_DESTINATION_INVALID/);
});

test('no se puede mover, desasociar ni borrar lo que no está registrado', async () => {
  const { caso } = await conAdjuntos();
  await assert.rejects(() => caso.detach('idea', 'fantasma.txt'), /ATTACHMENT_NOT_FOUND/);
  await assert.rejects(() => caso.remove('idea', 'fantasma.txt'), /ATTACHMENT_NOT_FOUND/);
  await assert.rejects(() => caso.move('idea', 'fantasma.txt', 'code'), /ATTACHMENT_NOT_FOUND/);
});
