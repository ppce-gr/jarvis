/* ============================================================
   Jarvis · Centro de Mando — lógica de interfaz
   ------------------------------------------------------------
   JavaScript vainilla, sin dependencias ni CDN: la interfaz debe
   funcionar en la red local aunque la Raspberry no tenga internet.
   Todo el render ocurre en el navegador (móvil/PC), no en la Pi.
   ============================================================ */

const state = {
  view: 'home',
  projects: [],
  currentProjectId: null,
  notes: [],
  currentNoteId: null,
  currentNote: null,
  zone: [],
  editing: false,
  chat: { projectId: null, source: null, messages: [], busy: false, streaming: '' }
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

/**
 * Enlaza un evento SÓLO si el elemento existe. Si falta, avisa por consola y
 * sigue con lo demás: antes, un elemento ausente lanzaba una excepción dentro
 * de bindEvents y dejaba la aplicación ENTERA sin pintar (sin ideas, sin nada),
 * que es el fallo más difícil de diagnosticar que puede haber.
 */
function on(selector, evento, manejador) {
  const el = $(selector);
  if (!el) {
    console.warn(`[jarvis] elemento no encontrado, se omite: ${selector}`);
    return null;
  }
  el.addEventListener(evento, manejador);
  return el;
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
  state.projects = Array.isArray(projects) ? projects : [];
  renderIdeaGrid();
}

/* ---------------- Vistas: inicio e idea ---------------- */
function showHome() {
  state.view = 'home';
  const home = $('#view-home');
  const idea = $('#view-idea');
  if (home) home.classList.remove('hidden');
  if (idea) idea.classList.add('hidden');
  const menu = $('#menu-toggle');
  if (menu) menu.classList.add('hidden');
  renderIdeaGrid();
}

function showIdea() {
  state.view = 'idea';
  const home = $('#view-home');
  const idea = $('#view-idea');
  if (home) home.classList.add('hidden');
  if (idea) idea.classList.remove('hidden');
  const menu = $('#menu-toggle');
  if (menu) menu.classList.remove('hidden');
}

async function goHome() {
  closeChat();
  state.currentProjectId = null;
  state.currentNoteId = null;
  state.currentNote = null;
  state.editing = false;
  showHome();
  await loadProjects();
}

/* ---------------- Inicio: tarjetas de ideas (tipo Obsidian) ---------------- */
function renderIdeaGrid() {
  const grid = $('#idea-grid');
  if (!grid) return;
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const empty = $('#home-empty');
  if (empty) {
    if (projects.length) empty.classList.add('hidden');
    else {
      empty.classList.remove('hidden');
      empty.innerHTML = '<h2>Sin ideas todavía</h2><p>Crea la primera con <strong>+ Nueva idea</strong>.</p>';
    }
  }

  grid.innerHTML = '';
  for (const project of projects) {
    const inicial = (project.name || project.id || '?').trim().charAt(0).toUpperCase() || '?';
    const desc = (project.description || '').trim();
    const card = document.createElement('article');
    card.className = 'idea-card';
    card.dataset.id = project.id;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.innerHTML =
      `<div class="idea-card-mark">${escapeHtml(inicial)}</div>`
      + `<h3 class="idea-card-title">${escapeHtml(project.name || project.id)}</h3>`
      + `<p class="idea-card-desc">${desc ? escapeHtml(desc.slice(0, 180)) : '<span class="muted">Sin descripción todavía</span>'}</p>`
      + `<div class="idea-card-foot"><span class="idea-card-tag">${escapeHtml(project.status || 'idea')}</span><span class="idea-card-arrow" aria-hidden="true">→</span></div>`;
    const abrir = () => selectProject(project.id);
    card.addEventListener('click', abrir);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); abrir(); }
    });
    grid.appendChild(card);
  }

  // Tarjeta de nueva idea: el acceso a crear está siempre a la vista.
  const nueva = document.createElement('button');
  nueva.type = 'button';
  nueva.className = 'idea-card idea-card-new';
  nueva.innerHTML = '<span class="idea-card-new-plus" aria-hidden="true">＋</span><span>Nueva idea</span>';
  nueva.addEventListener('click', abrirNuevaIdea);
  grid.appendChild(nueva);
}

async function selectProject(projectId) {
  state.currentProjectId = projectId;
  state.currentNoteId = null;
  state.currentNote = null;
  state.editing = false;
  const project = state.projects.find((p) => p.id === projectId);
  const titulo = $('#idea-title');
  if (titulo) titulo.textContent = project?.name || projectId;
  const desc = $('#idea-desc');
  if (desc) desc.textContent = (project?.description || '').trim().slice(0, 220);
  const label = $('#current-project-label');
  if (label) label.textContent = projectId;
  showIdea();
  closeMobileSidebar();
  await loadNotes();
  await Promise.all([loadZone('code'), loadZone('logs')]);
  switchTab('chat');
  showEmptyConceptual();
  await refreshTaskStatus();
  openChat(projectId);
}

