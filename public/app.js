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
  parentes: {},
  linaje: [],
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
  try {
    const meta = await api('/api/ideas');
    state.parentes = (meta && meta.padres) || {};
    state.linaje = (meta && meta.linaje) || [];
  } catch {
    state.parentes = {};
    state.linaje = [];
  }
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
function hijosDe(id) {
  return (state.projects || []).filter((p) => (state.parentes[p.id] || null) === id);
}

/** Fecha (ms) de la última modificación de una idea, para ordenar. */
function fechaIdea(project) {
  const t = Date.parse(project?.modifiedAt || project?.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

/** Más recientes primero. */
function porReciente(a, b) {
  return fechaIdea(b) - fechaIdea(a);
}

function tarjetaIdea(project, nivel = 0) {
  const inicial = (project.name || project.id || '?').trim().charAt(0).toUpperCase() || '?';
  const desc = (project.description || '').trim();
  const padre = state.parentes[project.id] || null;
  const fecha = fechaIdea(project) ? new Date(fechaIdea(project)).toLocaleDateString() : '';
  const card = document.createElement('article');
  card.className = 'idea-card';
  card.dataset.id = project.id;
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  if (nivel) card.style.marginLeft = `${nivel * 22}px`;
  card.innerHTML =
    `<div class="idea-card-top">`
    + `<div class="idea-card-mark">${escapeHtml(inicial)}</div>`
    + (nivel ? `<span class="idea-card-nivel" title="Nivel ${nivel + 1}">N${nivel + 1}</span>` : '')
    + `</div>`
    + (padre ? `<span class="idea-card-parent" title="Depende de ${escapeHtml(padre)}">↳ ${escapeHtml(padre)}</span>` : '')
    + `<h3 class="idea-card-title">${escapeHtml(project.name || project.id)}</h3>`
    + `<p class="idea-card-desc">${desc ? escapeHtml(desc.slice(0, 180)) : '<span class="muted">Sin descripción todavía</span>'}</p>`
    + `<div class="idea-card-foot"><span class="idea-card-tag">${escapeHtml(project.status || 'idea')}</span>`
    + `<span class="idea-card-fecha" title="Última modificación">${escapeHtml(fecha)}</span>`
    + `<span class="idea-acciones-toggle" data-acciones="${escapeHtml(project.id)}" title="Gestionar idea">⋯</span></div>`
    + `<div class="idea-acciones hidden" data-panel="${escapeHtml(project.id)}">`
    + `<button type="button" class="seg-btn" data-idea-accion="duplicar" data-id="${escapeHtml(project.id)}">Duplicar</button>`
    + `<button type="button" class="seg-btn" data-idea-accion="renombrar" data-id="${escapeHtml(project.id)}">Renombrar</button>`
    + `<button type="button" class="seg-btn" data-idea-accion="fusionar" data-id="${escapeHtml(project.id)}">Fusionar</button>`
    + `<button type="button" class="seg-btn" data-idea-accion="padre" data-id="${escapeHtml(project.id)}">Mover bajo</button>`
    + (padre ? `<button type="button" class="seg-btn" data-idea-accion="soltar" data-id="${escapeHtml(project.id)}">Soltar</button>` : '')
    + `<button type="button" class="seg-btn seg-del" data-idea-accion="borrar" data-id="${escapeHtml(project.id)}">Borrar</button>`
    + '</div>';
  return card;
}

function tarjetaNuevaIdea() {
  const nueva = document.createElement('button');
  nueva.type = 'button';
  nueva.className = 'idea-card idea-card-new';
  nueva.innerHTML = '<span class="idea-card-new-plus" aria-hidden="true">＋</span><span>Nueva idea</span>';
  nueva.addEventListener('click', abrirNuevaIdea);
  return nueva;
}

function tituloInicio(titulo, sub) {
  const el = document.createElement('div');
  el.className = 'inicio-seccion';
  el.innerHTML = `<h2>${escapeHtml(titulo)}</h2><p class="muted">${escapeHtml(sub)}</p>`;
  return el;
}

/**
 * Inicio en dos bloques:
 *  1. **Recientes**: las últimas ideas tocadas, sueltas y sin su familia.
 *  2. **Jerarquía**: cada idea con sus subideas (nivel a la vista).
 * Dentro de cada grupo, lo más reciente primero.
 */
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

  grid.className = 'inicio';
  grid.innerHTML = '';
  if (!projects.length) { grid.appendChild(tarjetaNuevaIdea()); return; }

  const porFecha = [...projects].sort(porReciente);

  // 1) Recientes: las últimas 5, sueltas (sin padres, hijas ni hermanas).
  grid.appendChild(tituloInicio('Recientes', 'Lo último que has tocado, sin su familia alrededor.'));
  const recientes = document.createElement('div');
  recientes.className = 'idea-grid';
  for (const project of porFecha.slice(0, 5)) recientes.appendChild(tarjetaIdea(project, 0));
  grid.appendChild(recientes);

  // 2) Jerarquía: cada idea padre con sus subideas, y el nivel señalado.
  grid.appendChild(tituloInicio('Jerarquía', 'Cada idea con sus subideas; dentro de cada grupo, lo más reciente primero.'));
  const arbol = document.createElement('div');
  arbol.className = 'idea-arbol';
  const raices = porFecha.filter((p) => !(state.parentes[p.id] || null)
    || !projects.some((q) => q.id === state.parentes[p.id]));
  const vistos = new Set();
  const pinta = (project, nivel) => {
    if (vistos.has(project.id)) return;
    vistos.add(project.id);
    arbol.appendChild(tarjetaIdea(project, nivel));
    for (const hijo of hijosDe(project.id).sort(porReciente)) pinta(hijo, nivel + 1);
  };
  for (const r of raices) pinta(r, 0);
  for (const p of porFecha) pinta(p, 0);
  grid.appendChild(arbol);

  grid.appendChild(tarjetaNuevaIdea());
}

/** Clic en la rejilla: abrir idea, desplegar el menú ⋯ o ejecutar una acción. */
function manejarGridIdea(event) {
  const accion = event.target.closest('[data-idea-accion]');
  if (accion) {
    event.stopPropagation();
    accionIdea(accion.dataset.ideaAccion, accion.dataset.id);
    return;
  }
  const toggle = event.target.closest('[data-acciones]');
  if (toggle) {
    event.stopPropagation();
    const panel = document.querySelector(`[data-panel="${toggle.dataset.acciones}"]`);
    if (panel) panel.classList.toggle('hidden');
    return;
  }
  const card = event.target.closest('.idea-card[data-id]');
  if (card) selectProject(card.dataset.id);
}

/** Duplicar / renombrar / fusionar / borrar / jerarquía de una idea. */
/** Descendientes de una idea (para no ofrecer un padre que cree un ciclo). */
function descendientesDe(id) {
  const out = new Set();
  const pila = [id];
  while (pila.length) {
    const actual = pila.pop();
    for (const p of (state.projects || [])) {
      if ((state.parentes[p.id] || null) === actual && !out.has(p.id)) {
        out.add(p.id);
        pila.push(p.id);
      }
    }
  }
  return out;
}

/** Ideas válidas como padre: ni ella misma ni sus descendientes. */
function candidatosPadre(id) {
  const prohibidos = descendientesDe(id);
  prohibidos.add(id);
  return (state.projects || [])
    .filter((p) => !prohibidos.has(p.id))
    .map((p) => ({ valor: p.id, etiqueta: p.id }));
}

/**
 * Diálogo de idea: escribe un identificador o elige una idea de un desplegable.
 * Devuelve el valor elegido, o null si se cancela.
 */
function abrirDialogoIdea({ titulo = 'Idea', texto = '', tipo = 'texto', valor = '', opciones = [] } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#idea-dialog');
    const input = $('#idea-dialog-input');
    const inputWrap = $('#idea-dialog-input-wrap');
    const select = $('#idea-dialog-select');
    const selectWrap = $('#idea-dialog-select-wrap');
    const btnOk = $('#idea-dialog-ok');
    const btnCancel = $('#idea-dialog-cancel');
    if (!dlg || !input || !select || !btnOk || !btnCancel) return resolve(null);

    $('#idea-dialog-title').textContent = titulo;
    $('#idea-dialog-text').textContent = texto;
    if (tipo === 'lista') {
      inputWrap.classList.add('hidden');
      selectWrap.classList.remove('hidden');
      select.innerHTML = opciones
        .map((o) => `<option value="${escapeHtml(o.valor)}">${escapeHtml(o.etiqueta)}</option>`)
        .join('');
      if (valor) select.value = valor;
    } else {
      selectWrap.classList.add('hidden');
      inputWrap.classList.remove('hidden');
      input.value = valor || '';
      try { input.focus(); input.select(); } catch { /* sin foco */ }
    }

    let resultado = null;
    const limpiar = () => {
      btnOk.removeEventListener('click', aceptar);
      btnCancel.removeEventListener('click', cancelar);
      dlg.removeEventListener('close', alCerrar);
    };
    const aceptar = () => {
      resultado = tipo === 'lista' ? select.value : (input.value.trim() || null);
      dlg.close();
    };
    const cancelar = () => { resultado = null; dlg.close(); };
    const alCerrar = () => { limpiar(); resolve(resultado); };
    btnOk.addEventListener('click', aceptar);
    btnCancel.addEventListener('click', cancelar);
    dlg.addEventListener('close', alCerrar);
    try { dlg.showModal(); } catch { limpiar(); resolve(null); }
  });
}

