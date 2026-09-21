import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateProjectUseCase } from '../../src/application/CreateProjectUseCase.js';
import { GetProjectsUseCase } from '../../src/application/GetProjectsUseCase.js';
import { GetProjectConceptualTreeUseCase } from '../../src/application/GetProjectConceptualTreeUseCase.js';
import { SaveNoteUseCase } from '../../src/application/SaveNoteUseCase.js';
import { RunOrchestratorTaskUseCase } from '../../src/application/RunOrchestratorTaskUseCase.js';
import {
  InMemoryProjectRepository,
  InMemoryNoteRepository,
  InMemoryOrchestratorAdapter
} from '../helpers/InMemoryRepositories.js';

function buildContext() {
  const projectRepository = new InMemoryProjectRepository();
  const noteRepository = new InMemoryNoteRepository();
  return {
    projectRepository,
    noteRepository,
    createProject: new CreateProjectUseCase(projectRepository, noteRepository),
    getProjects: new GetProjectsUseCase(projectRepository),
    getTree: new GetProjectConceptualTreeUseCase(noteRepository),
    saveNote: new SaveNoteUseCase(noteRepository)
  };
}

test('slugify normaliza acentos, espacios y símbolos', () => {
  assert.equal(CreateProjectUseCase.slugify('Mi Idea Genial!'), 'mi-idea-genial');
  assert.equal(CreateProjectUseCase.slugify('  Añadir  Soporte  '), 'anadir-soporte');
  assert.equal(CreateProjectUseCase.slugify('---'), '');
});

test('CreateProjectUseCase crea proyecto con notas iniciales', async () => {
  const ctx = buildContext();
  const project = await ctx.createProject.execute({ name: 'Idea Nueva' });

  assert.equal(project.id, 'idea-nueva');

  const projects = await ctx.getProjects.execute();
  assert.equal(projects.length, 1);

  const tree = await ctx.getTree.execute('idea-nueva');
  const ids = tree.map((n) => n.id).sort();
  assert.deepEqual(ids, ['_indice', 'qa-dudas']);
});

test('CreateProjectUseCase rechaza duplicados', async () => {
  const ctx = buildContext();
  await ctx.createProject.execute({ name: 'Repetida' });
  await assert.rejects(() => ctx.createProject.execute({ name: 'Repetida' }), /ALREADY_EXISTS/);
});

test('CreateProjectUseCase exige un identificador válido', async () => {
  const ctx = buildContext();
  await assert.rejects(() => ctx.createProject.execute({ name: '!!!' }), /PROJECT_ID_REQUIRED/);
});

test('SaveNoteUseCase guarda y recupera una nota', async () => {
  const ctx = buildContext();
  await ctx.createProject.execute({ name: 'Proyecto Notas' });

  const saved = await ctx.saveNote.execute({
    projectId: 'proyecto-notas',
    noteId: 'subidea-x',
    title: 'Subidea X',
    content: 'Enlaza con [[_indice]].',
    frontmatter: { status: 'activa' }
  });

  assert.equal(saved.title, 'Subidea X');
  assert.deepEqual(saved.wikilinks, ['_indice']);

  const fetched = await ctx.saveNote.getNote('proyecto-notas', 'subidea-x');
  assert.equal(fetched.title, 'Subidea X');
  assert.equal(fetched.frontmatter.status, 'activa');
});

test('SaveNoteUseCase devuelve null si la nota no existe', async () => {
  const ctx = buildContext();
  const missing = await ctx.saveNote.getNote('no-existe', 'tampoco');
  assert.equal(missing, null);
});

test('SaveNoteUseCase exige projectId y noteId', async () => {
  const ctx = buildContext();
  await assert.rejects(() => ctx.saveNote.execute({ noteId: 'n' }), /PROJECT_ID_REQUIRED/);
  await assert.rejects(() => ctx.saveNote.execute({ projectId: 'p' }), /NOTE_ID_REQUIRED/);
});

test('RunOrchestratorTaskUseCase delega en el puerto de orquestación', async () => {
  const adapter = new InMemoryOrchestratorAdapter();
  const useCase = new RunOrchestratorTaskUseCase(adapter);

  const result = await useCase.execute('proyecto', 'genera los tests');
  assert.equal(result.success, true);
  assert.deepEqual(adapter.calls, [{ projectId: 'proyecto', instruction: 'genera los tests' }]);
});

test('RunOrchestratorTaskUseCase valida la entrada', async () => {
  const useCase = new RunOrchestratorTaskUseCase(new InMemoryOrchestratorAdapter());
  await assert.rejects(() => useCase.execute('', 'algo'), /required/);
  await assert.rejects(() => useCase.execute('p', ''), /required/);
});