async function loadNotes() {
  if (!state.currentProjectId) return;
  const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/conceptual`);
  // Si el servidor devolviera algo inesperado, no se debe romper el render.
  state.notes = Array.isArray(data.notes) ? data.notes : [];
  if (data.error) toast(`No se pudieron leer las notas: ${data.error}`, 'err');
  renderNoteList();
  actualizarBadges();
}

function renderNoteList() {
  const ul = $('#note-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (!Array.isArray(state.notes)) state.notes = [];
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
  const pista = window.matchMedia('(max-width: 820px)').matches
    ? 'Pulsa <strong>☰</strong> arriba a la izquierda para ver tus ideas.'
    : 'Selecciona una idea en el panel izquierdo.';
  $('#markdown-view').innerHTML = state.currentProjectId
    ? `<h2>${escapeHtml(state.currentProjectId)}</h2><p class="muted">Selecciona una nota conceptual o crea una nueva.</p>`
    : state.projects.length
      ? `<div class="empty-state"><h2>Elige una idea</h2><p>${pista}</p></div>`
      : `<div class="empty-state"><h2>Bienvenido a Jarvis</h2><p>Todavía no hay ideas. Crea la primera con <strong>+ Idea</strong>, arriba a la derecha.</p></div>`;
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

/* ================================================================
   Seguimiento: preguntas y puntos clave
   ----------------------------------------------------------------
   El agente mantiene dos notas en `conceptual/` con listas de casillas:

     - [x] Elemento registrado (decisión tomada)
     - [ ] Elemento pendiente de que el usuario decida

   La interfaz las lee, deja resolver las pendientes (guardar o borrar) y
   avisa con un «!» en la pestaña mientras queden pendientes.
   ================================================================ */
const SEGUIMIENTO = {
  preguntas: { nota: 'preguntas', titulo: 'Preguntas' },
  clave: { nota: 'puntos-clave', titulo: 'Puntos clave' }
};

/** Separa el contenido de una nota en casillas registradas y pendientes. */
function parseChecklist(md = '') {
  const registrados = [];
  const pendientes = [];
  String(md).split('\n').forEach((line, linea) => {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/);
    if (!m) return;
    const item = { texto: m[2], linea };
    if (m[1].toLowerCase() === 'x') registrados.push(item);
    else pendientes.push(item);
  });
  return { registrados, pendientes };
}

function notaDeSeguimiento(tipo) {
  const cfg = SEGUIMIENTO[tipo];
  if (!cfg) return null;
  return (state.notes || []).find((n) => n && n.id === cfg.nota) || null;
}

/** Cuenta las pendientes de un tipo («!» en la pestaña). */
function pendientesDe(tipo) {
  return parseChecklist(notaDeSeguimiento(tipo)?.content || '').pendientes.length;
}

function actualizarBadges() {
  for (const [tipo, id] of [['preguntas', '#badge-preguntas'], ['clave', '#badge-clave']]) {
    const el = $(id);
    if (!el) continue;
    const n = pendientesDe(tipo);
    el.classList.toggle('hidden', n === 0);
    el.title = n === 0 ? '' : `${n} pendiente(s) de evaluar`;
  }
}

function renderSeguimiento(tipo) {
  const cfg = SEGUIMIENTO[tipo];
  const cont = $(tipo === 'preguntas' ? '#preguntas-list' : '#clave-list');
  if (!cont || !cfg) return;
  const nota = notaDeSeguimiento(tipo);
  if (!nota) {
    cont.innerHTML = `<div class="empty-state"><h2>Sin ${cfg.titulo.toLowerCase()} todavía</h2>`
      + '<p class="muted">Jarvis irá anotando aquí lo que merezca quedar registrado. '
      + `También puedes crear la nota <code>${cfg.nota}.md</code> en <code>conceptual/</code> `
      + 'con listas <code>- [x]</code> (registrado) y <code>- [ ]</code> (pendiente).</p></div>';
    return;
  }
  const { registrados, pendientes } = parseChecklist(nota.content);
  let html = '';

  if (pendientes.length) {
    html += `<div class="seg-grupo"><h3>Pendientes de evaluar <span class="seg-count">${pendientes.length}</span></h3>`
      + pendientes.map((it) => `
        <div class="seg-item seg-pendiente">
          <span class="seg-texto">${escapeHtml(it.texto)}</span>
          <span class="seg-acciones">
            <button class="seg-btn seg-copy" data-seg-copiar="${escapeHtml(it.texto)}" title="Copiar">⧉</button>
            <button class="seg-btn seg-ok" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="guardar" title="Guardar (dejar de estar pendiente)">✓</button>
            <button class="seg-btn seg-del" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="borrar" data-seg-texto="${escapeHtml(it.texto)}" title="Borrar definitivamente">✕</button>
          </span>
        </div>`).join('')
      + '</div>';
  }

  if (registrados.length) {
    html += `<div class="seg-grupo"><h3>Registrados <span class="seg-count">${registrados.length}</span></h3>`
      + registrados.map((it) => `
        <div class="seg-item">
          <span class="seg-check" aria-hidden="true">✓</span>
          <span class="seg-texto">${escapeHtml(it.texto)}</span>
          <span class="seg-acciones">
            <button class="seg-btn seg-copy" data-seg-copiar="${escapeHtml(it.texto)}" title="Copiar">⧉</button>
            <button class="seg-btn seg-ir" data-seg-conv="${escapeHtml(it.texto)}" title="Ver en la conversación">↗</button>
            <button class="seg-btn seg-del" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="borrar" data-seg-texto="${escapeHtml(it.texto)}" title="Borrar definitivamente">✕</button>
          </span>
        </div>`).join('')
      + '</div>';
  }

  cont.innerHTML = html || '<div class="empty-state"><p class="muted">Sin elementos todavía.</p></div>';
}

/** Guarda o borra una línea pendiente reescribiendo la nota. */
async function resolverSeguimiento(tipo, linea, accion) {
  const cfg = SEGUIMIENTO[tipo];
  const nota = notaDeSeguimiento(tipo);
  if (!cfg || !nota || !state.currentProjectId) return;
  const lineas = String(nota.content || '').split('\n');
  const i = Number(linea);
  if (!Number.isInteger(i) || i < 0 || i >= lineas.length) return;

  if (accion === 'guardar') lineas[i] = lineas[i].replace(/\[(\s*)\]/, '[x]');
  else if (accion === 'borrar') lineas.splice(i, 1);
  else return;

  try {
    await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/conceptual/${encodeURIComponent(cfg.nota)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          title: nota.title || cfg.titulo,
          content: lineas.join('\n'),
          frontmatter: nota.frontmatter || {}
        })
      }
    );
    await loadNotes();
    renderSeguimiento(tipo);
  } catch (error) {
    toast(`No se pudo actualizar: ${error.message}`, 'err');
  }
}

/** Elemento pendiente de confirmar para borrar: `{ tipo, linea }`. */
let borradoPendiente = null;

/** Pide confirmación antes de borrar una pregunta o un punto clave. */
function pedirBorrado(tipo, linea, texto) {
  borradoPendiente = { tipo, linea };
  const resumen = $('#borrar-texto');
  if (resumen) {
    resumen.textContent = texto
      ? `Se borrará «${texto}». Esta acción no se puede deshacer.`
      : 'Esta acción no se puede deshacer.';
  }
  const dialog = $('#borrar-dialog');
  if (dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
    return;
  }
  // Red de seguridad si faltara el diálogo.
  if (typeof window.confirm === 'function'
    && window.confirm(`¿Borrar${texto ? ` «${texto}»` : ''}?`)) {
    confirmarBorrado();
  }
}

/** Confirma el borrado que estaba pendiente y reescribe la nota. */
async function confirmarBorrado() {
  const pendiente = borradoPendiente;
  borradoPendiente = null;
  const dialog = $('#borrar-dialog');
  if (dialog) dialog.close();
  if (pendiente) await resolverSeguimiento(pendiente.tipo, pendiente.linea, 'borrar');
}

/** Clic en el seguimiento: resolver una pendiente o saltar a la conversación. */
function manejarSeguimiento(event) {
  const copiar = event.target.closest('[data-seg-copiar]');
  if (copiar) { copiarTexto(copiar.dataset.segCopiar); return; }
  const ir = event.target.closest('[data-seg-conv]');
  if (ir) { irAConversacion(ir.dataset.segConv); return; }
  const btn = event.target.closest('[data-seg-accion]');
  if (!btn) return;
  // Borrar siempre pide confirmación.
  if (btn.dataset.segAccion === 'borrar') {
    pedirBorrado(btn.dataset.segTipo, btn.dataset.segLinea, btn.dataset.segTexto || '');
    return;
  }
  resolverSeguimiento(btn.dataset.segTipo, btn.dataset.segLinea, btn.dataset.segAccion);
}

/** Salta al turno de la conversación que contiene ese texto. */
function irAConversacion(texto) {
  switchTab('chat');
  const clave = String(texto).toLowerCase().replace(/[¿?¡!.,;:()"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  const box = $('#chat-messages');
  if (!clave || !box || typeof box.querySelectorAll !== 'function') return;
  const nodos = box.querySelectorAll('[data-idx]');
  for (const nodo of nodos) {
    if (String(nodo.textContent || '').toLowerCase().replace(/\s+/g, ' ').includes(clave)) {
      if (typeof nodo.scrollIntoView === 'function') nodo.scrollIntoView({ block: 'center' });
      nodo.classList.add('msg-flash');
      setTimeout(() => nodo.classList.remove('msg-flash'), 1600);
      return;
    }
  }
  toast('No encuentro ese texto en la conversación', 'warn');
}

/** Recarga las notas y repinta lo que dependa de ellas (tras un turno). */
async function refrescarSeguimiento() {
  if (!state.currentProjectId) return;
  try {
    await loadNotes();
  } catch { return; }
  const activo = document.querySelector('.tab.active');
  const tab = activo?.dataset?.tab;
  if (tab === 'preguntas' || tab === 'clave') renderSeguimiento(tab);
  if (tab === 'mapa') renderMapa();
}

/* ================================================================
   Mapa mental: notas y sus wikilinks, con un pequeño motor de fuerzas
   ================================================================ */
/** Tono estable a partir de un texto: mismo texto, mismo color. */
function tono(texto) {
  let h = 0;
  for (const ch of String(texto)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** Grafo de notas: nodos = notas, aristas = wikilinks existentes. */
function construirGrafo(notes) {
  const lista = (notes || []).filter((n) => n && n.id);
  const nodos = lista.map((n) => ({ id: n.id, title: n.title || n.id, frontmatter: n.frontmatter || {}, content: n.content || '' }));
  const ids = new Set(nodos.map((n) => n.id));
  const aristas = [];
  const vistas = new Set();
  for (const n of lista) {
    for (const destino of (n.wikilinks || [])) {
      if (!ids.has(destino) || destino === n.id) continue;
      const clave = [n.id, destino].sort().join('|');
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      aristas.push({ origen: n.id, destino });
    }
  }
  return { nodos, aristas };
}

/** Color del nodo según el punto clave que menciona (o su etiqueta). */
function colorDeNodo(nodo, puntos = []) {
  const texto = `${nodo.title || ''}\n${nodo.content || ''}`.toLowerCase();
  for (const p of puntos) {
    const t = String(p).toLowerCase().trim();
    if (t && texto.includes(t)) return `hsl(${tono(t)}, 72%, 62%)`;
  }
  const tag = String(nodo.frontmatter?.tags || '').replace(/[[\]"']/g, '').split(',')[0].trim();
  if (tag) return `hsl(${tono(tag)}, 72%, 62%)`;
  return 'hsl(205, 90%, 62%)';
}

/** Coloca los nodos con repulsión + muelles (fuerzas), sin dependencias. */
function repartir(nodos, aristas, ancho, alto, ticks = 320) {
  const n = nodos.length || 1;
  nodos.forEach((nodo, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = Math.min(ancho, alto) * 0.32;
    nodo.x = ancho / 2 + Math.cos(a) * r;
    nodo.y = alto / 2 + Math.sin(a) * r;
  });
  const porId = new Map(nodos.map((x) => [x.id, x]));
  const enlaces = aristas.map((e) => ({ s: porId.get(e.origen), t: porId.get(e.destino) })).filter((l) => l.s && l.t);
  const dist = Math.min(150, 60 + nodos.length * 6);

  for (let k = 0; k < ticks; k += 1) {
    for (let i = 0; i < nodos.length; i += 1) {
      for (let j = i + 1; j < nodos.length; j += 1) {
        const a = nodos[i]; const b = nodos[j];
        const dx = a.x - b.x; const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const f = 3200 / d2;
        const fx = (dx / d) * f; const fy = (dy / d) * f;
        a.x += fx; a.y += fy; b.x -= fx; b.y -= fy;
      }
    }
    for (const l of enlaces) {
      const dx = l.t.x - l.s.x; const dy = l.t.y - l.s.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - dist) * 0.02;
      const fx = (dx / d) * f; const fy = (dy / d) * f;
      l.s.x += fx; l.s.y += fy; l.t.x -= fx; l.t.y -= fy;
    }
    for (const nodo of nodos) {
      nodo.x += (ancho / 2 - nodo.x) * 0.006;
      nodo.y += (alto / 2 - nodo.y) * 0.006;
    }
  }
  for (const nodo of nodos) {
    nodo.x = Math.max(30, Math.min(ancho - 30, nodo.x));
    nodo.y = Math.max(30, Math.min(alto - 30, nodo.y));
  }
}

function svgMapa(nodos, aristas, puntos, ancho, alto) {
  const porId = new Map(nodos.map((n) => [n.id, n]));
  const lineas = aristas.map((e) => {
    const o = porId.get(e.origen); const d = porId.get(e.destino);
    if (!o || !d) return '';
    return `<line x1="${o.x.toFixed(1)}" y1="${o.y.toFixed(1)}" x2="${d.x.toFixed(1)}" y2="${d.y.toFixed(1)}" />`;
  }).join('');
  const nodosHtml = nodos.map((nodo) => {
    const color = colorDeNodo(nodo, puntos);
    const corto = String(nodo.title || nodo.id);
    const etiqueta = corto.length > 18 ? `${corto.slice(0, 17)}…` : corto;
    return `<g class="mapa-nodo" data-nodo="${escapeHtml(nodo.id)}" transform="translate(${nodo.x.toFixed(1)},${nodo.y.toFixed(1)})">`
      + `<circle r="15" fill="${color}" />`
      + `<text y="30" text-anchor="middle">${escapeHtml(etiqueta)}</text>`
      + '</g>';
  }).join('');
  return `<svg viewBox="0 0 ${ancho} ${alto}" preserveAspectRatio="xMidYMid meet" class="mapa-svg">`
    + `<g class="mapa-lineas">${lineas}</g>${nodosHtml}</svg>`;
}

function pintarLeyenda(puntos) {
  const cont = $('#mapa-leyenda');
  if (!cont) return;
  if (!puntos.length) { cont.innerHTML = '<span class="muted">Sin puntos clave: los nodos usan su color por etiqueta.</span>'; return; }
  cont.innerHTML = '<span class="muted">Por punto clave:</span> '
    + puntos.map((p) => `<span class="leyenda-item"><span class="leyenda-punto" style="background:hsl(${tono(String(p).toLowerCase().trim())},72%,62%)"></span>${escapeHtml(p)}</span>`).join('');
}

let mapaActual = null;
let mapaDrag = null;

function renderMapa() {
  const cont = $('#mapa-graph');
  if (!cont) return;
  // Los ficheros de seguimiento no son ideas: fuera del mapa.
  const notas = (state.notes || []).filter((n) => n && n.id && n.id !== 'preguntas' && n.id !== 'puntos-clave');
  if (!notas.length) {
    cont.innerHTML = '<div class="empty-state"><p class="muted">No hay notas para dibujar todavía.</p></div>';
    const leyenda = $('#mapa-leyenda');
    if (leyenda) leyenda.innerHTML = '';
    return;
  }
  const puntos = parseChecklist(notaDeSeguimiento('clave')?.content || '').registrados.map((p) => p.texto);
  const { nodos, aristas } = construirGrafo(notas);
  const ancho = Math.max(360, cont.clientWidth || 760);
  const alto = Math.max(420, cont.clientHeight || 520);
  repartir(nodos, aristas, ancho, alto);
  mapaActual = { nodos, aristas, puntos, ancho, alto };
  cont.innerHTML = svgMapa(nodos, aristas, puntos, ancho, alto);
  pintarLeyenda(puntos);
}

function redibujarMapa() {
  const cont = $('#mapa-graph');
  if (!cont || !mapaActual) return;
  const { nodos, aristas, puntos, ancho, alto } = mapaActual;
  cont.innerHTML = svgMapa(nodos, aristas, puntos, ancho, alto);
}

function mapaPointerDown(event) {
  if (!mapaActual || !event.target?.closest) return;
  const g = event.target.closest('[data-nodo]');
  if (!g) return;
  const nodo = mapaActual.nodos.find((n) => n.id === g.dataset.nodo);
  if (!nodo) return;
  const cont = $('#mapa-graph');
  const r = cont.getBoundingClientRect();
  mapaDrag = { nodo, dx: nodo.x - (event.clientX - r.left), dy: nodo.y - (event.clientY - r.top), movido: false };
  event.preventDefault();
}

function mapaPointerMove(event) {
  if (!mapaDrag) return;
  const cont = $('#mapa-graph');
  if (!cont) return;
  const r = cont.getBoundingClientRect();
  mapaDrag.nodo.x = event.clientX - r.left + mapaDrag.dx;
  mapaDrag.nodo.y = event.clientY - r.top + mapaDrag.dy;
  mapaDrag.movido = true;
  redibujarMapa();
}

function mapaPointerUp() {
  if (!mapaDrag) return;
  const { nodo, movido } = mapaDrag;
  mapaDrag = null;
  if (!movido) { switchTab('conceptual'); openNote(nodo.id); }
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
  $('#pane-chat').classList.toggle('hidden', tab !== 'chat');
  $('#pane-conceptual').classList.toggle('hidden', tab !== 'conceptual');
  $('#pane-preguntas').classList.toggle('hidden', tab !== 'preguntas');
  $('#pane-clave').classList.toggle('hidden', tab !== 'clave');
  $('#pane-mapa').classList.toggle('hidden', tab !== 'mapa');
  $('#pane-code').classList.toggle('hidden', tab !== 'code');
  $('#pane-logs').classList.toggle('hidden', tab !== 'logs');
  $('#edit-toggle').classList.toggle('hidden', tab !== 'conceptual' || !state.currentNoteId);
  if (tab === 'logs') refreshTaskStatus();
  if (tab === 'chat') scrollChatToEnd();
  if (tab === 'preguntas' || tab === 'clave') renderSeguimiento(tab);
  if (tab === 'mapa') renderMapa();
}

/* ================================================================
   Panel de sistema: versión y actualización
   ----------------------------------------------------------------
   Aquí NO se actualiza nada. Se pide y se consulta; quien actualiza
   es systemd desde fuera del proceso, para poder revertir si el
   código nuevo no arranca.
   ================================================================ */
// Versión que cargó esta pestaña. Si el proceso se reinicia con otra (por una
// actualización), la interfaz se recarga sola para servir el código nuevo.
let versionEnEjecucion = null;

async function loadSystemStatus() {
  try {
    const st = await api('/api/system/status');
    const pill = $('#system-pill');
    // Se muestra la versión que el PROCESO tiene cargada, no la del
    // repositorio: pueden no coincidir si hay un reinicio pendiente.
    pill.textContent = st.runningCommitCorto || st.commitCorto || 'v?';
    pill.title = `Ejecutando ${st.runningCommitCorto || '?'}`
      + ` · repositorio ${st.commitCorto}`
      + (st.dirty ? ' · cambios sin commitear' : '');
    pill.classList.toggle('update', Boolean(
      st.updateRequested || st.dirty || st.reinicioPendiente
        || st.actualizadorDesfasado || st.ultimoFallo
    ));

    // Auto-refresco tras una actualización: si el proceso que responde ya no
    // es el mismo con el que se cargó la página, se recarga para no quedarse
    // con la interfaz vieja.
    const versionActual = st.runningCommitCorto || st.commitCorto || null;
    if (versionActual) {
      if (versionEnEjecucion === null) {
        versionEnEjecucion = versionActual;
      } else if (versionActual !== versionEnEjecucion) {
        versionEnEjecucion = versionActual;
        toast('Jarvis se ha actualizado; recargando la interfaz…', 'ok');
        setTimeout(() => {
          if (typeof window.location.reload === 'function') window.location.reload();
          else window.location.href = window.location.href;
        }, 1500);
      }
    }
    return st;
  } catch {
    const pill = $('#system-pill');
    if (pill) pill.textContent = 'v?';
    return null;
  }
}

function pintarSistema(st) {
  const box = $('#system-info');
  if (!st) { box.textContent = 'No se pudo leer el estado.'; return; }

  const fila = (clave, valor, clase = '') =>
    `<div class="fila"><span class="clave">${clave}</span><span class="valor ${clase}">${valor}</span></div>`;

  let html = '';
  html += fila('Ejecutando', st.runningCommitCorto || '(desconocido)');
  html += fila('Repositorio', st.commitCorto || '—');
  html += fila('Rama', st.branch || '—');
  html += fila('Árbol de trabajo',
    st.dirty ? 'con cambios sin commitear' : 'limpio',
    st.dirty ? 'aviso' : 'bien');
  html += fila('Último commit bueno', st.lastGoodCorto || '(aún ninguno)');
  html += fila('Actualización pedida', st.updateRequested ? 'sí, en curso' : 'no',
    st.updateRequested ? 'aviso' : '');
  if (st.actualizadorComprobado) {
    html += fila('Actualizador instalado',
      st.actualizadorDesfasado ? 'desfasado' : 'al día',
      st.actualizadorDesfasado ? 'aviso' : 'bien');
  }

  if (st.actualizadorDesfasado) {
    html += `<div class="fila aviso">El actualizador instalado no coincide con el del
      repositorio. No puede actualizarse solo, porque systemd ejecuta una copia de root.
      Ponlo al día con <code>sudo bash deploy/instalar.sh --autoupdate</code>.</div>`;
  }

  if (st.reinicioPendiente) {
    html += `<div class="fila aviso">Hay código más nuevo en el repositorio
      (${st.commitCorto}) pero este proceso sigue ejecutando
      ${st.runningCommitCorto}. Reinicia el servicio para aplicarlo.</div>`;
  }
  if (st.dirty) {
    html += `<div class="fila aviso">No se puede actualizar con cambios sin commitear:
      el actualizador se negaría por seguridad.</div>`;
  }
  if (st.ultimoFallo) {
    const f = st.ultimoFallo;
    html += `<div class="fila aviso">La última actualización FALLÓ en la fase
      «${escapeHtml(f.fase || 'desconocida')}»: ${escapeHtml(f.mensaje || '')}
      ${f.revertido ? `Se volvió a ${escapeHtml(f.commitRevertidoCorto || '?')}.` : ''}
      ${f.servicioVivo ? 'El servicio quedó funcionando.' : '⚠ El servicio NO quedó funcionando.'}</div>`;
    if (f.extracto) {
      html += `<div class="fila"><span class="clave">Detalle del fallo (${escapeHtml(f.commitIntentadoCorto || '?')})</span></div>`
        + `<pre>${escapeHtml(f.extracto)}</pre>`;
    }
  }
  if (st.lastRun) {
    html += `<div class="fila"><span class="clave">Última ejecución</span></div><pre>${escapeHtml(st.lastRun)}</pre>`;
  }
  box.innerHTML = html;
}

async function abrirSistema() {
  $('#system-info').textContent = 'Cargando…';
  $('#system-dialog').showModal();
  pintarSistema(await loadSystemStatus());
}

async function pedirActualizacion() {
  const boton = $('#system-update');
  boton.disabled = true;
  boton.textContent = 'Pidiendo…';
  try {
    await api('/api/system/update', { method: 'POST' });
    toast('Actualización pedida. Systemd la ejecutará y, si algo falla, revertirá sola.', 'ok');
    pintarSistema(await loadSystemStatus());
  } catch (error) {
    toast(`No se pudo pedir: ${error.message}`, 'err');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Actualizar';
  }
}

async function buscarNovedades() {
  const boton = $('#system-check');
  boton.disabled = true;
  boton.textContent = 'Buscando…';
  try {
    const r = await api('/api/system/check', { method: 'POST' });
    if (r.error) toast(r.error, 'err');
    // El orden importa: "por delante" NO es una divergencia, y decir "ya estás
    // en la última versión" ocultaría que hay commits locales sin respaldar.
    else if (r.relacion === 'divergido') toast(`Aviso: ${r.aviso}`, 'err');
    else if (r.pendienteDeSubir > 0) {
      toast(`${r.pendienteDeSubir} commit(s) locales sin subir: se respaldarán al actualizar`, 'warn');
    }
    else if (!r.hayNovedades) toast('Ya estás en la última versión', 'ok');
    else if (r.fastForward) toast(`Hay novedades: ${r.actual} → ${r.remoto}`, 'ok');
    else toast(`Aviso: ${r.aviso || 'situación inesperada de las ramas'}`, 'err');
  } catch (error) {
    toast(`Error: ${error.message}`, 'err');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Buscar novedades';
  }
}

/* ================================================================
   Chat conversacional (fase conceptual)
   ----------------------------------------------------------------
   Transporte: Server-Sent Events. El servidor empuja lo que ocurre
   en la conversación; aquí sólo pintamos. La memoria del agente vive
   en el proceso de DSH; el historial que ves viene del disco.
   ================================================================ */

async function openChat(projectId) {
  closeChat();
  state.chat.projectId = projectId;
  state.chat.messages = [];
  state.chat.streaming = '';
  renderChat();

  await resyncChat();
  loadChatConfig();

  // Stream en vivo. EventSource reconecta solo si se cae la conexión.
  const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/chat/stream`);
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleChatEvent(payload);
  };
  // Al (re)conectar se vuelve a leer el estado real del servidor: así no se
  // pierde nada de lo ocurrido mientras el móvil estuvo desconectado.
  source.onopen = () => { resyncChat(); };
  state.chat.source = source;
}