/** Duplicar / renombrar / fusionar / borrar / jerarquía de una idea. */
async function accionIdea(accion, id) {
  try {
    if (accion === 'duplicar') {
      const nuevo = await abrirDialogoIdea({
        titulo: 'Duplicar idea',
        texto: `Copia completa de «${id}», con este identificador:`,
        tipo: 'texto',
        valor: `${id}-copia`
      });
      if (!nuevo) return;
      await api(`/api/projects/${encodeURIComponent(id)}/duplicar`, { method: 'POST', body: JSON.stringify({ nuevoId: nuevo }) });
      toast('Idea duplicada', 'ok');
    } else if (accion === 'renombrar') {
      const nuevo = await abrirDialogoIdea({
        titulo: 'Renombrar idea',
        texto: `Nuevo identificador para «${id}» (cambia la carpeta):`,
        tipo: 'texto',
        valor: id
      });
      if (!nuevo || nuevo === id) return;
      await api(`/api/projects/${encodeURIComponent(id)}/renombrar`, { method: 'POST', body: JSON.stringify({ nuevoId: nuevo }) });
      toast('Idea renombrada', 'ok');
    } else if (accion === 'fusionar') {
      const opciones = (state.projects || [])
        .filter((p) => p.id !== id)
        .map((p) => ({ valor: p.id, etiqueta: p.id }));
      if (!opciones.length) return toast('No hay otra idea con la que fusionar', 'warn');
      const destino = await abrirDialogoIdea({
        titulo: 'Fusionar idea',
        texto: `«${id}» se volcará en la elegida y «${id}» irá a la papelera.`,
        tipo: 'lista',
        opciones
      });
      if (!destino || destino === id) return;
      await api(`/api/projects/${encodeURIComponent(id)}/fusionar`, { method: 'POST', body: JSON.stringify({ destino }) });
      toast(`Fusionada en ${destino}`, 'ok');
    } else if (accion === 'padre') {
      const opciones = candidatosPadre(id);
      if (!opciones.length) return toast('No hay ideas válidas como padre', 'warn');
      const padre = await abrirDialogoIdea({
        titulo: 'Mover bajo otra idea',
        texto: `Elige la idea padre de «${id}». No aparecen ella ni sus descendientes.`,
        tipo: 'lista',
        valor: state.parentes[id] || '',
        opciones
      });
      if (!padre || padre === id) return;
      await api(`/api/projects/${encodeURIComponent(id)}/padre`, { method: 'POST', body: JSON.stringify({ padre }) });
      toast('Jerarquía actualizada', 'ok');
    } else if (accion === 'soltar') {
      await api(`/api/projects/${encodeURIComponent(id)}/padre`, { method: 'POST', body: JSON.stringify({ padre: null }) });
      toast('Al primer nivel', 'ok');
    } else if (accion === 'borrar') {
      if (typeof window.confirm === 'function'
        && !window.confirm(`¿Borrar «${id}»? Irá a la papelera (recuperable).`)) return;
      await api(`/api/projects/${encodeURIComponent(id)}/borrar`, { method: 'POST' });
      toast('Idea a la papelera', 'ok');
    }
    await loadProjects();
  } catch (error) {
    toast(`No se pudo: ${error.message}`, 'err');
  }
}

