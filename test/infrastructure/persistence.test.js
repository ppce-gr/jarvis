import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemNoteRepository } from '../../src/infrastructure/persistence/FileSystemNoteRepository.js';
import { FileSystemProjectRepository } from '../../src/infrastructure/persistence/FileSystemProjectRepository.js';
import { FileSystemBrowserAdapter } from '../../src/infrastructure/persistence/FileSystemBrowserAdapter.js';
import { Note } from '../../src/domain/Note.js';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-test-'));
}

test('FileSystemNoteRepository hace round-trip de frontmatter y contenido', async () => {
  const dir = await tempDir();
  const repo = new FileSystemNoteRepository(dir);

  await repo.save(new Note({
    id: 'subidea',
    projectId: 'proj',
    title: 'Subidea',
    content: 'Cuerpo con [[enlace]].',
    frontmatter: { title: 'Subidea', status: 'activa' }
  }));

  const loaded = await repo.findById('proj', 'subidea');
  assert.equal(loaded.title, 'Subidea');
  assert.equal(loaded.frontmatter.status, 'activa');
  assert.match(loaded.content, /\[\[enlace\]\]/);

  // El fichero debe existir en la ruta esperada
  const raw = await fs.readFile(path.join(dir, 'proj', 'conceptual', 'subidea.md'), 'utf8');
  assert.match(raw, /^---/);
});

test('FileSystemNoteRepository devuelve null para nota inexistente', async () => {
  const dir = await tempDir();
  const repo = new FileSystemNoteRepository(dir);
  assert.equal(await repo.findById('p', 'nope'), null);
});

test('FileSystemProjectRepository lista y recupera proyectos', async () => {
  const dir = await tempDir();
  const repo = new FileSystemProjectRepository(dir);

  await repo.save({ id: 'alfa', name: 'alfa', description: '# Alfa', status: 'activa' });
  await repo.save({ id: 'beta', name: 'beta', description: '', status: 'activa' });

  const all = await repo.findAll();
  assert.deepEqual(all.map((p) => p.id).sort(), ['alfa', 'beta']);

  const alfa = await repo.findById('alfa');
  assert.match(alfa.description, /Alfa/);
  assert.equal(alfa.isArchived(), false);
});

test('FileSystemBrowserAdapter lista y lee dentro de la zona permitida', async () => {
  const dir = await tempDir();
  const adapter = new FileSystemBrowserAdapter(dir);

  await fs.mkdir(path.join(dir, 'proj', 'code', 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'proj', 'code', 'src', 'index.js'), 'console.log(1)');

  const files = await adapter.listFiles('proj', 'code');
  assert.ok(files.some((f) => f.path === 'src' && f.type === 'dir'));
  assert.ok(files.some((f) => f.path.endsWith('index.js') && f.type === 'file'));

  const content = await adapter.readFile('proj', 'code', 'src/index.js');
  assert.equal(content, 'console.log(1)');
});

test('FileSystemBrowserAdapter bloquea zonas y path traversal', async () => {
  const dir = await tempDir();
  const adapter = new FileSystemBrowserAdapter(dir);

  await assert.rejects(() => adapter.listFiles('proj', 'etc'), /ZONE_NOT_ALLOWED/);
  await assert.rejects(
    () => adapter.readFile('proj', 'code', '../../../etc/passwd'),
    /PATH_NOT_ALLOWED/
  );
});
