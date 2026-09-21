/* ============================================================
   Jarvis · Centro de Mando — lógica de interfaz
   ------------------------------------------------------------
   JavaScript vainilla, sin dependencias ni CDN: la interfaz debe
   funcionar en la red local aunque la Raspberry no tenga internet.
   Todo el render ocurre en el navegador (móvil/PC), no en la Pi.
   ============================================================ */

const state = {
  projects: [],
  currentProjectId: null,
  notes: [],
  currentNoteId: null,
  currentNote: null,
  zone: [],
  editing: false
};

/* ---------------- Utilidades DOM ---------------- */
const $ = (sel) => document.querySelector(sel);

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- Renderizador Markdown mínimo ----------------
   No reinventamos la rueda con un parser completo: cubrimos lo que
   usamos de verdad (títulos, listas, código, negritas, enlaces y
   wikilinks) en ~40 líneas, sin dependencias externas.            */
function renderMarkdown(md = '') {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inCode = false;
  let inList = false;
  let inQuote = false;

  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };

  const inline = (text) => {
    let out = escapeHtml(text);
    // Wikilinks [[nota]] -> enlace interno
    out = out.replace(/\[\[(.+?)\]\]/g, (_m, name) => {
      const id = name.trim();
      const exists = state.notes.some((n) => n.id === id);
      const cls = exists ? 'wikilink' : 'wikilink missing';
      return `<a class="${cls}" data-note="${escapeHtml(id)}">${escapeHtml(id)}</a>`;
    });
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out;
  };

  for (const raw of lines) {
    const line = raw;

    if (line.trim().startsWith('```')) {
      closeList(); closeQuote();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += escapeHtml(line) + '\n'; continue; }

    if (/^\s*$/.test(line)) { closeList(); closeQuote(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList(); closeQuote();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += `<p>${inline(line.replace(/^>\s?/, ''))}</p>`;
      continue;
    }
    closeQuote();

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      const item = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
      html += `<li>${inline(item)}</li>`;
      continue;
    }
    closeList();

    if (/^---+$/.test(line.trim())) { html += '<hr />'; continue; }

    html += `<p>${inline(line)}</p>`;
  }

  closeList(); closeQuote();
  if (inCode) html += '</code></pre>';
  return html;
}

/* ---------------- Carga de datos ---------------- */
async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  renderProjectList();
}

function renderProjectList() {
  const ul = $('#project-list');
  ul.innerHTML = '';
  if (!state.projects.length) {
    ul.innerHTML = '<li class="muted" style="cursor:default">Sin ideas todavía</li>';
    return;
  }
  for (const project of state.projects) {
    const li = document.createElement('li');
    li.dataset.id = project.id;
    if (project.id === state.currentProjectId) li.classList.add('active');
    li.innerHTML = `<span class="ico">📁</span><span>${escapeHtml(project.id)}</span>`;
    li.addEventListener('click', () => selectProject(project.id));
    ul.appendChild(li);
  }
}

async function selectProject(projectId) {
  state.currentProjectId = projectId;
  state.currentNoteId = null;
  state.currentNote = null;
  state.editing = false;
  $('#current-project-label').textContent = projectId;
  renderProjectList();
  closeMobileSidebar();
  await loadNotes();
  await Promise.all([loadZone('code'), loadZone('logs')]);
  switchTab('conceptual');
  showEmptyConceptual();
}