/**
 * Vuelve a leer historial y estado del servidor. Es la garantía de «si sales
 * y vuelves, todo está donde debe»: los eventos SSE no se reenvían, así que
 * la única fuente fiable tras una desconexión es el disco.
 */
async function resyncChat() {
  if (!state.chat.projectId) return;
  const projectId = state.chat.projectId;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/chat`);
    if (state.chat.projectId !== projectId) return;   // cambió de proyecto entretanto
    state.chat.messages = data.messages || [];
    state.chat.streaming = '';
    removeStreamingBubble();
    setChatStatus(data.status?.status || 'idle');
    renderChat();
  } catch (error) {
    // Sin conexión: se conserva lo que ya había en pantalla.
  }
}

/* ---------------- Selector de modelo y esfuerzo ---------------- */
async function loadChatConfig() {
  if (!state.chat.projectId) return;
  const btn = $('#chat-model-btn');
  const effortSel = $('#chat-effort');
  if (btn) btn.classList.add('loading');
  try {
    const config = await api(
      `/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/config`
    );
    renderModelPicker(config.options, config.current);
    fillSimpleSelect(effortSel, config.options, 'reasoning_effort', config.current);
    // Si ya hay una comprobación global en marcha, se sigue su avance.
    setRefreshing(Boolean(config.health?.checking));
    if (config.health?.checking) programarSondeoAdmin();
    if (config.current?.error) toast(`Aviso del motor: ${config.current.error}`, 'err');
  } catch {
    // Sin conexión: se conserva lo que ya había en pantalla.
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

/** Icono, nota y pista de un modelo según su estado de salud. */
function modelStatusInfo(item) {
  const status = item?.health?.status || 'unknown';
  if (status === 'ok') return { icon: '🟢', nota: '', title: 'Se puede usar' };
  if (status === 'quota') {
    return { icon: '🟡', nota: 'sin cuota', title: 'Sin cuota: podrá usarse cuando se restablezca' };
  }
  if (status === 'broken') {
    return { icon: '🔴', nota: 'no funciona', title: item?.health?.error || 'No funciona' };
  }
  return { icon: '⚪', nota: 'sin comprobar', title: 'Sin comprobar' };
}

/**
 * Pista que ve el ratón al pasar por encima: el nombre COMPLETO del modelo y su
 * estado. En pantalla el nombre puede quedar recortado con puntos suspensivos
 * (la fila es una rejilla y el menú tiene ancho máximo), así que la pista es el
 * único sitio donde se lee entero.
 */
function modelTooltip(item) {
  const nombre = item?.name || item?.value || '';
  return `${nombre} - ${modelStatusInfo(item).title}`;
}

/**
 * Un modelo es "disponible" si funciona o sólo está sin cuota. Los que no
 * están confirmados cuentan como no disponibles: no sabemos si funcionan.
 */
function esModeloDisponible(item) {
  const status = item?.health?.status || 'unknown';
  return status === 'ok' || status === 'quota';
}

/** Pinta la etiqueta del botón y el menú de modelos. */
function renderModelPicker(options, current) {
  const opt = (options || []).find((o) => o.id === 'model' || o.category === 'model');
  const grupos = (opt?.options || []).filter((g) => Array.isArray(g.options));
  const seleccionado = current?.model || null;

  const item = buscarModelo(grupos, seleccionado);
  const label = $('#chat-model-label');
  if (label) {
    label.textContent = item
      ? `${modelStatusInfo(item).icon} ${item.name || item.value}`
      : (current?.modelName || 'Elegir modelo…');
  }
  // La pista del botón cerrado: mismo formato que las filas, para que el
  // modelo elegido (que en pantalla puede ir recortado) se lea completo con su
  // estado sin abrir el menú.
  const btn = $('#chat-model-btn');
  if (btn && item) btn.title = modelTooltip(item);

  const menu = $('#chat-model-menu');
  if (!menu) return;
  const disponibles = grupos.filter((g) => g.options.some((i) => esModeloDisponible(i)));
  const noDisponibles = grupos.filter((g) => g.options.some((i) => !esModeloDisponible(i)));
  const html = seccionModelos('Disponibles', disponibles, false, seleccionado)
    + seccionModelos('No funcionan', noDisponibles, true, seleccionado);
  menu.innerHTML = html || '<div class="model-empty">Sin modelos que mostrar</div>';
}

function buscarModelo(grupos, value) {
  for (const grupo of grupos) {
    const encontrado = (grupo.options || []).find((i) => i.value === value);
    if (encontrado) return encontrado;
  }
  return null;
}

function seccionModelos(titulo, grupos, esNoDisponible, seleccionado) {
  const interior = grupos
    .map((g) => grupoModelosHtml(g, esNoDisponible, seleccionado))
    .join('');
  if (!interior) return '';
  return `<div class="model-section"><div class="model-section-title">${titulo}</div>${interior}</div>`;
}

function grupoModelosHtml(group, esNoDisponible, seleccionado) {
  const filas = (group.options || [])
    .filter((i) => esModeloDisponible(i) !== esNoDisponible)
    .map((i) => filaModeloHtml(i, seleccionado))
    .join('');
  if (!filas) return '';
  return `<div class="model-group"><div class="model-group-title">`
    + `${escapeHtml(group.name || group.group || '')}</div>${filas}</div>`;
}

function filaModeloHtml(item, seleccionado) {
  const info = modelStatusInfo(item);
  const flags = [];
  if (info.nota) flags.push(info.nota);
  if (item.health?.supportsEffort === false) flags.push('sin esfuerzo');
  const valor = escapeHtml(item.value);
  const nombre = escapeHtml(item.name || item.value);
  const actual = item.value === seleccionado;
  return `<div class="model-row${actual ? ' selected' : ''}" role="option" data-model="${valor}" aria-selected="${actual}" title="${escapeHtml(modelTooltip(item))}">`
    + `<span class="model-icon" aria-hidden="true">${info.icon}</span>`
    + `<span class="model-name">${nombre}</span>`
    + `<span class="model-flags">${escapeHtml(flags.join(' · '))}</span>`
    + `<button type="button" class="model-refresh" data-refresh="${valor}" title="Volver a comprobar solo este modelo" aria-label="Volver a comprobar ${nombre}">⟳</button>`
    + '</div>';
}

function fillSimpleSelect(sel, options, id, current) {
  const opt = (options || []).find((o) => o.id === id || o.category === 'thought_level');
  sel.innerHTML = '';
  // El modelo actual puede no admitir esfuerzo: en ese caso no se enseña el
  // selector, porque DSH rechazaría el parámetro.
  if (!opt?.options?.length || current?.supportsEffort === false) {
    sel.classList.add('hidden');
    return;
  }
  sel.classList.remove('hidden');
  for (const item of opt.options) {
    const o = document.createElement('option');
    o.value = item.value;
    o.textContent = item.name || item.value;
    o.title = item.description || '';
    if (item.value === current[id]) o.selected = true;
    sel.appendChild(o);
  }
}

async function saveChatConfig(configId, value) {
  if (!state.chat.projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/config`, {
      method: 'POST',
      body: JSON.stringify({ configId, value })
    });
    toast('Ajuste guardado: se aplica al siguiente mensaje', 'ok');
    // El esfuerzo disponible cambia con el modelo: hay que repintarlo.
    await loadChatConfig();
  } catch (error) {
    toast(`No se pudo guardar: ${error.message}`, 'err');
    loadChatConfig();
  }
}

