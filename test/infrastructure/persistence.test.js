import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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

  const descarga = await adapter.downloadFile('proj', 'code', 'src/index.js');
  assert.equal(descarga.name, 'index.js');
  assert.equal(descarga.size, 'console.log(1)'.length);
  assert.equal(descarga.content.toString('utf8'), 'console.log(1)');
});

test('FileSystemBrowserAdapter bloquea zonas y path traversal', async () => {
  const dir = await tempDir();
  const adapter = new FileSystemBrowserAdapter(dir);

  await assert.rejects(() => adapter.listFiles('proj', 'etc'), /ZONE_NOT_ALLOWED/);
  await assert.rejects(
    () => adapter.readFile('proj', 'code', '../../../etc/passwd'),
    /PATH_NOT_ALLOWED/
  );
  await assert.rejects(
    () => adapter.downloadFile('proj', 'code', '../../../etc/passwd'),
    /PATH_NOT_ALLOWED/
  );
  await assert.rejects(
    () => adapter.downloadFolder('proj', 'code', '../../../etc'),
    /PATH_NOT_ALLOWED/
  );
});

test('FileSystemBrowserAdapter empaqueta una carpeta en un ZIP válido', async () => {
  const dir = await tempDir();
  const adapter = new FileSystemBrowserAdapter(dir);
  await fs.mkdir(path.join(dir, 'proj', 'code', 'src', 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'proj', 'code', 'src', 'index.js'), 'console.log(1)');
  await fs.writeFile(path.join(dir, 'proj', 'code', 'src', 'sub', 'nota.txt'), 'hola');

  const zip = await adapter.downloadFolder('proj', 'code', 'src');
  assert.equal(zip.name, 'src.zip');
  assert.equal(zip.count, 2);
  assert.equal(zip.content.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(zip.content.includes(Buffer.from('src/sub/nota.txt')), 'las rutas van dentro');
  // El EOCD cierra el archivo.
  assert.ok(zip.content.includes(Buffer.from('PK\x05\x06', 'latin1')));

  // Y una entrada se puede descomprimir de verdad (valida cabeceras y CRC).
  const nombreLen = zip.content.readUInt16LE(26);
  const extraLen = zip.content.readUInt16LE(28);
  const metodo = zip.content.readUInt16LE(8);
  const compLen = zip.content.readUInt32LE(18);
  const inicio = 30 + nombreLen + extraLen;
  const datos = zip.content.subarray(inicio, inicio + compLen);
  const contenido = (metodo === 8 ? zlib.inflateRawSync(datos) : datos).toString('utf8');
  assert.ok(['console.log(1)', 'hola'].includes(contenido));

  await assert.rejects(
    () => adapter.downloadFolder('proj', 'code', 'src/index.js'),
    /NOT_A_DIRECTORY/
  );
});

test('los directorios ocultos no cuentan como ideas', async () => {
  // La carpeta de memoria es a su vez un repositorio Git: su `.git` no debe
  // aparecer como si fuera un proyecto del usuario.
  const dir = await tempDir();
  const repo = new FileSystemProjectRepository(dir);
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.mkdir(path.join(dir, '.oculto'), { recursive: true });
  await repo.save({ id: 'idea-real', name: 'idea-real', description: '', status: 'activa' });

  const all = await repo.findAll();
  assert.deepEqual(all.map((p) => p.id), ['idea-real']);
});
