import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Note } from '../../src/domain/Note.js';

test('Note exige id y projectId', () => {
  assert.throws(() => new Note({ id: '', projectId: 'p' }), /required/);
  assert.throws(() => new Note({ id: 'n', projectId: '' }), /required/);
});

test('Note usa el id como título por defecto', () => {
  const note = new Note({ id: 'subidea-1', projectId: 'proyecto' });
  assert.equal(note.title, 'subidea-1');
});

test('extractWikilinks detecta enlaces internos únicos', () => {
  const note = new Note({
    id: 'indice',
    projectId: 'p',
    content: 'Ver [[subidea-1]] y [[subidea-2]] y otra vez [[subidea-1]].'
  });
  assert.deepEqual(note.extractWikilinks(), ['subidea-1', 'subidea-2']);
});

test('extractWikilinks ignora ejemplos dentro de código', () => {
  const note = new Note({
    id: 'qa',
    projectId: 'p',
    content: [
      'Enlace real: [[real]]',
      'Ejemplo en línea: `[[no-real]]`',
      '```',
      '[[tampoco-real]]',
      '```'
    ].join('\n')
  });
  assert.deepEqual(note.extractWikilinks(), ['real']);
});

test('extractWikilinks devuelve lista vacía sin enlaces', () => {
  const note = new Note({ id: 'n', projectId: 'p', content: 'Sin enlaces.' });
  assert.deepEqual(note.extractWikilinks(), []);
});