/* ---------------- Desplegable de modelos ---------------- */
function toggleModelMenu(event) {
  if (event) event.stopPropagation();
  const menu = $('#chat-model-menu');
  if (!menu) return;
  const quedóOculto = menu.classList.toggle('hidden');
  const btn = $('#chat-model-btn');
  if (btn) btn.setAttribute('aria-expanded', String(quedóOculto === false));
}

function cerrarModelMenu() {
  const menu = $('#chat-model-menu');
  if (menu) menu.classList.add('hidden');
  const btn = $('#chat-model-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function manejarMenuModelos(event) {
  // El botón de refrescar de cada fila: comprueba SÓLO ese modelo.
  const botonRefresco = event.target.closest('[data-refresh]');
  if (botonRefresco) {
    event.stopPropagation();
    recargarModelo(botonRefresco.dataset.refresh, botonRefresco);
    return;
  }
  // Cualquier otro punto de la fila: elige ese modelo.
  const fila = event.target.closest('[data-model]');
  if (!fila) return;
  cerrarModelMenu();
  saveChatConfig('model', fila.dataset.model);
}

async function recargarModelo(value, btn = null) {
  if (!value) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('refreshing');
  }
  try {
    toast('Comprobando el modelo…', 'warn');
    const res = await api('/api/models/refresh', {
      method: 'POST',
      body: JSON.stringify({ model: value })
    });
    await loadChatConfig();
    const estado = res?.health?.status || res?.status;
    toast(
      estado === 'ok' ? 'Modelo comprobado: funciona' : `Modelo comprobado: ${estado || 'sin confirmar'}`,
      estado === 'ok' ? 'ok' : 'warn'
    );
  } catch (error) {
    toast(`No se pudo comprobar el modelo: ${error.message}`, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('refreshing');
    }
  }
}

