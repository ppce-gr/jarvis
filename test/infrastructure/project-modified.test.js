import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemProjectRepository } from '../../src/infrastructure/persistence/FileSystemProjectRepository.js';

test('findById devuelve la fecha del fichero más reciente de la idea', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-proj-'));
  const idea = path.join(dir, 'idea-a');
  await fs.mkdir(path.join(idea, 'conceptual'), { recursive: true });
  await fs.mkdir(path.join(idea, 'code'), { recursive: true });

  const viejo = new Date('2020-01-01T00:00:00Z');
  const nuevo = new Date('2024-06-01T00:00:00Z');
  await fs.writeFile(path.join(idea, 'README.md'), 'hola', 'utf8');
  await fs.utimes(path.join(idea, 'README.md'), viejo, viejo);
  await fs.writeFile(path.join(idea, 'conceptual', 'nota.md'), 'x', 'utf8');
  await fs.utimes(path.join(idea, 'conceptual', 'nota.md'), nuevo, nuevo);

  const repo = new FileSystemProjectRepository(dir);
  const project = await repo.findById('idea-a');

  assert.ok(project, 'existe la idea');
  assert.ok(project.modifiedAt instanceof Date, 'trae modifiedAt');
  assert.equal(project.modifiedAt.toISOString(), nuevo.toISOString(), 'manda el fichero más reciente');
});