/** Grafo de TODAS las ideas: jerarquía (padre→hijo) + linaje. */
function renderGrafoIdeas() {
  const cont = $('#ideas-grafo');
  if (!cont) return;
  cont.classList.toggle('hidden');
  if (cont.classList.contains('hidden')) return;
  const proyectos = state.projects || [];
  if (!proyectos.length) { cont.innerHTML = '<p class="muted">Sin ideas.</p>'; return; }
  const ids = new Set(proyectos.map((p) => p.id));
  const nodos = proyectos.map((p) => ({ id: p.id, title: p.id }));
  const aristas = [];
  const vistas = new Set();
  const add = (a, b) => {
    if (!a || !b || !ids.has(a) || !ids.has(b) || a === b) return;
    const k = [a, b].sort().join('|');
    if (vistas.has(k)) return;
    vistas.add(k);
    aristas.push({ origen: a, destino: b });
  };
  for (const [hijo, padre] of Object.entries(state.parentes)) add(padre, hijo);
  for (const l of (state.linaje || [])) add(l.de, l.idea);

  const ancho = Math.max(360, cont.clientWidth || 760);
  const alto = Math.max(340, cont.clientHeight || 440);
  repartir(nodos, aristas, ancho, alto, 240);
  const porId = new Map(nodos.map((n) => [n.id, n]));
  const lineas = aristas.map((e) => {
    const o = porId.get(e.origen); const d = porId.get(e.destino);
    if (!o || !d) return '';
    return `<line x1="${o.x.toFixed(1)}" y1="${o.y.toFixed(1)}" x2="${d.x.toFixed(1)}" y2="${d.y.toFixed(1)}" />`;
  }).join('');
  const conHijos = new Set(Object.values(state.parentes).filter(Boolean));
  const circulos = nodos.map((n) => {
    const color = conHijos.has(n.id) ? 'hsl(45, 80%, 60%)' : 'hsl(205, 90%, 62%)';
    const etiqueta = n.id.length > 16 ? `${n.id.slice(0, 15)}…` : n.id;
    return `<g class="mapa-nodo" data-nodo="${escapeHtml(n.id)}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})">`
      + `<circle r="13" fill="${color}" /><text y="27" text-anchor="middle">${escapeHtml(etiqueta)}</text></g>`;
  }).join('');
  cont.innerHTML = `<svg viewBox="0 0 ${ancho} ${alto}" preserveAspectRatio="xMidYMid meet" class="mapa-svg">`
    + `<g class="mapa-lineas">${lineas}</g>${circulos}</svg>`;
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
  clave: { nota: 'puntos-clave', titulo: 'Puntos clave' },
  dudas: { nota: 'dudas', titulo: 'Dudas del agente' }
};