function closeChat() {
  if (state.chat.source) {
    state.chat.source.close();
    state.chat.source = null;
  }
  state.chat.projectId = null;
  state.chat.busy = false;
  state.chat.streaming = '';
  removeStreamingBubble();
}

function setChatStatus(status) {
  const el = $('#chat-status');
  const labels = {
    idle: 'en espera',
    running: 'escribiendo…',
    starting: 'arrancando…',
    stopped: 'dormida (se reanuda al escribir)',
    error: 'error'
  };
  el.textContent = labels[status] || status;
  el.className = `chat-status ${status}`;
  state.chat.busy = status === 'running' || status === 'starting';
  // ACP no permite separar los deltas de dos turnos a la vez, así que el
  // servidor rechaza el segundo. Se deshabilita el campo para no chocar.
  $('#chat-input').disabled = state.chat.busy;
  const enviar = $('#chat-send');
  if (enviar) {
    // Mientras el agente trabaja, el mismo botón de enviar sirve para detener.
    enviar.textContent = state.chat.busy ? '■ Detener' : 'Enviar';
    enviar.classList.toggle('is-stop', state.chat.busy);
    enviar.disabled = false;
  }
  $('#chat-input').placeholder = state.chat.busy
    ? 'Jarvis está respondiendo… (pulsa Detener para interrumpir)'
    : 'Escribe a Jarvis… (Enter envía, Shift+Enter salto de línea)';
  // El botón de detener sólo tiene sentido mientras el agente trabaja.
  const stop = $('#chat-stop');
  if (stop) stop.classList.toggle('hidden', !state.chat.busy);
  updateTyping();
}

function handleChatEvent(event) {
  switch (event.type) {
    case 'user':
      // Eco del propio mensaje: ya lo pintamos al enviarlo.
      break;

    // --- Streaming: ACP manda deltas de texto ---
    case 'assistant-chunk': {
      state.chat.streaming += event.text || '';
      const bubble = ensureStreamingBubble();
      bubble.textContent = state.chat.streaming;   // texto plano: rápido y sin parpadeo
      scrollChatToEnd();
      break;
    }

    // --- Mensaje cerrado: se pinta con Markdown y se fija en el hilo ---
    case 'assistant': {
      state.chat.streaming = '';
      removeStreamingBubble();
      state.chat.messages.push({ role: 'assistant', text: event.text, at: event.at });
      renderChat();
      break;
    }

    case 'reasoning':
      // Razonamiento del turno: una línea plegable, no ruido token a token.
      state.chat.messages.push({
        role: 'thought',
        id: `thought-${event.at || Date.now()}`,
        text: 'Razonamiento',
        detail: event.detail || '',
        at: event.at
      });
      renderChat();
      break;

    case 'thought':
      // Los deltas sueltos de razonamiento no se pintan: el adaptador los
      // acumula y emite un único bloque `reasoning`.
      break;

    case 'tool-call':
      state.chat.messages.push({
        role: 'tool',
        id: event.id,
        text: event.summary || event.name || 'herramienta',
        status: event.status || 'in_progress',
        detail: event.detail || '',
        at: event.at
      });
      renderChat();
      break;

    case 'tool-done':
      actualizarHerramienta(event);
      break;

    case 'permission':
      state.chat.messages.push({ role: 'note', text: `🔓 autorizado: ${event.text}`, at: event.at });
      renderChat();
      break;

    case 'stalled':
      // El turno lleva mucho tiempo sin emitir nada: se avisa, no se cancela.
      state.chat.messages.push({ role: 'note', text: `⏳ ${event.text}`, at: event.at });
      renderChat();
      break;

    case 'status':
      setChatStatus(event.status);
      break;

    case 'turn-end':
      state.chat.streaming = '';
      removeStreamingBubble();
      setChatStatus('idle');
      renderChat();
      // El agente pudo anotar preguntas o puntos clave: refrescamos el seguimiento.
      refrescarSeguimiento();
      break;

    case 'reset':
      state.chat.messages = [];
      state.chat.streaming = '';
      renderChat();
      toast('Conversación nueva: el agente ha olvidado lo hablado', 'ok');
      break;

    case 'error':
      state.chat.streaming = '';
      removeStreamingBubble();
      state.chat.messages.push({ role: 'error', text: event.text, at: event.at });
      setChatStatus('error');
      renderChat();
      break;

    case 'log':
      // Diagnóstico de DSH: no ensuciamos el chat con esto.
      break;

    default:
      break;
  }
}