async function loadNotes() {
  if (!state.currentProjectId) return;
  const { notes } = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/conceptual`);
  state.notes = notes;
  renderNoteList();
}

function renderNoteList() {
  const ul = $('#note-list');
  ul.innerHTML = '';
  if (!state.currentProjectId) {
    ul.innerHTML = '<li class="muted" style="cursor:default">Elige un proyecto</li>';
    return;
  }
  if (!state.notes.length) {
    ul.innerHTML = '<li class="muted" style="cursor:default">Sin notas</li>';
    return;
  }
  for (const note of state.notes) {
    const li = document.createElement('li');
    if (note.id === state.currentNoteId) li.classList.add('active');
    li.innerHTML = `<span class="ico">📝</span><span>${escapeHtml(note.title || note.id)}</span>`;
    li.addEventListener('click', () => openNote(note.id));
    ul.appendChild(li);
  }
}

/* ---------------- Notas conceptuales ---------------- */
function showEmptyConceptual() {
  state.currentNote = null;
  state.currentNoteId = null;
  state.editing = false;
  $('#note-header').classList.add('hidden');
  $('#markdown-editor').classList.add('hidden');
  $('#markdown-view').classList.remove('hidden');
  $('#save-note-btn').classList.add('hidden');
  $('#edit-toggle').classList.remove('hidden');
  $('#edit-toggle').textContent = '✎ Editar';
  $('#markdown-view').innerHTML = state.currentProjectId
    ? `<h2>${escapeHtml(state.currentProjectId)}</h2><p class="muted">Selecciona una nota conceptual o crea una nueva.</p>`
    : `<div class="empty-state"><h2>Bienvenido a Jarvis</h2><p>Selecciona una idea en el panel izquierdo o crea una nueva con <strong>+ Idea</strong>.</p></div>`;
  renderNoteList();
}

async function openNote(noteId) {
  if (!state.currentProjectId) return;
  const { note } = await api(
    `/api/projects/${encodeURIComponent(state.currentProjectId)}/conceptual/${encodeURIComponent(noteId)}`
  );
  state.currentNote = note;
  state.currentNoteId = noteId;
  state.editing = false;

  $('#note-header').classList.remove('hidden');
  $('#note-title-view').textContent = note.title || note.id;
  const tags = Object.entries(note.frontmatter || {})
    .filter(([k]) => k !== 'title')
    .map(([k, v]) => `<span class="tag">${escapeHtml(k)}: ${escapeHtml(v)}</span>`)
    .join('');
  $('#note-tags').innerHTML = tags;

  $('#markdown-view').innerHTML = renderMarkdown(note.content || '');
  $('#markdown-editor').value = note.content || '';
  setEditing(false);
  renderNoteList();
  switchTab('conceptual');
  closeMobileSidebar();
}

function setEditing(on) {
  state.editing = on;
  $('#markdown-view').classList.toggle('hidden', on);
  $('#markdown-editor').classList.toggle('hidden', !on);
  $('#save-note-btn').classList.toggle('hidden', !on);
  $('#edit-toggle').textContent = on ? '👁 Ver' : '✎ Editar';
}

async function saveNote() {
  if (!state.currentNoteId || !state.currentProjectId) return;
  const content = $('#markdown-editor').value;
  try {
    await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/conceptual/${encodeURIComponent(state.currentNoteId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          title: state.currentNote?.title || state.currentNoteId,
          content,
          frontmatter: state.currentNote?.frontmatter || {}
        })
      }
    );
    toast('Nota guardada', 'ok');
    const keepId = state.currentNoteId;
    await loadNotes();
    await openNote(keepId);
  } catch (error) {
    toast(`Error al guardar: ${error.message}`, 'err');
  }
}

/* ---------------- Explorador code/ y logs/ ---------------- */
async function loadZone(zone) {
  if (!state.currentProjectId) return;
  try {
    const { files } = await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/files?zone=${zone}`
    );
    const ul = zone === 'code' ? $('#code-file-list') : $('#logs-file-list');
    ul.innerHTML = '';
    if (!files.length) {
      ul.innerHTML = '<li class="muted" style="cursor:default">Vacío por ahora</li>';
      return;
    }
    for (const f of files) {
      const li = document.createElement('li');
      li.textContent = f.type === 'dir' ? `📂 ${f.path}` : `📄 ${f.path}`;
      if (f.type === 'dir') li.classList.add('dir');
      else li.addEventListener('click', () => openZoneFile(zone, f.path, li));
      ul.appendChild(li);
    }
  } catch (error) {
    toast(`No se pudo listar ${zone}: ${error.message}`, 'err');
  }
}