/** Selector del contenedor de cada lista de seguimiento. */
const SEGUIMIENTO_LISTA = {
  preguntas: '#preguntas-list',
  clave: '#clave-list',
  dudas: '#dudas-list'
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
  const badges = [
    ['preguntas', '#badge-preguntas', 'pendiente(s) de evaluar'],
    ['clave', '#badge-clave', 'pendiente(s) de evaluar'],
    ['dudas', '#badge-dudas', 'duda(s) sin responder']
  ];
  for (const [tipo, id, etiqueta] of badges) {
    const el = $(id);
    if (!el) continue;
    const n = pendientesDe(tipo);
    el.classList.toggle('hidden', n === 0);
    el.title = n === 0 ? '' : `${n} ${etiqueta}`;
  }
}

function renderSeguimiento(tipo) {
  const cfg = SEGUIMIENTO[tipo];
  const cont = $(SEGUIMIENTO_LISTA[tipo]);
  if (!cont || !cfg) return;
  const esDuda = tipo === 'dudas';
  const nota = notaDeSeguimiento(tipo);
  if (!nota) {
    cont.innerHTML = `<div class="empty-state"><h2>Sin ${cfg.titulo.toLowerCase()} todavía</h2>`
      + `<p class="muted">${esDuda
        ? 'Aquí aparecerán las dudas que Jarvis no pueda resolver solo, para que las respondas una a una.'
        : 'Jarvis irá anotando aquí lo que merezca quedar registrado.'} `
      + `También puedes crear la nota <code>${cfg.nota}.md</code> en <code>conceptual/</code> `
      + `con listas <code>- [${esDuda ? ' ' : 'x'}]</code> (${esDuda ? 'sin responder' : 'registrado'}) `
      + `y <code>- [${esDuda ? 'x' : ' '}]</code> (${esDuda ? 'respondida' : 'pendiente'}).</p></div>`;
    return;
  }
  const { registrados, pendientes } = parseChecklist(nota.content);
  let html = '';

  if (pendientes.length) {
    html += `<div class="seg-grupo"><h3>${esDuda ? 'Sin responder' : 'Pendientes de evaluar'} <span class="seg-count">${pendientes.length}</span></h3>`;
    if (esDuda) {
      html += pendientes.map((it) => `
        <div class="seg-item seg-pendiente seg-duda">
          <span class="seg-texto">${escapeHtml(it.texto)}</span>
          <span class="seg-acciones">
            <button class="seg-btn seg-copy" data-seg-copiar="${escapeHtml(it.texto)}" title="Copiar">⧉</button>
            <button class="seg-btn seg-del" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="borrar" data-seg-texto="${escapeHtml(it.texto)}" title="Borrar definitivamente">✕</button>
          </span>
          <form class="seg-respuesta" data-seg-linea="${it.linea}">
            <input type="text" name="respuesta" placeholder="Escribe tu respuesta…" autocomplete="off" />
            <button type="submit" class="btn btn-primary btn-sm">Responder</button>
          </form>
        </div>`).join('');
    } else {
      html += pendientes.map((it) => `
        <div class="seg-item seg-pendiente">
          <span class="seg-texto">${escapeHtml(it.texto)}</span>
          <span class="seg-acciones">
            <button class="seg-btn seg-copy" data-seg-copiar="${escapeHtml(it.texto)}" title="Copiar">⧉</button>
            <button class="seg-btn seg-ok" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="guardar" title="Guardar (dejar de estar pendiente)">✓</button>
            <button class="seg-btn seg-del" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="borrar" data-seg-texto="${escapeHtml(it.texto)}" title="Borrar definitivamente">✕</button>
          </span>
        </div>`).join('');
    }
    html += '</div>';
  }

  if (registrados.length) {
    html += `<div class="seg-grupo"><h3>${esDuda ? 'Respondidas' : 'Registrados'} <span class="seg-count">${registrados.length}</span></h3>`;
    html += registrados.map((it) => `
        <div class="seg-item">
          <span class="seg-check" aria-hidden="true">✓</span>
          <span class="seg-texto">${escapeHtml(it.texto)}</span>
          <span class="seg-acciones">
            <button class="seg-btn seg-copy" data-seg-copiar="${escapeHtml(it.texto)}" title="Copiar">⧉</button>
            ${esDuda ? '' : `<button class="seg-btn seg-ir" data-seg-conv="${escapeHtml(it.texto)}" title="Ver en la conversación">↗</button>`}
            <button class="seg-btn seg-del" data-seg-tipo="${tipo}" data-seg-linea="${it.linea}" data-seg-accion="borrar" data-seg-texto="${escapeHtml(it.texto)}" title="Borrar definitivamente">✕</button>
          </span>
        </div>`).join('');
    html += '</div>';
  }

  cont.innerHTML = html || '<div class="empty-state"><p class="muted">Sin elementos todavía.</p></div>';
}