/** Actualiza en el sitio la herramienta que acaba de terminar. */
function actualizarHerramienta(event) {
  let msg = null;
  if (event.id) {
    msg = state.chat.messages.find((m) => m.role === 'tool' && m.id === event.id) || null;
  }
  if (!msg) {
    // Compatibilidad: sin id, se completa la última herramienta pendiente.
    for (let i = state.chat.messages.length - 1; i >= 0; i -= 1) {
      const m = state.chat.messages[i];
      if (m.role === 'tool' && m.status !== 'completed' && m.status !== 'failed') {
        msg = m;
        break;
      }
    }
  }
  if (!msg) {
    state.chat.messages.push({
      role: 'tool',
      id: event.id,
      text: event.name || 'herramienta',
      status: event.status,
      detail: event.detail || '',
      at: event.at
    });
  } else {
    msg.status = event.status || msg.status;
    if (event.detail) msg.detail = event.detail;
  }
  renderChat();
}

/** Burbuja donde va escribiéndose la respuesta en curso. */
function ensureStreamingBubble() {
  let el = document.getElementById('chat-streaming');
  if (!el) {
    const wrap = document.createElement('div');
    wrap.id = 'chat-streaming';
    wrap.className = 'msg msg-assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    wrap.appendChild(bubble);
    $('#chat-messages').appendChild(wrap);
    el = bubble;
    updateTyping();
  }
  return el;
}

function removeStreamingBubble() {
  const el = document.getElementById('chat-streaming');
  if (el) el.remove();
}

function updateTyping() {
  const existing = document.getElementById('chat-typing');
  // Con texto ya llegando no hacen falta los puntos suspensivos.
  const shouldShow = state.chat.busy && !state.chat.streaming;
  if (shouldShow && !existing) {
    const el = document.createElement('div');
    el.id = 'chat-typing';
    el.className = 'msg msg-assistant';
    el.innerHTML = '<div class="msg-bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
    $('#chat-messages').appendChild(el);
    scrollChatToEnd();
  } else if ((!shouldShow || state.chat.streaming) && existing) {
    existing.remove();
  }
}

/** Icono compacto del estado de una herramienta. */
function estadoIcono(status) {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'in_progress') return '…';
  return '⚙';
}

/** HTML de una entrada de actividad: línea compacta plegable con detalle. */
function actividadHtml({ id, resumen, detalle, clase = '' }) {
  const seguro = escapeHtml(resumen);
  if (!detalle) return `<div class="msg-activity-line ${clase}">${seguro}</div>`;
  return `<details class="msg-activity ${clase}" data-activity-id="${escapeHtml(id || '')}">`
    + `<summary>${seguro}</summary>`
    + `<pre class="msg-activity-detail">${escapeHtml(detalle)}</pre>`
    + '</details>';
}

/** Botones de una pregunta o respuesta: copiar y (si procede) reintentar. */
function accionesMensaje({ copiar = false, reintentar = null } = {}) {
  const botones = [];
  if (reintentar) {
    botones.push('<button type="button" class="msg-accion" data-msg-accion="reintentar"'
      + ` data-pregunta="${escapeHtml(reintentar)}" title="Volver a hacer esta pregunta">↻ Reintentar</button>`);
  }
  if (copiar) {
    botones.push('<button type="button" class="msg-accion" data-msg-accion="copiar"'
      + ' title="Copiar el texto tal cual se ve">⧉ Copiar</button>');
  }
  return botones.length ? `<div class="msg-acciones">${botones.join('')}</div>` : '';
}

/** Texto tal cual se ve: `innerText` conserva los saltos de los bloques. */
function textoVisible(el, respaldo = '') {
  if (!el) return respaldo;
  if (typeof el.innerText === 'string' && el.innerText.trim()) return el.innerText;
  if (typeof el.textContent === 'string') return el.textContent;
  return respaldo;
}

/** Copia al portapapeles, con plan B para HTTP en red local. */
async function copiarTexto(texto) {
  const valor = String(texto ?? '');
  if (!valor) return;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard
      && (typeof window === 'undefined' || window.isSecureContext !== false)) {
      await navigator.clipboard.writeText(valor);
      toast('Copiado', 'ok');
      return;
    }
  } catch { /* se intenta el plan B */ }
  try {
    const area = document.createElement('textarea');
    area.value = valor;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    area.remove();
    toast(ok ? 'Copiado' : 'No se pudo copiar', ok ? 'ok' : 'err');
  } catch {
    toast('No se pudo copiar', 'err');
  }
}

/** Clic en los botones de copiar/reintentar de una pregunta o respuesta. */
function manejarAccionMensaje(event) {
  const btn = event.target.closest('[data-msg-accion]');
  if (!btn) return;
  if (btn.dataset.msgAccion === 'reintentar') {
    reintentarPregunta(btn.dataset.pregunta || '');
    return;
  }
  if (btn.dataset.msgAccion === 'copiar') {
    const wrap = typeof btn.closest === 'function' ? btn.closest('.msg') : null;
    const burbuja = wrap && typeof wrap.querySelector === 'function'
      ? wrap.querySelector('.msg-bubble')
      : null;
    copiarTexto(textoVisible(burbuja, btn.dataset.fallback || ''));
  }
}

function renderChat() {
  const box = $('#chat-messages');
  const messages = state.chat.messages;
  // Recuerda qué detalles estaban desplegados para no cerrarlos al repintar.
  // Al recargar la página este conjunto nace vacío: todo plegado, como se pidió.
  const abiertos = new Set();
  for (const detalle of box.querySelectorAll('details[open][data-activity-id]')) {
    if (detalle.dataset?.activityId) abiertos.add(detalle.dataset.activityId);
  }
  box.innerHTML = '';

  if (!messages.length) {
    box.innerHTML = `
      <div class="chat-empty">
        <h2>Conversemos sobre esta idea</h2>
        <p class="muted">Aquí se desarrolla la parte conceptual. Cuando tengas claro el plan,
          usa la barra <strong>⌘</strong> de abajo para que Jarvis lo ejecute con agentes.</p>
        <p class="muted">${window.matchMedia('(max-width: 820px)').matches
          ? 'Tus ideas están en el menú <strong>☰</strong>, arriba a la izquierda.'
          : 'Tus ideas están en el panel de la izquierda.'}</p>
      </div>`;
    updateTyping();
    return;
  }

  let idx = 0;
  for (const msg of messages) {
    const wrap = document.createElement('div');
    wrap.dataset.idx = String(idx);
    idx += 1;
    const time = msg.at ? new Date(msg.at).toLocaleTimeString().slice(0, 5) : '';

    if (msg.role === 'user') {
      wrap.className = 'msg msg-user';
      wrap.innerHTML = `<div class="msg-bubble">${escapeHtml(msg.text)}</div>`
        + accionesMensaje({ copiar: true, reintentar: msg.text });
    } else if (msg.role === 'assistant') {
      wrap.className = 'msg msg-assistant';
      wrap.innerHTML = `<div class="msg-bubble markdown">${renderMarkdown(msg.text || '')}</div>
        <div class="msg-meta">Jarvis${time ? ` · ${time}` : ''}</div>`
        + accionesMensaje({ copiar: true });
    } else if (msg.role === 'tool') {
      wrap.className = 'msg msg-activity';
      wrap.innerHTML = actividadHtml({
        id: msg.id,
        resumen: `${estadoIcono(msg.status)} ${msg.text || 'herramienta'}`,
        detalle: msg.detail,
        clase: 'msg-tool-activity'
      });
    } else if (msg.role === 'thought') {
      wrap.className = 'msg msg-activity';
      wrap.innerHTML = actividadHtml({
        id: msg.id,
        resumen: '🧠 Razonamiento',
        detalle: msg.detail,
        clase: 'msg-thought'
      });
    } else if (msg.role === 'error') {
      wrap.className = 'msg-error';
      wrap.textContent = msg.text;
    } else {
      wrap.className = 'msg-note';
      wrap.textContent = msg.text;
    }
    box.appendChild(wrap);
  }

  // Restaura lo que estuviera desplegado en esta misma sesión.
  if (abiertos.size) {
    for (const detalle of box.querySelectorAll('details[data-activity-id]')) {
      if (abiertos.has(detalle.dataset?.activityId)) detalle.open = true;
    }
  }

  updateTyping();
  // Si hay una respuesta en curso, se restaura tras el repintado.
  if (state.chat.streaming) {
    ensureStreamingBubble().textContent = state.chat.streaming;
  }
  scrollChatToEnd();
}

