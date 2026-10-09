import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemResumeNoteAdapter } from '../../src/infrastructure/persistence/FileSystemResumeNoteAdapter.js';
import { ManageResumeNoteUseCase } from '../../src/application/ManageResumeNoteUseCase.js';
import { AcpConversationAdapter } from '../../src/infrastructure/conversation/AcpConversationAdapter.js';

async function conNota() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tarea-'));
  const adapter = new FileSystemResumeNoteAdapter(dir);
  const caso = new ManageResumeNoteUseCase(adapter);
  // Idea normal: su workspace es su propia carpeta.
  await fs.mkdir(path.join(dir, 'normal'), { recursive: true });
  return { dir, adapter, caso };
}

test('sin nota no hay nada que reanudar', async () => {
  const { caso } = await conNota();
  const nota = await caso.get('normal');
  assert.equal(nota.existe, false);
  assert.deepEqual(await caso.list(['normal']), []);
});

test('lee y borra la nota del workspace de la idea', async () => {
  const { dir, caso } = await conNota();
  await fs.writeFile(
    path.join(dir, 'normal', 'tarea-en-curso.md'),
    '## Qué estaba haciendo\nMontaba el grafo.\n\n## Qué falta\nProbar.\n',
    'utf8'
  );
  const nota = await caso.get('normal');
  assert.equal(nota.existe, true);
  assert.match(nota.contenido, /Montaba el grafo/);

  const listado = await caso.list(['normal', 'no-existe']);
  assert.equal(listado.length, 1);
  assert.equal(listado[0].projectId, 'normal');
  assert.equal(listado[0].extracto, 'Montaba el grafo.', 'el extracto salta las cabeceras');

  await caso.clear('normal');
  assert.equal((await caso.get('normal')).existe, false);
});

test('respeta workspace.json: la nota vive donde trabaja el agente', async () => {
  const { dir, caso } = await conNota();
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-repo-'));
  await fs.mkdir(path.join(dir, 'automodificacion'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'automodificacion', 'workspace.json'),
    JSON.stringify({ workspace: repo }),
    'utf8'
  );
  await fs.writeFile(path.join(repo, 'tarea-en-curso.md'), 'Pendiente: desplegar.', 'utf8');

  const nota = await caso.get('automodificacion');
  assert.equal(nota.existe, true);
  assert.match(nota.contenido, /desplegar/);

  // Y se borra del workspace, no de la carpeta de la idea.
  await caso.clear('automodificacion');
  await assert.rejects(() => fs.stat(path.join(repo, 'tarea-en-curso.md')));
});

test('el bloque de reanudación avisa de que la nota puede estar superada', () => {
  const bloque = AcpConversationAdapter._preambleTarea('## Qué falta\nProbar.', '2026-10-09T12:00:00.000Z');
  assert.match(bloque, /Nota de reanudación/);
  assert.match(bloque, /BÓRRALA/);
  assert.match(bloque, /Probar\./);
});