/**
 * Aplica `guardar`, `borrar` o `responder` a una línea del checklist y
 * devuelve las líneas nuevas (o `null` si la acción no cambia nada).
 * Es puro para poder probarlo sin red ni DOM.
 */
function editarLineaSeguimiento(lineas, i, accion, valor = '') {
  const copia = [...lineas];
  if (!Number.isInteger(i) || i < 0 || i >= copia.length) return null;
  if (accion === 'guardar') copia[i] = copia[i].replace(/\[(\s*)\]/, '[x]');
  else if (accion === 'borrar') copia.splice(i, 1);
  else if (accion === 'responder') {
    const respuesta = String(valor).replace(/\s+/g, ' ').trim();
    if (!respuesta) return null;
    const duda = copia[i].replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').trim();
    copia[i] = `- [x] ${duda} — ${respuesta}`;
  } else return null;
  return copia;
}

/** Guarda, borra o responde una línea reescribiendo la nota. */
async function resolverSeguimiento(tipo, linea, accion, valor = '') {
  const cfg = SEGUIMIENTO[tipo];
  const nota = notaDeSeguimiento(tipo);
  if (!cfg || !nota || !state.currentProjectId) return;
  const lineas = editarLineaSeguimiento(
    String(nota.content || '').split('\n'),
    Number(linea),
    accion,
    valor
  );
  if (!lineas) return;

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

/** Envía la respuesta escrita a una duda del agente. */
function manejarRespuestaDuda(event) {
  const form = event.target.closest('.seg-respuesta');
  if (!form) return;
  event.preventDefault();
  const input = typeof form.querySelector === 'function'
    ? (form.querySelector('input[name="respuesta"]') || form.querySelector('input'))
    : null;
  resolverSeguimiento('dudas', form.dataset.segLinea, 'responder', input ? input.value : '');
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
  if (tab === 'preguntas' || tab === 'clave' || tab === 'dudas') renderSeguimiento(tab);
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

/**
 * Notas que van al mapa: todas menos las de seguimiento (`preguntas`,
 * `dudas`, `puntos-clave`), que no son ideas. Se deriva de SEGUIMIENTO para
 * que una lista nueva quede excluida sola.
 */
function notasDelMapa(notes) {
  const seguimiento = new Set(Object.values(SEGUIMIENTO).map((c) => c.nota));
  return (notes || []).filter((n) => n && n.id && !seguimiento.has(n.id));
}

function renderMapa() {
  const cont = $('#mapa-graph');
  if (!cont) return;
  // Los ficheros de seguimiento no son ideas: fuera del mapa.
  const notas = notasDelMapa(state.notes);
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

/* ================================================================
   Adjuntos: ficheros que el usuario le pasa a la idea
   ----------------------------------------------------------------
   Viven en `<idea>/adjuntos/`. El agente los mueve a su sitio; aquí se
   pueden subir, mover, desasociar (sin borrar del disco) o borrar, con
   historial de todo.
   ================================================================ */
let adjuntosActuales = [];

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

async function cargarAdjuntos() {
  if (!state.currentProjectId) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/adjuntos`);
    adjuntosActuales = Array.isArray(data.adjuntos) ? data.adjuntos : [];
    renderAdjuntos(data.historial || [], data.orfaNos || []);
  } catch (error) {
    const cont = $('#adjuntos-list');
    if (cont) {
      cont.innerHTML = `<div class="empty-state"><p class="muted">No se pudieron leer los adjuntos: ${escapeHtml(error.message)}</p></div>`;
    }
  }
}

function renderAdjuntos(historial = [], orfaNos = []) {
  const aviso = $('#adjuntos-aviso');
  if (aviso) {
    if (orfaNos.length) {
      aviso.classList.remove('hidden');
      aviso.textContent = `⚠ ${orfaNos.length} fichero(s) desasociado(s) siguen en adjuntos/ sin estar en la lista: ${orfaNos.join(', ')}. Bórralos o muévelos si no los quieres.`;
    } else {
      aviso.classList.add('hidden');
      aviso.textContent = '';
    }
  }
  const cont = $('#adjuntos-list');
  if (cont) {
    if (!adjuntosActuales.length) {
      cont.innerHTML = '<div class="empty-state"><p class="muted">Sin adjuntos todavía. Sube el primero con «Elegir ficheros…».</p></div>';
    } else {
      cont.innerHTML = adjuntosActuales.map((a) => `
        <div class="adjunto-item">
          <span class="adjunto-ico" aria-hidden="true">📎</span>
          <span class="adjunto-nombre" title="${escapeHtml(a.nombre)}">${escapeHtml(a.nombre)}</span>
          <span class="adjunto-meta">${formatBytes(a.bytes)}${a.presente === false ? ' · ya no está' : ''}</span>
          <span class="adjunto-acciones">
            <button class="seg-btn" data-adj-mover="${escapeHtml(a.nombre)}" title="Mover a su sitio (p. ej. code/)">➜</button>
            <button class="seg-btn" data-adj-desasociar="${escapeHtml(a.nombre)}" title="Desasociar sin borrar del disco">⤺</button>
            <button class="seg-btn seg-del" data-adj-borrar="${escapeHtml(a.nombre)}" title="Borrar del disco">✕</button>
          </span>
        </div>`).join('');
    }
  }
  const hist = $('#adjuntos-historial');
  if (hist) {
    if (!historial.length) hist.innerHTML = '<p class="muted">Sin historial.</p>';
    else {
      hist.innerHTML = historial.map((h) => {
        const cuando = h.at ? new Date(h.at).toLocaleString() : '';
        const extra = h.destino ? ` → ${h.destino}` : (h.bytes ? ` (${formatBytes(h.bytes)})` : '');
        return `<div class="hist-item"><span class="hist-accion">${escapeHtml(h.accion || '')}</span> `
          + `<span class="hist-nombre">${escapeHtml(h.nombre || '')}</span>${escapeHtml(extra)} `
          + `<span class="hist-fecha">${escapeHtml(cuando)}</span></div>`;
      }).join('');
    }
  }
}

async function subirAdjuntos(fileList) {
  if (!state.currentProjectId) return;
  const archivos = Array.from(fileList || []);
  if (!archivos.length) return;
  let subidos = 0;
  for (const archivo of archivos) {
    try {
      const respuesta = await fetch(
        `/api/projects/${encodeURIComponent(state.currentProjectId)}/adjuntos?nombre=${encodeURIComponent(archivo.name)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archivo }
      );
      const datos = await respuesta.json().catch(() => ({}));
      if (!respuesta.ok) throw new Error(datos.error || `HTTP ${respuesta.status}`);
      subidos += 1;
    } catch (error) {
      toast(`No se pudo subir ${archivo.name}: ${error.message}`, 'err');
    }
  }
  if (subidos) toast(`${subidos} fichero(s) subido(s)`, 'ok');
  await cargarAdjuntos();
}