function scrollChatToEnd() {
  const box = $('#chat-messages');
  if (box) box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(event) {
  if (event) event.preventDefault();
  // Mientras el agente trabaja, este mismo botón hace de «Detener».
  if (state.chat.busy) { preguntarDetener(); return; }
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await enviarTexto(text);
}

/** Envía un texto como pregunta: se pinta al momento y se manda al motor. */
async function enviarTexto(text) {
  const limpio = String(text ?? '').trim();
  if (!limpio) return;
  if (!state.chat.projectId) {
    toast('Selecciona primero una idea', 'err');
    return;
  }

  // Optimista: pintamos la pregunta ya mismo.
  state.chat.messages.push({ role: 'user', text: limpio, at: new Date().toISOString() });
  renderChat();
  setChatStatus('running');

  try {
    await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text: limpio })
    });
  } catch (error) {
    state.chat.messages.push({ role: 'error', text: `No se pudo enviar: ${error.message}` });
    setChatStatus('error');
    renderChat();
  }
}

/** Vuelve a preguntar lo mismo, con el modelo que esté elegido ahora. */
async function reintentarPregunta(texto) {
  if (state.chat.busy) {
    toast('Jarvis está respondiendo; espera o pulsa Detener', 'warn');
    return;
  }
  await enviarTexto(texto);
}

