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
  switchTab('chat');
  showEmptyConceptual();
  await refreshTaskStatus();
  openChat(projectId);
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
  $('#pane-chat').classList.toggle('hidden', tab !== 'chat');
  $('#pane-conceptual').classList.toggle('hidden', tab !== 'conceptual');
  $('#pane-code').classList.toggle('hidden', tab !== 'code');
  $('#pane-logs').classList.toggle('hidden', tab !== 'logs');
  $('#edit-toggle').classList.toggle('hidden', tab !== 'conceptual' || !state.currentNoteId);
  if (tab === 'logs') refreshTaskStatus();
  if (tab === 'chat') scrollChatToEnd();
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
  const modelSel = $('#chat-model');
  const effortSel = $('#chat-effort');
  modelSel.classList.add('loading');
  try {
    const { options, current } = await api(
      `/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/config`
    );
    fillModelSelect(modelSel, options, current);
    fillSimpleSelect(effortSel, options, 'reasoning_effort', current);
    modelSel.classList.remove('loading');
    if (current.error) toast(`Aviso del motor: ${current.error}`, 'err');
  } catch {
    modelSel.classList.remove('loading');
  }
}

function fillModelSelect(sel, options, current) {
  const opt = (options || []).find((o) => o.id === 'model' || o.category === 'model');
  sel.innerHTML = '';
  if (!opt?.options?.length) {
    sel.classList.add('hidden');
    return;
  }
  sel.classList.remove('hidden');
  for (const group of opt.options) {
    if (group.options) {
      const og = document.createElement('optgroup');
      og.label = group.name || group.group;
      for (const item of group.options) {
        const o = document.createElement('option');
        o.value = item.value;
        o.textContent = item.description ? `${item.name} — ${item.description}` : item.name;
        o.title = item.description || item.name;
        if (item.value === current.model) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    } else {
      const o = document.createElement('option');
      o.value = group.value;
      o.textContent = group.name;
      if (group.value === current.model) o.selected = true;
      sel.appendChild(o);
    }
  }
}

function fillSimpleSelect(sel, options, id, current) {
  const opt = (options || []).find((o) => o.id === id || o.category === 'thought_level');
  sel.innerHTML = '';
  if (!opt?.options?.length) {
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
  } catch (error) {
    toast(`No se pudo guardar: ${error.message}`, 'err');
    loadChatConfig();
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
  $('#chat-send').disabled = state.chat.busy;
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

    case 'thought':
      // El razonamiento no se pinta; está en la traza de la sesión de DSH.
      break;

    case 'tool-call':
      state.chat.messages.push({ role: 'tool', text: event.name, at: event.at });
      renderChat();
      break;

    case 'tool-done':
      updateLastTool(event);
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

/** Marca la última herramienta como terminada, sin duplicar entradas. */
function updateLastTool(event) {
  for (let i = state.chat.messages.length - 1; i >= 0; i -= 1) {
    const msg = state.chat.messages[i];
    if (msg.role === 'tool' && msg.name === event.name) return;  // ya está listada
  }
  state.chat.messages.push({ role: 'tool', text: event.name, at: event.at });
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

function renderChat() {
  const box = $('#chat-messages');
  const messages = state.chat.messages;
  box.innerHTML = '';

  if (!messages.length) {
    box.innerHTML = `
      <div class="chat-empty">
        <h2>Conversemos sobre esta idea</h2>
        <p class="muted">Aquí se desarrolla la parte conceptual. Cuando tengas claro el plan,
          usa la barra <strong>⌘</strong> de abajo para que Jarvis lo ejecute con agentes.</p>
      </div>`;
    updateTyping();
    return;
  }

  for (const msg of messages) {
    const wrap = document.createElement('div');
    const time = msg.at ? new Date(msg.at).toLocaleTimeString().slice(0, 5) : '';

    if (msg.role === 'user') {
      wrap.className = 'msg msg-user';
      wrap.innerHTML = `<div class="msg-bubble">${escapeHtml(msg.text)}</div>`;
    } else if (msg.role === 'assistant') {
      wrap.className = 'msg msg-assistant';
      wrap.innerHTML = `<div class="msg-bubble markdown">${renderMarkdown(msg.text || '')}</div>
        <div class="msg-meta">Jarvis${time ? ` · ${time}` : ''}</div>`;
    } else if (msg.role === 'tool') {
      wrap.className = 'msg-tool';
      wrap.textContent = `⚙ ${msg.text}`;
    } else if (msg.role === 'error') {
      wrap.className = 'msg-error';
      wrap.textContent = msg.text;
    } else {
      wrap.className = 'msg-note';
      wrap.textContent = msg.text;
    }
    box.appendChild(wrap);
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
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.chat.projectId) {
    toast('Selecciona primero una idea', 'err');
    return;
  }

  // Optimista: pintamos el mensaje ya mismo y vaciamos la caja.
  state.chat.messages.push({ role: 'user', text, at: new Date().toISOString() });
  input.value = '';
  renderChat();
  setChatStatus('running');

  try {
    await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  } catch (error) {
    state.chat.messages.push({ role: 'error', text: `No se pudo enviar: ${error.message}` });
    setChatStatus('error');
    renderChat();
  }
}

async function resetChat() {
  if (!state.chat.projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.chat.projectId)}/chat/reset`, { method: 'POST' });
  } catch (error) {
    toast(`Error al reiniciar: ${error.message}`, 'err');
  }
}

/** Detiene el turno en curso sin perder la memoria del agente. */
async function cancelChat() {
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

  // --- Chat ---
  $('#chat-form').addEventListener('submit', sendChatMessage);
  $('#chat-reset').addEventListener('click', resetChat);
  $('#chat-stop').addEventListener('click', cancelChat);
  $('#chat-model').addEventListener('change', (e) => saveChatConfig('model', e.target.value));
  $('#chat-effort').addEventListener('change', (e) => saveChatConfig('reasoning_effort', e.target.value));

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

  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // --- Panel de sistema ---
  $('#system-pill').addEventListener('click', abrirSistema);
  $('#system-update').addEventListener('click', pedirActualizacion);
  $('#system-check').addEventListener('click', buscarNovedades);
}

async function boot() {
  bindEvents();
  try {
    await loadProjects();
    await Promise.all([refreshGitStatus(), loadSystemStatus()]);
    setInterval(refreshGitStatus, 30000);
    setInterval(loadSystemStatus, 60000);
  } catch (error) {
    toast(`No se pudo conectar con Jarvis Core: ${error.message}`, 'err');
  }
}

boot();