async function accionAdjunto(accion, nombre) {
  if (!state.currentProjectId) return;
  try {
    if (accion === 'mover') {
      const destino = window.prompt('¿A qué carpeta de la idea lo muevo? (code, conceptual, code/imagenes…)', 'code');
      if (!destino) return;
      await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/adjuntos/mover`, {
        method: 'POST', body: JSON.stringify({ nombre, destino })
      });
      toast(`Movido a ${destino}`, 'ok');
    } else if (accion === 'desasociar') {
      if (typeof window.confirm === 'function'
        && !window.confirm(`¿Desasociar «${nombre}»? El fichero NO se borra del disco.`)) return;
      await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/adjuntos/desasociar`, {
        method: 'POST', body: JSON.stringify({ nombre })
      });
      toast('Desasociado (el fichero sigue en el disco)', 'ok');
    } else if (accion === 'borrar') {
      if (typeof window.confirm === 'function'
        && !window.confirm(`¿Borrar «${nombre}» del disco? No se puede deshacer.`)) return;
      await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/adjuntos/borrar`, {
        method: 'POST', body: JSON.stringify({ nombre })
      });
      toast('Borrado del disco', 'ok');
    }
    await cargarAdjuntos();
  } catch (error) {
    toast(`No se pudo: ${error.message}`, 'err');
  }
}

function manejarAdjuntos(event) {
  const btn = event.target.closest('[data-adj-mover],[data-adj-desasociar],[data-adj-borrar]');
  if (!btn) return;
  if (btn.dataset.adjMover) accionAdjunto('mover', btn.dataset.adjMover);
  else if (btn.dataset.adjDesasociar) accionAdjunto('desasociar', btn.dataset.adjDesasociar);
  else if (btn.dataset.adjBorrar) accionAdjunto('borrar', btn.dataset.adjBorrar);
}

/* ---------------- Pestañas ---------------- */
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#pane-chat').classList.toggle('hidden', tab !== 'chat');
  $('#pane-conceptual').classList.toggle('hidden', tab !== 'conceptual');
  $('#pane-preguntas').classList.toggle('hidden', tab !== 'preguntas');
  $('#pane-clave').classList.toggle('hidden', tab !== 'clave');
  $('#pane-dudas').classList.toggle('hidden', tab !== 'dudas');
  $('#pane-mapa').classList.toggle('hidden', tab !== 'mapa');
  $('#pane-adjuntos').classList.toggle('hidden', tab !== 'adjuntos');
  $('#pane-code').classList.toggle('hidden', tab !== 'code');
  $('#pane-logs').classList.toggle('hidden', tab !== 'logs');
  $('#edit-toggle').classList.toggle('hidden', tab !== 'conceptual' || !state.currentNoteId);
  if (tab === 'logs') refreshTaskStatus();
  if (tab === 'chat') scrollChatToEnd();
  if (tab === 'preguntas' || tab === 'clave' || tab === 'dudas') renderSeguimiento(tab);
  if (tab === 'mapa') renderMapa();
  if (tab === 'adjuntos') cargarAdjuntos();
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

/* ---------------- Salud del servidor: temperatura, disco, memoria ---------------- */
function formateaBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

async function loadSalud() {
  try {
    return await api('/api/system/health');
  } catch {
    return null;
  }
}

function pintarSalud(s) {
  const box = $('#salud-info');
  if (!box) return;
  if (!s) { box.textContent = 'No se pudo leer la salud.'; return; }
  const fila = (clave, valor, clase = '') =>
    `<div class="fila"><span class="clave">${clave}</span><span class="valor ${clase}">${valor}</span></div>`;
  let html = '';
  const t = s.temperaturaC;
  html += fila('Temperatura', t == null ? 'no disponible' : `${Number(t).toFixed(1)} °C`,
    t == null ? '' : (t >= 75 ? 'aviso' : 'bien'));
  if (s.disco) {
    html += fila('Disco libre',
      `${formateaBytes(s.disco.libre)} de ${formateaBytes(s.disco.total)} (${s.disco.porcentaje}% usado)`,
      s.disco.porcentaje >= 90 ? 'aviso' : 'bien');
  }
  if (s.memoria) {
    html += fila('Memoria usada',
      `${formateaBytes(s.memoria.usada)} de ${formateaBytes(s.memoria.total)} (${s.memoria.porcentaje}%)`,
      s.memoria.porcentaje >= 90 ? 'aviso' : 'bien');
  }
  if (s.carga) {
    html += fila('Carga media',
      `${Number(s.carga.uno).toFixed(2)} / ${Number(s.carga.cinco).toFixed(2)} / ${Number(s.carga.quince).toFixed(2)} · ${s.carga.nucleos} núcleo(s)`);
  }
  if (s.uptimeS != null) {
    const horas = Math.floor(s.uptimeS / 3600);
    const dias = Math.floor(horas / 24);
    html += fila('Encendido desde hace', dias ? `${dias} d ${horas % 24} h` : `${horas} h`);
  }
  box.innerHTML = html;
}

function pintarPillSalud(s) {
  const pill = $('#salud-pill');
  if (!pill) return;
  if (!s) { pill.textContent = '🌡 ?'; return; }
  const t = s.temperaturaC;
  pill.textContent = t == null ? '🌡 —' : `🌡 ${Number(t).toFixed(0)}°`;
  pill.title = t == null
    ? 'Salud del servidor: pulsa para ver disco y memoria'
    : `Temperatura ${Number(t).toFixed(1)} °C · pulsa para ver disco y memoria`;
  pill.classList.toggle('dirty', t != null && t >= 75);
}

async function refreshSalud() {
  const s = await loadSalud();
  pintarPillSalud(s);
  return s;
}

async function abrirSalud() {
  const box = $('#salud-info');
  if (box) box.textContent = 'Cargando…';
  const dlg = $('#salud-dialog');
  if (dlg) { try { dlg.showModal(); } catch { /* ya abierto */ } }
  pintarSalud(await loadSalud());
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
  actualizarBotonHilos();

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
    // «Nueva» ya no tira el hilo: lo GUARDA y abre uno limpio.
    const r = await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/archivar`, { method: 'POST' });
    if (r && r.archivada) toast('Conversación guardada; la tienes en el botón 🗂', 'ok');
    actualizarBotonHilos();
  } catch (error) {
    toast(`Error al reiniciar: ${error.message}`, 'err');
  }
}

