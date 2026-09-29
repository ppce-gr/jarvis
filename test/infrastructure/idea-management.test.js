import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemIdeaManagementAdapter } from '../../src/infrastructure/persistence/FileSystemIdeaManagementAdapter.js';
import { ManageIdeasUseCase } from '../../src/application/ManageIdeasUseCase.js';

async function conIdeas() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-ideas-'));
  const adapter = new FileSystemIdeaManagementAdapter(dir);
  const caso = new ManageIdeasUseCase(adapter);
  const crear = async (id, notas = {}, codigo = []) => {
    for (const [nombre, contenido] of Object.entries(notas)) {
      const p = path.join(dir, id, 'conceptual', nombre);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, contenido, 'utf8');
    }
    for (const f of codigo) {
      const p = path.join(dir, id, 'code', f);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, 'x', 'utf8');
    }
    await fs.mkdir(path.join(dir, id, 'logs'), { recursive: true });
  };
  return { dir, caso, crear };
}

const lee = (dir, ...t) => fs.readFile(path.join(dir, ...t), 'utf8');

test('duplicar clona la idea por completo', async () => {
  const { dir, caso, crear } = await conIdeas();
  await crear('original', { '_indice.md': 'hola' }, ['app/main.js']);
  await fs.mkdir(path.join(dir, 'original', 'adjuntos'), { recursive: true });
  await fs.writeFile(path.join(dir, 'original', 'adjuntos', 'foto.png'), 'PNG');

  await caso.duplicate('original', 'copia');
  assert.equal(await lee(dir, 'copia', 'conceptual', '_indice.md'), 'hola');
  assert.equal(await lee(dir, 'copia', 'code', 'app', 'main.js'), 'x');
  assert.equal(await lee(dir, 'copia', 'adjuntos', 'foto.png'), 'PNG');

  const meta = await caso.meta();
  assert.ok(meta.linaje.some((l) => l.accion === 'duplicada' && l.idea === 'copia' && l.de === 'original'));
});

test('renombrar mueve la carpeta y arregla la jerarquía', async () => {
  const { dir, caso, crear } = await conIdeas();
  await crear('padre', { '_indice.md': 'p' });
  await crear('hijo', { '_indice.md': 'h' });
  await caso.setParent('hijo', 'padre');

  await caso.rename('padre', 'padre-nuevo');
  await fs.stat(path.join(dir, 'padre-nuevo', 'conceptual', '_indice.md'));
  await assert.rejects(() => fs.stat(path.join(dir, 'padre')));
  const meta = await caso.meta();
  assert.equal(meta.padres.hijo, 'padre-nuevo');
  assert.equal(meta.padres['padre-nuevo'], null);
});

test('borrar manda la idea a la papelera y reparenta los hijos', async () => {
  const { dir, caso, crear } = await conIdeas();
  await crear('abuelo', {});
  await crear('padre', {});
  await crear('nieto', {});
  await caso.setParent('padre', 'abuelo');
  await caso.setParent('nieto', 'padre');

  const res = await caso.trash('padre');
  await assert.rejects(() => fs.stat(path.join(dir, 'padre')));
  await fs.stat(path.join(dir, '.papelera', path.basename(res.papelera)));
  const meta = await caso.meta();
  assert.equal(meta.padres.nieto, 'abuelo', 'el nieto sube al abuelo');
  assert.equal(meta.padres.padre, undefined);
});

test('fusionar renombra notas repetidas y encapsula los dos códigos', async () => {
  const { dir, caso, crear } = await conIdeas();
  await crear('destino', { '_indice.md': 'destino', 'comun.md': 'del destino' }, ['app/main.js']);
  await crear('origen', { '_indice.md': 'origen', 'comun.md': 'del origen' }, ['app/main.js']);

  await caso.merge('origen', 'destino');

  // Notas: la que llega se renombra.
  assert.equal(await lee(dir, 'destino', 'conceptual', 'comun.md'), 'del destino');
  assert.equal(await lee(dir, 'destino', 'conceptual', 'comun-2.md'), 'del origen');
  assert.equal(await lee(dir, 'destino', 'conceptual', '_indice.md'), 'destino');
  assert.equal(await lee(dir, 'destino', 'conceptual', '_indice-2.md'), 'origen');
  // Código: cada uno en su subcarpeta.
  await fs.stat(path.join(dir, 'destino', 'code', 'destino', 'app', 'main.js'));
  await fs.stat(path.join(dir, 'destino', 'code', 'origen', 'app', 'main.js'));
  // La absorbida se va a la papelera.
  await assert.rejects(() => fs.stat(path.join(dir, 'origen')));
  const meta = await caso.meta();
  assert.ok(meta.linaje.some((l) => l.accion === 'fusionada' && l.de === 'origen'));
});

test('la jerarquía impide ciclos', async () => {
  const { caso, crear } = await conIdeas();
  await crear('a', {});
  await crear('b', {});
  await caso.setParent('b', 'a');
  await assert.rejects(() => caso.setParent('a', 'b'), /PARENT_CYCLE/);
  await assert.rejects(() => caso.setParent('a', 'a'), /PARENT_CYCLE/);
});

test('una idea con workspace.json está protegida', async () => {
  const { dir, caso, crear } = await conIdeas();
  await crear('especial', {});
  await fs.writeFile(path.join(dir, 'especial', 'workspace.json'), '{}');
  await assert.rejects(() => caso.rename('especial', 'otro'), /PROJECT_PROTECTED/);
  await assert.rejects(() => caso.trash('especial'), /PROJECT_PROTECTED/);
  await assert.rejects(() => caso.duplicate('especial', 'copia'), /PROJECT_PROTECTED/);
});