async function resetChat() {
  if (!state.chat.projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/reset`, { method: 'POST' });
  } catch (error) {
    toast(`Error al reiniciar: ${error.message}`, 'err');
  }
}

/** El botón de detener (arriba o abajo) pide confirmación antes de parar. */
function cancelChat() {
  preguntarDetener();
}

/** Abre la confirmación de parada, con `confirm()` como red de seguridad. */
function preguntarDetener() {
  if (!state.chat.busy) return;
  const dialog = $('#stop-dialog');
  if (dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
    return;
  }
  if (typeof window.confirm === 'function'
    && window.confirm('¿Detener la respuesta en curso?')) {
    cancelarTurno();
  }
}

/** Detiene el turno en curso sin perder la memoria del agente. */
async function cancelarTurno() {
  if (!state.chat.projectId) return;
  try {
    const { cancelled } = await api(
      `/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/cancel`,
      { method: 'POST' }
    );
    if (cancelled) {
      toast('Respuesta detenida', 'ok');
    } else {
      toast('Este motor de chat no sabe cancelar; usa «Nueva»', 'err');
    }
  } catch (error) {
    toast(`No se pudo detener: ${error.message}`, 'err');
  }
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
    toast(`Orden aceptada (${result.taskId}). Jarvis la ejecutará en breve.`, 'ok');
    input.value = '';
    switchTab('logs');
    await Promise.all([loadZone('logs'), refreshTaskStatus(), refreshGitStatus()]);
  } catch (error) {
    toast(`Error: ${error.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}

/* ---------------- Estado de las tareas del orquestador ---------------- */
let taskPollTimer = null;

async function refreshTaskStatus() {
  if (!state.currentProjectId) return null;
  try {
    const { tasks } = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/tasks`);
    const running = tasks.find((t) => t.status === 'running' || t.status === 'queued');
    const el = $('#task-status');

    if (el) {
      if (!tasks.length) {
        el.classList.add('hidden');
      } else {
        el.classList.remove('hidden');
        const t = running || tasks[0];
        const icon = { queued: '⏳', running: '⚙️', completed: '✅', failed: '❌', timeout: '⏰' }[t.status] || '•';
        el.textContent = `${icon} ${t.status} · ${t.instruction.slice(0, 70)}`;
        el.className = `task-status ${t.status}`;
      }
    }

    // Mientras haya trabajo vivo, refrescamos la bitácora en vivo.
    if (running) {
      await loadZone('logs');
      scheduleTaskPoll();
    } else {
      clearTimeout(taskPollTimer);
      await loadZone('logs');
    }
    return tasks;
  } catch {
    return null;
  }
}

function scheduleTaskPoll() {
  clearTimeout(taskPollTimer);
  taskPollTimer = setTimeout(refreshTaskStatus, 4000);
}

/* ---------------- Nueva idea: elegir modelo desde el principio ---------------- */
/** Rellena un <select> con el catálogo de modelos, agrupado por proveedor. */
function llenarSelectModelos(sel, options, currentValue) {
  sel.innerHTML = '';
  const porDefecto = document.createElement('option');
  porDefecto.value = '';
  porDefecto.textContent = 'Modelo por defecto';
  sel.appendChild(porDefecto);

  const opt = (options || []).find((o) => o.id === 'model' || o.category === 'model');
  const grupos = (opt?.options || []).filter((g) => Array.isArray(g.options));
  for (const grupo of grupos) {
    const og = document.createElement('optgroup');
    og.label = grupo.name || grupo.group || 'Modelos';
    for (const item of grupo.options) {
      const o = document.createElement('option');
      o.value = item.value;
      o.textContent = `${modelStatusInfo(item).icon} ${item.name || item.value}`;
      o.title = modelTooltip(item);
      if (item.value === currentValue) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

/** Carga el catálogo en el selector del diálogo de nueva idea. */
async function cargarCatalogoNuevaIdea() {
  const sel = $('#new-project-model');
  if (!sel) return;
  const referencia = state.currentProjectId || (state.projects || [])[0]?.id;
  if (!referencia) {
    sel.innerHTML = '<option value="">Modelo por defecto</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  try {
    const config = await api(`/api/projects/${encodeURIComponent(referencia)}/chat/config`);
    llenarSelectModelos(sel, config.options, config.current?.model || '');
  } catch {
    sel.innerHTML = '<option value="">Modelo por defecto</option>';
  }
}

/** Abre el diálogo de nueva idea YA y rellena el catálogo en segundo plano. */
function abrirNuevaIdea() {
  const dialog = $('#new-project-dialog');
  if (!dialog || dialog.open) return;
  // Se abre de inmediato. Antes se esperaba al catálogo ANTES de abrir: si esa
  // petición tardaba (o se atascaba arrancando la sesión del agente), el botón
  // parecía muerto. El selector se rellena cuando llega el catálogo.
  try { dialog.showModal(); } catch { /* ya estaba abierto */ }
  return cargarCatalogoNuevaIdea();
}

/* ---------------- Acciones de creación ---------------- */
async function createProject(event) {
  event.preventDefault();
  const form = event.target;
  const payload = {
    name: form.name.value.trim(),
    description: form.description.value.trim()
  };
  const modelo = $('#new-project-model')?.value || '';
  try {
    const { project } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    // El modelo se fija ANTES de abrir la idea, para que su chat arranque con él.
    if (modelo) {
      await api(`/api/projects/${encodeURIComponent(project.id)}/chat/config`, {
        method: 'POST',
        body: JSON.stringify({ configId: 'model', value: modelo })
      });
    }
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

/* ---------------- Administración de modelos ---------------- */
let adminPoll = null;

function modeloHealthLabel(status) {
  switch (status) {
    case 'ok': return { texto: 'funciona', clase: 'ok' };
    case 'quota': return { texto: 'sin cuota', clase: 'warn' };
    case 'broken': return { texto: 'no funciona', clase: 'err' };
    default: return { texto: 'sin confirmar', clase: '' };
  }
}

/** Nombre legible de la clave de un modelo (`["proveedor","modelo"]`). */
function modelKeyLabel(value, entry) {
  if (entry?.provider && entry?.model) return `${entry.provider}/${entry.model}`;
  try {
    const [provider, model] = JSON.parse(value);
    if (provider && model) return `${provider}/${model}`;
  } catch { /* no era JSON */ }
  return String(value);
}

async function abrirAdmin() {
  const dialog = $('#admin-dialog');
  if (!dialog) return;
  try { dialog.showModal(); } catch { /* ya abierto */ }
  await cargarSaludModelos();
}

async function cargarSaludModelos() {
  try {
    const salud = await api('/api/models/health');
    renderAdminModelos(salud);
    if (salud.checking) programarSondeoAdmin();
  } catch (error) {
    const resumen = $('#admin-summary');
    if (resumen) resumen.textContent = `No se pudo leer la salud de los modelos: ${error.message}`;
  }
}

function renderAdminModelos(salud) {
  const cont = $('#admin-models');
  const resumen = $('#admin-summary');
  const results = salud?.results || {};
  const entradas = Object.entries(results).map(([value, r]) => ({ value, ...r }));
  const orden = { ok: 0, quota: 1, unknown: 2, broken: 3 };
  entradas.sort((a, b) => (orden[a.status] ?? 2) - (orden[b.status] ?? 2));

  const cuenta = { ok: 0, quota: 0, broken: 0, unknown: 0 };
  for (const e of entradas) cuenta[e.status] = (cuenta[e.status] || 0) + 1;

  if (resumen) {
    if (salud?.checking) {
      const p = salud.progress || {};
      resumen.textContent = `Comprobando modelos… ${p.done ?? 0}/${p.total ?? '?'}`
        + (p.current ? ` · ${modelKeyLabel(p.current)}` : '');
    } else if (!entradas.length) {
      resumen.textContent = 'Sin datos. Pulsa «Restablecer y comprobar» para analizar los modelos.';
    } else {
      const fecha = salud.checkedAt ? new Date(salud.checkedAt).toLocaleString() : '—';
      resumen.textContent = `Última comprobación: ${fecha} · ${cuenta.ok || 0} funcionan · `
        + `${cuenta.quota || 0} sin cuota · ${cuenta.broken || 0} no funcionan · ${cuenta.unknown || 0} sin confirmar`;
    }
  }

  if (!cont) return;
  cont.innerHTML = '';
  for (const e of entradas) {
    const etiqueta = modeloHealthLabel(e.status);
    const fila = document.createElement('div');
    fila.className = 'model-row';
    fila.innerHTML = `<span class="model-name">${escapeHtml(modelKeyLabel(e.value, e))}</span>`
      + `<span class="model-status ${etiqueta.clase}">${etiqueta.texto}</span>`
      + (e.error ? `<span class="model-error" title="${escapeHtml(e.error)}">${escapeHtml(String(e.error).slice(0, 90))}</span>` : '');
    cont.appendChild(fila);
  }
}

/** Gira el icono de la comprobación global y bloquea su botón. */
function setRefreshing(activo) {
  const btn = $('#models-refresh');
  if (!btn) return;
  btn.disabled = activo;
  btn.classList.toggle('refreshing', activo);
}

function programarSondeoAdmin() {
  if (adminPoll) return;
  adminPoll = setInterval(async () => {
    try {
      const salud = await api('/api/models/health');
      renderAdminModelos(salud);
      if (!salud.checking) {
        clearInterval(adminPoll);
        adminPoll = null;
        setRefreshing(false);
        if (state.chat.projectId) loadChatConfig();
      }
    } catch {
      clearInterval(adminPoll);
      adminPoll = null;
      setRefreshing(false);
    }
  }, 1500);
}

async function comprobarModelos() {
  setRefreshing(true);
  try {
    await api('/api/models/refresh', { method: 'POST' });
    toast('Comprobando modelos; esto puede tardar y consume algo de cuota', 'warn');
    await cargarSaludModelos();
    programarSondeoAdmin();
  } catch (error) {
    toast(`No se pudo comprobar: ${error.message}`, 'err');
    setRefreshing(false);
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
  on('#markdown-view', 'click', (event) => {
    const link = event.target.closest('[data-note]');
    if (link) openNote(link.dataset.note);
  });

  // Seguimiento: resolver pendientes (guardar/borrar) y saltar a la conversación
  on('#preguntas-list', 'click', manejarSeguimiento);
  on('#clave-list', 'click', manejarSeguimiento);

  // Mapa: arrastrar los nodos y abrir la nota al pulsarla
  on('#mapa-graph', 'pointerdown', mapaPointerDown);
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pointermove', mapaPointerMove);
    window.addEventListener('pointerup', mapaPointerUp);
  }

  on('#edit-toggle', 'click', () => setEditing(!state.editing));
  on('#save-note-btn', 'click', saveNote);

  // Atajo: Ctrl/Cmd + S guarda
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (state.editing) saveNote();
    }
  });

  on('#new-project-btn', 'click', abrirNuevaIdea);
  on('#new-idea-btn', 'click', abrirNuevaIdea);
  on('#back-btn', 'click', goHome);
  on('#home-btn', 'click', goHome);
  on('#new-note-btn', 'click', () => {
    if (!state.currentProjectId) return toast('Selecciona primero una idea', 'err');
    $('#new-note-dialog').showModal();
  });
  on('#new-project-form', 'submit', createProject);
  on('#new-note-form', 'submit', createNote);

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  on('#command-send', 'click', sendCommand);
  on('#command-input', 'keydown', (event) => {
    if (event.key === 'Enter') sendCommand();
  });

  // --- Chat ---
  on('#chat-form', 'submit', sendChatMessage);
  on('#chat-messages', 'click', manejarAccionMensaje);
  on('#chat-reset', 'click', resetChat);
  on('#chat-stop', 'click', cancelChat);
  on('#stop-confirm', 'click', () => {
    const dialog = $('#stop-dialog');
    if (dialog) dialog.close();
    cancelarTurno();
  });
  on('#borrar-confirm', 'click', confirmarBorrado);
  on('#chat-effort', 'change', (e) => saveChatConfig('reasoning_effort', e.target.value));
  // Desplegable de modelos: cada fila elige; su icono ⟳ comprueba sólo ese.
  on('#chat-model-btn', 'click', toggleModelMenu);
  on('#chat-model-menu', 'click', manejarMenuModelos);
  document.addEventListener('click', (event) => {
    const picker = $('#chat-model-picker');
    if (!picker || typeof picker.contains !== 'function') return;
    if (!picker.contains(event.target)) cerrarModelMenu();
  });

  // Al volver a la pestaña (el móvil bloquea el SSE en segundo plano) se
  // resincroniza: es la otra mitad de «si sales y vuelves, vuelve al origen».
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resyncChat();
  });
  const chatInput = $('#chat-input');
  chatInput.addEventListener('keydown', (event) => {
    // Enter envía; Shift+Enter hace salto de línea (como cualquier chat).
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage(event);
    }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
  });

  on('#menu-toggle', 'click', () => $('#sidebar').classList.toggle('open'));

  // --- Panel de sistema ---
  on('#system-pill', 'click', abrirSistema);
  on('#system-update', 'click', pedirActualizacion);
  on('#system-check', 'click', buscarNovedades);

  // --- Administración de modelos ---
  on('#admin-btn', 'click', abrirAdmin);
  on('#models-refresh', 'click', comprobarModelos);
  const adminDialog = $('#admin-dialog');
  if (adminDialog) {
    adminDialog.addEventListener('close', () => {
      if (adminPoll) { clearInterval(adminPoll); adminPoll = null; }
    });
  }
}

async function boot() {
  // Si algo falla en el arranque, se muestra en pantalla. Antes el error se
  // perdía en la consola y la interfaz quedaba muda sin ninguna pista.
  window.addEventListener('error', (e) => {
    console.error('[jarvis]', e.error || e.message);
    const box = document.getElementById('toast');
    if (box) {
      box.textContent = `Error en la interfaz: ${e.message}`;
      box.className = 'toast err';
      box.classList.remove('hidden');
    }
  });

  try {
    bindEvents();
  } catch (error) {
    console.error('[jarvis] bindEvents falló:', error);
    mostrarAvisoArranque(`No se pudieron enlazar los eventos: ${error.message}`);
  }

  // En móvil el panel de ideas está detrás del ☰: la primera pista lo dice.
  if (window.matchMedia('(max-width: 820px)').matches) {
    const hint = document.getElementById('hint-ideas');
    if (hint) hint.innerHTML = 'Pulsa <strong>☰</strong> arriba a la izquierda para ver tus ideas, o crea una con <strong>+ Idea</strong>.';
  }

  try {
    await loadProjects();
    // El arranque aterriza en el INICIO: las ideas como tarjetas, tipo Obsidian.
    // Abrir una idea es decisión del usuario, no algo automático.
    showHome();

    await Promise.all([refreshGitStatus(), loadSystemStatus()]);
    setInterval(refreshGitStatus, 30000);
    setInterval(loadSystemStatus, 60000);
  } catch (error) {
    console.error('[jarvis] arranque falló:', error);
    mostrarAvisoArranque(`No se pudo conectar con Jarvis: ${error.message}`);
  }
}

/** Deja el fallo a la vista en el propio inicio. */
function mostrarAvisoArranque(mensaje) {
  const empty = document.getElementById('home-empty');
  if (empty) {
    empty.classList.remove('hidden');
    empty.innerHTML = `<h2>No se pudo conectar</h2><p>⚠️ ${escapeHtml(mensaje)}</p>`;
  }
  toast(mensaje, 'err');
}

// API mínima para consola y pruebas: permite abrir ideas, volver al inicio y
// refrescar datos sin depender de un clic real. No interviene en el flujo normal.
window.Jarvis = {
  state,
  selectProject,
  goHome,
  showHome,
  showIdea,
  loadProjects,
  renderIdeaGrid,
  abrirNuevaIdea,
  llenarSelectModelos,
  switchTab,
  parseChecklist,
  construirGrafo,
  renderSeguimiento,
  SEGUIMIENTO,
  enviarTexto,
  reintentarPregunta,
  textoVisible,
  copiarTexto,
  pedirBorrado,
  confirmarBorrado
};

boot();