async function openZoneFile(zone, filePath, li) {
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/files/content?zone=${zone}&path=${encodeURIComponent(filePath)}`
    );
    const view = zone === 'code' ? $('#code-file-view') : $('#logs-file-view');
    view.textContent = data.content || '(vacío)';
    li.parentElement.querySelectorAll('li').forEach((n) => n.classList.remove('active'));
    li.classList.add('active');
  } catch (error) {
    toast(`No se pudo abrir: ${error.message}`, 'err');
  }
}

/* ---------------- Pestañas ---------------- */
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#pane-conceptual').classList.toggle('hidden', tab !== 'conceptual');
  $('#pane-code').classList.toggle('hidden', tab !== 'code');
  $('#pane-logs').classList.toggle('hidden', tab !== 'logs');
  $('#edit-toggle').classList.toggle('hidden', tab !== 'conceptual' || !state.currentNoteId);
}

/* ---------------- Git ---------------- */
async function refreshGitStatus() {
  try {
    const { git } = await api('/api/git/status');
    const el = $('#git-status');
    if (!git.isRepository) { el.textContent = 'git · sin repo'; el.className = 'pill'; return; }
    el.textContent = git.dirty ? `git · ${git.files.length} cambios` : `git · limpio`;
    el.className = `pill ${git.dirty ? 'dirty' : 'clean'}`;
    el.title = git.files.join('\n') || 'Sin cambios pendientes';
  } catch {
    $('#git-status').textContent = 'git · n/d';
  }
}

/* ---------------- Órdenes al orquestador ---------------- */
async function sendCommand() {
  const input = $('#command-input');
  const instruction = input.value.trim();
  if (!instruction) return;
  if (!state.currentProjectId) {
    toast('Selecciona primero una idea', 'err');
    return;
  }
  const btn = $('#command-send');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const { result } = await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/orchestrate`,
      { method: 'POST', body: JSON.stringify({ instruction }) }
    );
    toast(result?.message || 'Orden enviada al orquestador', result?.success ? 'ok' : 'err');
    input.value = '';
    await Promise.all([loadZone('logs'), refreshGitStatus()]);
  } catch (error) {
    toast(`Error: ${error.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}

/* ---------------- Acciones de creación ---------------- */
async function createProject(event) {
  event.preventDefault();
  const form = event.target;
  const payload = {
    name: form.name.value.trim(),
    description: form.description.value.trim()
  };
  try {
    const { project } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    $('#new-project-dialog').close();
    form.reset();
    await loadProjects();
    await selectProject(project.id);
    toast(`Idea "${project.id}" creada`, 'ok');
  } catch (error) {
    toast(`Error: ${error.message}`, 'err');
  }
}

async function createNote(event) {
  event.preventDefault();
  if (!state.currentProjectId) return;
  const form = event.target;
  const noteId = form.noteId.value.trim().replace(/\s+/g, '-').toLowerCase();
  const title = form.title.value.trim() || noteId;
  try {
    await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/conceptual/${encodeURIComponent(noteId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          title,
          content: `# ${title}\n\n## Subideas\n\n- [[_indice]]\n`,
          frontmatter: { title, status: 'activa' }
        })
      }
    );
    $('#new-note-dialog').close();
    form.reset();
    await loadNotes();
    await openNote(noteId);
    toast('Nota creada', 'ok');
  } catch (error) {
    toast(`Error: ${error.message}`, 'err');
  }
}

/* ---------------- UI móvil ---------------- */
function closeMobileSidebar() {
  $('#sidebar').classList.remove('open');
}

/* ---------------- Arranque ---------------- */
function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Enlaces internos de las notas renderizadas
  $('#markdown-view').addEventListener('click', (event) => {
    const link = event.target.closest('[data-note]');
    if (link) openNote(link.dataset.note);
  });

  $('#edit-toggle').addEventListener('click', () => setEditing(!state.editing));
  $('#save-note-btn').addEventListener('click', saveNote);

  // Atajo: Ctrl/Cmd + S guarda
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (state.editing) saveNote();
    }
  });

  $('#new-project-btn').addEventListener('click', () => $('#new-project-dialog').showModal());
  $('#new-note-btn').addEventListener('click', () => {
    if (!state.currentProjectId) return toast('Selecciona primero una idea', 'err');
    $('#new-note-dialog').showModal();
  });
  $('#new-project-form').addEventListener('submit', createProject);
  $('#new-note-form').addEventListener('submit', createNote);

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  $('#command-send').addEventListener('click', sendCommand);
  $('#command-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendCommand();
  });

  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
}

async function boot() {
  bindEvents();
  try {
    await loadProjects();
    await refreshGitStatus();
    setInterval(refreshGitStatus, 30000);
  } catch (error) {
    toast(`No se pudo conectar con Jarvis Core: ${error.message}`, 'err');
  }
}

boot();