/** Opciones del selector de conversaciones (actual + archivadas). */
function opcionesHilos(data) {
  const opciones = [];
  const resumen = (x) => (x?.inicio ? ` · ${x.inicio}` : '');
  if (data?.actual?.mensajes) {
    opciones.push({ valor: '', etiqueta: `Actual${resumen(data.actual)} (${data.actual.mensajes} mensajes)` });
  }
  for (const a of (data?.archivadas || [])) {
    const cuando = a.modificadoEn ? new Date(a.modificadoEn).toLocaleString() : a.nombre;
    opciones.push({ valor: a.nombre, etiqueta: `${cuando}${resumen(a)} (${a.mensajes} mensajes)` });
  }
  return opciones;
}

/** Pone en el botón 🗂 cuántas conversaciones hay guardadas. */
async function actualizarBotonHilos() {
  const btn = $('#chat-hilos');
  if (!btn || !state.chat.projectId) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/conversaciones`);
    const n = (data.archivadas || []).length;
    btn.textContent = n ? `🗂 ${n}` : '🗂';
    btn.title = n
      ? `Conversaciones guardadas: ${n}. Pulsa para verlas o continuar una`
      : 'Conversaciones guardadas: todavía no hay ninguna';
  } catch { /* sin conexión */ }
}

/** Lista las conversaciones guardadas y permite continuar una. */
async function abrirHilos() {
  if (!state.chat.projectId) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/conversaciones`);
    const opciones = opcionesHilos(data);
    if (!opciones.length) return toast('Todavía no hay conversaciones guardadas', 'warn');

    const elegida = await abrirDialogoIdea({
      titulo: 'Conversaciones',
      texto: 'Elige una conversación guardada para continuarla. La actual se archivará.',
      tipo: 'lista',
      opciones
    });
    if (!elegida) return;
    if (typeof window.confirm === 'function'
      && !window.confirm('¿Continuar esa conversación? El agente recuperará los últimos mensajes.')) return;

    await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/continuar`, {
      method: 'POST',
      body: JSON.stringify({ nombre: elegida })
    });
    await resyncChat();
    actualizarBotonHilos();
    toast('Conversación recuperada', 'ok');
  } catch (error) {
    toast(`No se pudo: ${error.message}`, 'err');
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
  on('#dudas-list', 'click', manejarSeguimiento);
  on('#dudas-list', 'submit', manejarRespuestaDuda);

  // Adjuntos: subir (selector o arrastrar), mover / desasociar / borrar
  on('#adjuntos-elegir', 'click', () => { const i = $('#adjuntos-input'); if (i) i.click(); });
  on('#adjuntos-input', 'change', (event) => {
    subirAdjuntos(event.target.files);
    event.target.value = '';
  });
  on('#adjuntos-list', 'click', manejarAdjuntos);
  const zonaAdjuntos = $('#adjuntos-drop');
  if (zonaAdjuntos) {
    for (const ev of ['dragover', 'dragenter']) {
      zonaAdjuntos.addEventListener(ev, (e) => { e.preventDefault(); zonaAdjuntos.classList.add('dragover'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      zonaAdjuntos.addEventListener(ev, (e) => { e.preventDefault(); zonaAdjuntos.classList.remove('dragover'); });
    }
    zonaAdjuntos.addEventListener('drop', (e) => subirAdjuntos(e.dataTransfer?.files));
  }

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
  on('#ideas-grafo-btn', 'click', renderGrafoIdeas);
  on('#idea-grid', 'click', manejarGridIdea);
  on('#ideas-grafo', 'click', (event) => {
    const g = event.target.closest('[data-nodo]');
    if (g) selectProject(g.dataset.nodo);
  });
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
  on('#chat-hilos', 'click', abrirHilos);
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

  // --- Salud del servidor ---
  on('#salud-pill', 'click', abrirSalud);
  on('#salud-refresh', 'click', abrirSalud);

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

    await Promise.all([refreshGitStatus(), loadSystemStatus(), refreshSalud()]);
    setInterval(refreshGitStatus, 30000);
    setInterval(loadSystemStatus, 60000);
    setInterval(refreshSalud, 30000);
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
  cargarAdjuntos,
  renderAdjuntos,
  subirAdjuntos,
  candidatosPadre,
  descendientesDe,
  abrirDialogoIdea,
  formateaBytes,
  refreshSalud,
  pintarSalud,
  abrirHilos,
  opcionesHilos,
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
  confirmarBorrado,
  manejarRespuestaDuda,
  resolverSeguimiento,
  editarLineaSeguimiento,
  notasDelMapa
};

boot();
