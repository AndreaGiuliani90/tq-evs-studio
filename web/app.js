// GAME STUDIO — interfaccia. Vanilla JS, nessun build: stato dal server + eventi in diretta (SSE).
import { avatarHTML, applyAvatarState, pulse, paintPortraits } from './avatars.js';
import { Office } from './office.js';
import { OfficeView } from './office-view.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const time = (ts) => (ts ? new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');

const S = { agents: {}, requests: {}, tasks: {}, chat: [], log: [], config: {}, lastSeq: 0, drawer: null };
const STATUS_IT = { IDLE: 'libero', THINKING: 'pensa', WORKING: 'lavora', WAITING: 'in attesa', TESTING: 'testa', BLOCKED: 'bloccato', DONE: 'fatto', ERROR: 'errore' };
const REQ_IT = { PLANNING: 'in pianificazione', RUNNING: 'in corso', DONE: 'completata', ANSWERED: 'risposta', NEEDS_USER: 'serve una tua decisione', FAILED: 'fallita', CANCELLED: 'annullata' };

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `errore ${r.status}`);
  return j;
}
function toast(text, bad) { const t = $('#toast'); t.textContent = text; t.className = `toast${bad ? ' bad' : ''}`; clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 4500); }
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ─── avvio ───────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  const st = await api('GET', '/api/state');
  for (const a of st.agents) S.agents[a.id] = a;
  for (const r of st.requests) S.requests[r.id] = r;
  for (const t of st.tasks) S.tasks[t.id] = t;
  S.chat = st.chat; S.config = st.config; S.lastSeq = st.lastSeq; S.costs = st.costs;
  S.office = new Office($('#office'), $('#office-overlay'), { onSelect: (id) => openDrawer(id), onBoard: () => openModal('costs') });
  S.view = new OfficeView($('#office-wrap'), $('#office-stage'), S.office);
  S.office.view = S.view;
  S.office.onFocusChange = (id) => { S.focus = id; renderFocus(); };
  for (const b of document.querySelectorAll('[data-zoom]')) b.onclick = () => { const z = b.dataset.zoom; if (z === 'fit') S.view.fit(true); else S.view.zoomBy(z === 'in' ? 1.5 : 1 / 1.5); };
  window.studioOffice = S.office;   // per le prove automatiche e per sperimentare dalla console
  await loadOffice();
  renderAll();
  connect();
}

async function loadOffice() {
  const layout = await api('GET', '/api/office');
  $('#office-name').textContent = layout.name || '';
  S.office.setAgents(Object.values(S.agents));
  S.office.costs = S.costs;
  S.office.setLayout(layout);
}

function connect() {
  const es = new EventSource(`/api/events?since=${S.lastSeq}`);
  es.addEventListener('studio', (m) => { const e = JSON.parse(m.data); if (e.seq <= S.lastSeq) return; S.lastSeq = e.seq; onEvent(e); });
  es.onopen = () => { $('#conn').className = 'conn on'; $('#conn').title = 'collegato'; };
  es.onerror = () => { $('#conn').className = 'conn off'; $('#conn').title = 'scollegato: riprovo…'; };
}

function onEvent(e) {
  const t = e.type;
  if (t === 'agent.updated' && e.agent) {
    S.agents[e.agentId] = e.agent; renderFloor(); renderDirector(); if (S.drawer === e.agentId) renderDrawer();
    S.office?.setAgents(Object.values(S.agents));
  } else if (t.startsWith('agent.') && e.agentId && S.agents[e.agentId]) {
    const a = S.agents[e.agentId];
    if (a && e.status) { a.runtime.status = e.status; if ('taskId' in e) { a.runtime.currentTaskId = e.taskId; a.runtime.currentTaskTitle = e.taskTitle ?? a.runtime.currentTaskTitle; } }
    if (a && e.text && t !== 'agent.status') { a.runtime.history.push({ ts: e.ts, status: e.status, taskId: e.taskId, text: e.text }); a.runtime.lastText = e.text; }
    updateDesk(e.agentId, t);
    S.office?.updateAgent(a); S.office?.event(e.agentId, t);
    if (e.agentId === 'director') renderDirector();
    if (S.drawer === e.agentId) renderDrawer();
    if (S.focus === e.agentId) renderFocus();
  }
  if (t === 'task.created' || t === 'task.updated') { S.tasks[e.task.id] = e.task; renderTasks(); refreshChips(e.task.requestId); if (S.drawer) renderDrawer(); }
  if (t === 'request.created' || t === 'request.updated') { S.requests[e.request.id] = e.request; renderTasks(); refreshChips(e.request.id); refreshActions(e.request.id); }
  if (t === 'chat.message') { S.chat.push(e.message); appendChat(e.message); }
  if (t === 'studio.warning') toast(e.text, true);
  if (t === 'office.updated') loadOffice().catch(() => {});
  if (t === 'costs.updated') { S.costs = e.costs; S.office?.setCosts(e.costs); if ($('#costs-box')) openModal('costs'); }
  if (!['agent.status', 'task.updated', 'agent.updated'].includes(t)) { S.log.unshift(e); if (S.log.length > 300) S.log.pop(); renderLog(); }
}

function renderAll() { renderFloor(); renderDirector(); renderChat(); renderTasks(); renderLog(); }

// ─── lo studio (postazioni) ──────────────────────────────────────────────────────────────────────
function visibleAgents() { return Object.values(S.agents).filter((a) => a.visible !== false && a.enabled !== false && a.id !== 'director'); }

function deskHTML(a) {
  const r = a.runtime || {};
  return `<div class="desk st-${r.status}" data-agent="${esc(a.id)}" tabindex="0" title="Apri i dettagli di ${esc(a.name)}">
    <div class="desk-furniture"><span class="monitor"></span><span class="prop"></span></div>
    ${avatarHTML(a, { size: 76 })}
    <div class="who"><div class="name">${esc(a.name)}</div><div class="role">${esc(a.role)}</div></div>
    <div class="badge b-${r.status}" title="${STATUS_IT[r.status] || ''}">${esc(r.status)}</div>
    <div class="curtask">${r.currentTaskTitle ? `“${esc(r.currentTaskTitle)}”` : '<span class="muted">nessun task</span>'}</div>
    <div class="bubble">${esc(r.lastText || r.history?.at(-1)?.text || '')}</div>
  </div>`;
}

function renderFloor() {
  const f = $('#floor');
  f.innerHTML = visibleAgents().map(deskHTML).join('') || '<p class="muted">Nessun agente visibile.</p>';
  for (const d of f.querySelectorAll('.desk')) {
    applyAvatarState(d, S.agents[d.dataset.agent]);
    d.onclick = () => openDrawer(d.dataset.agent);
    d.onkeydown = (ev) => { if (ev.key === 'Enter') openDrawer(d.dataset.agent); };
  }
}

// superzoom: scheda con il ritratto grande del personaggio inquadrato
function renderFocus() {
  const box = $('#office-focus');
  const a = S.focus && S.agents[S.focus];
  if (!a) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const r = a.runtime || {};
  box.innerHTML = `<div class="fc-head"><div class="fc-portrait">${avatarHTML(a, { size: 96 })}</div><div><h3>${esc(a.name)}</h3><div class="muted">${esc(a.role)}</div><span class="badge b-${esc(r.status || 'IDLE')}">${esc(r.status || 'IDLE')}</span></div></div>
    <div class="fc-task">${r.currentTaskTitle ? `“${esc(r.currentTaskTitle)}”` : '<span class="muted">nessun task in corso</span>'}</div>
    ${r.lastText ? `<div class="fc-act muted">${esc(r.lastText)}</div>` : ''}
    <div class="fc-btns"><button class="btn sm primary" data-fc="open">Scheda completa</button><button class="btn sm" data-fc="close">Torna alla stanza</button></div>`;
  box.classList.remove('hidden');
  paintPortraits(box); applyAvatarState(box, a);
  box.querySelector('[data-fc="open"]').onclick = () => openDrawer(a.id);
  box.querySelector('[data-fc="close"]').onclick = () => S.view.fit(true);
  box.onpointerdown = (e) => e.stopPropagation();
}

function updateDesk(id, evType) {
  const a = S.agents[id];
  const d = document.querySelector(`.desk[data-agent="${CSS.escape(id)}"]`);
  if (!a || a.visible === false || a.enabled === false || id === 'director') { if (d || evType === 'agent.updated') renderFloor(); return; }
  if (!d || evType === 'agent.updated') { renderFloor(); return; }
  const r = a.runtime;
  d.className = `desk st-${r.status}`;
  const b = d.querySelector('.badge'); b.className = `badge b-${r.status}`; b.textContent = r.status; b.title = STATUS_IT[r.status] || '';
  d.querySelector('.curtask').innerHTML = r.currentTaskTitle ? `“${esc(r.currentTaskTitle)}”` : '<span class="muted">nessun task</span>';
  if (r.lastText) { const bu = d.querySelector('.bubble'); bu.textContent = r.lastText; bu.classList.remove('pop'); void bu.offsetWidth; bu.classList.add('pop'); }
  applyAvatarState(d, a);
  pulse(d, evType);
}

function renderDirector() {
  const a = S.agents.director; if (!a) return;
  $('#director-avatar').innerHTML = avatarHTML(a, { size: 38 });
  $('#director-name').textContent = a.name;
  $('#director-status').textContent = `${a.runtime.status}${a.runtime.currentTaskTitle ? ' · ' + a.runtime.currentTaskTitle : ''}`;
  applyAvatarState($('.chat-head'), a);
}

// ─── chat ────────────────────────────────────────────────────────────────────────────────────────
function taskChips(reqId) {
  const ts = Object.values(S.tasks).filter((t) => t.requestId === reqId).sort((a, b) => a.id.localeCompare(b.id));
  if (!ts.length) return '';
  return ts.map((t) => { const a = S.agents[t.agentId]; return `<span class="chip c-${t.status}${t.superseded ? ' superseded' : ''}" data-task="${t.id}" title="${esc(t.id)} · ${esc(t.kind)} · ${esc(t.status)}">${esc(a?.avatar?.emoji || '•')} <b>${esc(a?.name || t.agentId)}</b> — ${esc(t.title)} <i>${esc(t.status)}${t.result?.verdict ? ' ' + t.result.verdict : ''}</i></span>`; }).join('');
}

function requestActions(req) {
  if (!req) return '';
  const b = [];
  if (req.quotePending) {
    const q = req.quote || {}, opts = q.options || [];
    b.push(`<button class="btn sm primary" data-act="quote-approve" data-req="${req.id}">Procedi (≈ $${Number(q.usd || 0).toFixed(2)})</button>`);
    if (q.usdLight != null) b.push(`<button class="btn sm" data-act="quote-light" data-req="${req.id}">Versione leggera (≈ $${Number(q.usdLight).toFixed(2)})</button>`);
    b.push(`<button class="btn sm" data-act="quote-cancel" data-req="${req.id}">No, lascia stare</button>`);
    const alt = opts.filter((o) => !o.current);
    if (alt.length) {
      const price = (o, l) => (o.plan ? 'incluso nel piano' : `≈ $${Number(l && o.usdLight != null ? o.usdLight : o.usd).toFixed(2)}`);
      b.push(`<div class="quote-alt">Oppure con <select data-quote-choice="${req.id}">${alt.map((o) => `<option value="${esc(o.id)}">${esc(o.label)} — ${price(o)}${o.usdLight != null && !o.plan ? ` · leggera ${price(o, true)}` : ''}</option>`).join('')}</select>${q.usdLight != null ? ` <label class="muted"><input type="checkbox" data-quote-light="${req.id}"> leggera</label>` : ''} <button class="btn sm" data-act="quote-choice" data-req="${req.id}">Procedi così</button></div>`);
    }
    return b.join('');
  }
  if (req.worktree && !req.discarded) b.push(`<a class="btn sm" href="/play/${req.id}/" target="_blank" rel="noopener">▶ Gioca questa versione</a>`, `<button class="btn sm" data-act="diff" data-req="${req.id}">Modifiche</button>`);
  if (req.status === 'DONE' && !req.merged && !req.discarded && (req.report?.commits?.length || req.report?.studioCommits?.length)) b.push(`<button class="btn sm primary" data-act="merge" data-req="${req.id}">Unisci in ${esc(req.baseBranch || 'main')}</button>`);
  if (req.merged) b.push(`<button class="btn sm" data-act="revert-merge" data-req="${req.id}">Annulla unione</button>`);
  if (['NEEDS_USER', 'FAILED'].includes(req.status) && req.worktree) b.push(`<button class="btn sm primary" data-act="retry" data-req="${req.id}">Riprova</button>`);
  if (['RUNNING', 'PLANNING', 'NEEDS_USER'].includes(req.status)) b.push(`<button class="btn sm" data-act="cancel" data-req="${req.id}">Ferma</button>`);
  if (req.branch && !req.discarded && !['RUNNING', 'PLANNING'].includes(req.status)) b.push(`<button class="btn sm danger" data-act="discard" data-req="${req.id}">Scarta</button>`);
  return b.join('');
}

function reportHTML(rep) {
  if (!rep) return '';
  return `<details class="report"><summary>Dettagli: ${rep.filesChanged?.length || 0} file · ${rep.commits?.length || 0} commit · ${rep.tests?.length || 0} test · esito <b class="v-${esc(rep.result)}">${esc(rep.result)}</b></summary>
    <h4>Agenti</h4><ul>${(rep.agents || []).map((a) => `<li><b>${esc(a.name)}</b> <span class="muted">${esc(a.role || '')}</span><br>${a.tasks.map(esc).join('<br>')}</li>`).join('')}</ul>
    <h4>Test</h4><ul>${(rep.tests || []).map((t) => `<li>${esc(t.taskId)} ${esc(t.agent)}: <b class="v-${esc(t.verdict)}">${esc(t.verdict)}</b> — ${esc(t.summary || '')}${(t.checks || []).length ? '<br><span class="muted">' + t.checks.map(esc).join(' · ') + '</span>' : ''}${(t.screenshots || []).length ? '<br>' + t.screenshots.map((s) => `<a href="/artifacts/${esc(t.taskId)}/${esc(s)}" target="_blank">${esc(s)}</a>`).join(' ') : ''}</li>`).join('') || '<li>nessuno</li>'}</ul>
    <h4>File cambiati</h4><ul>${(rep.filesChanged || []).map((f) => `<li><code>${esc(f.code)} ${esc(f.file)}</code></li>`).join('') || '<li>nessuno</li>'}</ul>
    <h4>Commit</h4><ul>${(rep.commits || []).map((c) => `<li><code>${esc(c)}</code></li>`).join('') || '<li>nessuno</li>'}</ul>${rep.studioCommits?.length ? `<h4>Programma dello Studio</h4><ul>${rep.studioCommits.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>` : ''}${rep.officeChanges?.length ? `<h4>Ufficio</h4><ul>${rep.officeChanges.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${rep.branch ? `<p class="muted">Branch <code>${esc(rep.branch)}</code> (base ${esc(rep.baseBranch)} @ ${esc(rep.baseCommit)})</p>` : ''}
  </details>`;
}

function msgHTML(m) {
  const a = m.agentId ? S.agents[m.agentId] : null;
  const who = m.role === 'user' ? 'Tu' : a ? a.name : 'Studio';
  const chips = m.kind === 'plan' || m.kind === 'report' || m.kind === 'escalation' ? `<div class="chips" data-req-chips="${esc(m.requestId)}">${taskChips(m.requestId)}</div>` : '';
  const actions = m.requestId && ['report', 'escalation', 'plan', 'quote'].includes(m.kind) ? `<div class="actions" data-req-actions="${esc(m.requestId)}">${requestActions(S.requests[m.requestId])}</div>` : '';
  return `<div class="msg m-${esc(m.role)} k-${esc(m.kind || 'text')}" data-id="${esc(m.id)}">
    ${m.role !== 'user' && a ? `<div class="mav">${avatarHTML(a, { size: 30 })}</div>` : ''}
    <div class="mbody"><div class="mhead"><b>${esc(who)}</b> <span class="muted">${time(m.ts)}${m.requestId ? ' · ' + esc(m.requestId) : ''}</span></div>
    <div class="mtext">${md(m.text)}</div>${m.attachments?.length ? `<div class="msg-att">${m.attachments.map((a) => /^image\//.test(a.type) ? `<a href="${esc(a.url)}" target="_blank"><img src="${esc(a.url)}" alt="${esc(a.name)}"></a>` : `<a class="file" href="${esc(a.url)}" target="_blank">📄 ${esc(a.name)}</a>`).join('')}</div>` : ''}${chips}${m.kind === 'report' ? reportHTML(m.report) : ''}${m.kind === 'question' ? '<div class="muted qhint">↳ Rispondi qui sotto (anche a voce): la richiesta riparte da dove era.</div>' : ''}${actions}</div></div>`;
}

function renderChat() {
  const c = $('#chat');
  c.innerHTML = S.chat.length ? S.chat.map(msgHTML).join('') : `<div class="empty">Scrivi alla Regia cosa vuoi cambiare nel gioco. Smista lei il lavoro alla squadra.<br><br><button class="btn sm" data-example>Prova: «Analizza il gioco e proponi un piccolo miglioramento da implementare come test. Implementalo e testalo.»</button></div>`;
  paintPortraits(c);
  c.scrollTop = c.scrollHeight;
}
function appendChat(m) {
  const c = $('#chat');
  if (c.querySelector('.empty')) c.innerHTML = '';
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  c.insertAdjacentHTML('beforeend', msgHTML(m));
  paintPortraits(c);
  if (nearBottom || m.role === 'user') c.scrollTop = c.scrollHeight;
}
function refreshChips(reqId) { for (const el of document.querySelectorAll(`[data-req-chips="${CSS.escape(reqId)}"]`)) el.innerHTML = taskChips(reqId); }
function refreshActions(reqId) { for (const el of document.querySelectorAll(`[data-req-actions="${CSS.escape(reqId)}"]`)) el.innerHTML = requestActions(S.requests[reqId]); }

// ─── allegati ────────────────────────────────────────────────────────────────────────────────────
S.pending = [];   // allegati caricati, in attesa di invio
function renderPending() {
  const box = $('#att-preview');
  box.classList.toggle('hidden', !S.pending.length);
  box.innerHTML = S.pending.map((a, i) => `<span class="att ${a.uploading ? 'uploading' : ''}">${/^image\//.test(a.type) && a.url ? `<img src="${esc(a.url)}" alt="">` : '📄'}<span>${esc(a.name)}</span><button type="button" data-rm="${i}" title="Togli">✕</button></span>`).join('');
  for (const b of box.querySelectorAll('[data-rm]')) b.onclick = () => { S.pending.splice(Number(b.dataset.rm), 1); renderPending(); };
}
async function addFiles(files) {
  for (const f of files) {
    if (f.size > 40 * 1024 * 1024) { toast(`${f.name}: troppo grande (massimo 40 MB)`, true); continue; }
    const item = { name: f.name || 'incollato.png', type: f.type, uploading: true };
    S.pending.push(item); renderPending();
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      Object.assign(item, await api('POST', '/api/uploads', { name: item.name, type: f.type, dataUrl }), { uploading: false });
    } catch (e) { S.pending.splice(S.pending.indexOf(item), 1); toast(`${item.name}: ${e.message}`, true); }
    renderPending();
  }
}
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = (ev) => { addFiles([...ev.target.files]); ev.target.value = ''; };
for (const zone of [$('.right'), $('#msg')]) {
  zone.addEventListener('dragover', (ev) => { ev.preventDefault(); $('.right').classList.add('dropping'); });
  zone.addEventListener('dragleave', () => $('.right').classList.remove('dropping'));
  zone.addEventListener('drop', (ev) => { ev.preventDefault(); $('.right').classList.remove('dropping'); if (ev.dataTransfer?.files?.length) addFiles([...ev.dataTransfer.files]); });
}
$('#msg').addEventListener('paste', (ev) => { const files = [...(ev.clipboardData?.files || [])]; if (files.length) { ev.preventDefault(); addFiles(files); } });

// ─── dettato vocale (riconoscimento del browser: Chrome, Safari, Edge) ─────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = { on: false, rec: null, base: '' };
try { const l = localStorage.getItem('studio:mic-lang'); if (l) $('#mic-lang').value = l; } catch { /* niente */ }
$('#mic-lang').onchange = () => { try { localStorage.setItem('studio:mic-lang', $('#mic-lang').value); } catch { /* niente */ } if (mic.on) { stopMic(); startMic(); } };
function startMic() {
  if (!SR) { toast('Il dettato vocale richiede Chrome, Safari o Edge.', true); return; }
  const rec = new SR();
  rec.lang = $('#mic-lang').value; rec.continuous = true; rec.interimResults = true;
  mic.base = $('#msg').value ? $('#msg').value.replace(/\s*$/, ' ') : '';
  rec.onresult = (ev) => {
    let fin = '', tmp = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript; else tmp += r[0].transcript; }
    if (fin) mic.base += fin.trim() + ' ';
    $('#msg').value = mic.base + tmp;
    $('#msg').scrollTop = $('#msg').scrollHeight;
  };
  rec.onerror = (ev) => { if (ev.error === 'not-allowed') { toast('Microfono non autorizzato: consenti l\'accesso nelle impostazioni del browser.', true); stopMic(); } };
  rec.onend = () => { if (mic.on) { try { rec.start(); } catch { /* si riprova al prossimo giro */ } } };
  mic.rec = rec; mic.on = true;
  try { rec.start(); } catch { /* già avviato */ }
  $('#btn-mic').classList.add('rec'); $('#btn-mic').title = 'Sto ascoltando… clic per finire';
}
function stopMic() { mic.on = false; try { mic.rec?.stop(); } catch { /* */ } $('#btn-mic').classList.remove('rec'); $('#btn-mic').title = 'Detta a voce'; }
$('#btn-mic').onclick = () => (mic.on ? stopMic() : startMic());
if (!SR) $('#btn-mic').title = 'Dettato non disponibile in questo browser (usa Chrome o Safari)';

$('#composer').onsubmit = act(async (ev) => {
  ev.preventDefault();
  if (mic.on) stopMic();
  const text = $('#msg').value.trim();
  if (S.pending.some((a) => a.uploading)) { toast('Aspetta che finiscano i caricamenti…'); return; }
  if (!text && !S.pending.length) return;
  const attachments = S.pending.map(({ id, name, type }) => ({ id, name, type }));
  $('#msg').value = ''; S.pending = []; renderPending();
  await api('POST', '/api/chat', { text, attachments });
});
$('#msg').onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#composer').requestSubmit(); } };

// azioni sui pulsanti (delegate)
document.addEventListener('click', act(async (ev) => {
  const el = ev.target.closest('[data-act],[data-task],[data-open],[data-example],[data-tab]');
  if (!el) return;
  if (el.dataset.example !== undefined) { $('#msg').value = 'Analizza il gioco attuale e dimmi un piccolo miglioramento che valga la pena implementare come test. Implementalo e testalo.'; $('#msg').focus(); return; }
  if (el.dataset.tab) { for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === el); $('#pane-tasks').classList.toggle('hidden', el.dataset.tab !== 'tasks'); $('#pane-log').classList.toggle('hidden', el.dataset.tab !== 'log'); return; }
  if (el.dataset.open) return openModal(el.dataset.open);
  if (el.dataset.act === 'office-undo') { if (confirm('Annullare l\'ultima modifica all\'ufficio (arredo e aspetto dei personaggi)?')) { const r = await api('POST', '/api/office/undo'); toast(`Ufficio riportato a com'era (${new Date(r.restoredFrom).toLocaleString('it-IT')}).`); } return; }
  if (el.dataset.task && !el.dataset.act) return showTask(el.dataset.task);
  const req = el.dataset.req;
  switch (el.dataset.act) {
    case 'diff': return showDiff(req);
    case 'merge': if (confirm('Unire le modifiche nel tuo branch? Si può annullare in ogni momento.')) { await api('POST', `/api/requests/${req}/merge`); toast('Unito.'); } return;
    case 'revert-merge': if (confirm('Annullare l\'unione (crea un commit di revert)?')) { await api('POST', `/api/requests/${req}/revert-merge`); toast('Unione annullata.'); } return;
    case 'retry': await api('POST', `/api/requests/${req}/retry`); return;
    case 'cancel': await api('POST', `/api/requests/${req}/cancel`); return;
    case 'quote-approve': await api('POST', `/api/requests/${req}/quote`, { action: 'approve' }); return;
    case 'quote-light': await api('POST', `/api/requests/${req}/quote`, { action: 'light' }); return;
    case 'quote-choice': await api('POST', `/api/requests/${req}/quote`, { action: 'approve', choice: document.querySelector(`[data-quote-choice="${req}"]`)?.value, light: !!document.querySelector(`[data-quote-light="${req}"]`)?.checked }); return;
    case 'quote-cancel': await api('POST', `/api/requests/${req}/quote`, { action: 'cancel' }); return;
    case 'discard': if (confirm('Scartare il lavoro di questa richiesta (branch e copia di lavoro)?')) await api('POST', `/api/requests/${req}/discard`); return;
    case 'close': return closeModal();
    case 'close-drawer': return closeDrawer();
    default: return undefined;
  }
}));

// ─── pannello task e attività ────────────────────────────────────────────────────────────────────
function renderTasks() {
  const reqs = Object.values(S.requests).filter((r) => r.taskIds?.length).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 25);
  $('#pane-tasks').innerHTML = reqs.map((r) => `<div class="req">
    <div class="req-head"><b>${esc(r.id)}</b> <span class="rs rs-${esc(r.status)}">${esc(REQ_IT[r.status] || r.status)}</span> ${esc(r.text.slice(0, 90))}${r.branch ? ` <code class="muted">${esc(r.branch)}</code>` : ''}${r.merged ? ' <span class="rs rs-DONE">unita</span>' : ''}</div>
    <table class="tasks"><tbody>${Object.values(S.tasks).filter((t) => t.requestId === r.id).sort((a, b) => a.id.localeCompare(b.id)).map((t) => `<tr data-task="${t.id}" class="${t.superseded ? 'superseded' : ''}">
      <td><code>${t.id}</code></td><td>${esc(S.agents[t.agentId]?.name || t.agentId)}</td><td class="muted">${esc(t.kind)}</td><td>${esc(t.title)}</td>
      <td><span class="chip c-${t.status}">${t.status}${t.result?.verdict ? ' ' + t.result.verdict : ''}</span></td>
      <td class="muted">${t.dependsOn.length ? '← ' + t.dependsOn.join(', ') : ''}</td><td class="muted">${t.result?.commit ? t.result.commit.short : ''}</td></tr>`).join('')}</tbody></table>
    <div class="actions">${requestActions(r)}</div></div>`).join('') || '<p class="muted pad">Nessun task ancora.</p>';
}

const LOG_ICON = { 'agent.started_task': '▶', 'agent.thinking': '💭', 'agent.editing': '✎', 'agent.testing': '🎮', 'agent.waiting': '⏳', 'agent.completed': '✔', 'agent.failed': '✘', 'agent.blocked': '⛔', 'git.commit': '⎇', 'git.merge': '⇲', 'chat.message': '💬', 'task.created': '＋', 'request.created': '★', 'request.updated': '↻' };
function renderLog() {
  $('#pane-log').innerHTML = `<ul class="log">${S.log.slice(0, 200).map((e) => `<li><span class="muted">${time(e.ts)}</span> ${LOG_ICON[e.type] || '·'} <code>${esc(e.type)}</code> ${esc(e.agentId ? (S.agents[e.agentId]?.name || e.agentId) : '')} ${esc(e.text || e.task?.title || e.request?.status || e.message?.text?.slice(0, 80) || e.commit?.slice?.(0, 7) || '')}</li>`).join('')}</ul>` || '';
}

// ─── dettaglio agente (drawer) ───────────────────────────────────────────────────────────────────
function openDrawer(id) { S.drawer = id; renderDrawer(); $('#drawer').classList.remove('hidden'); }
function closeDrawer() { S.drawer = null; $('#drawer').classList.add('hidden'); }

function renderDrawer() {
  const a = S.agents[S.drawer]; if (!a) return;
  const d = $('#drawer');
  if (d.contains(document.activeElement) && document.activeElement.closest('form')) {
    // non ridisegnare il form mentre l'utente scrive: aggiorna solo le sezioni vive
    const live = d.querySelector('.live'); if (live) live.innerHTML = drawerLive(a); return;
  }
  const av = a.avatar || {};
  const ch = av.character || {};
  d.innerHTML = `<div class="dr-head">${avatarHTML(a, { size: 64 })}<div><h2>${esc(a.name)}</h2><div class="muted">${esc(a.role)} · <code>${esc(a.id)}</code></div></div><button class="btn sm" data-act="close-drawer">✕</button></div>
    <div class="live">${drawerLive(a)}</div>
    <h3>Configurazione</h3>
    <form id="agent-form" class="form">
      <label>Nome <input name="name" value="${esc(a.name)}"></label>
      <label>Ruolo (etichetta) <input name="role" value="${esc(a.role)}"></label>
      <label>Descrizione <textarea name="description" rows="2">${esc(a.description)}</textarea></label>
      <fieldset><legend>Avatar</legend>
        <label>Tipo <select name="av_type">${['pixel', 'emoji', 'image', 'spritesheet'].map((t) => `<option ${av.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <div class="row-wrap char-fields">
          <label>Pelle <input name="ch_skin" type="color" value="${esc(ch.skin || '#e8b48a')}"></label>
          <label>Capelli <input name="ch_hair" type="color" value="${esc(ch.hair || '#3b2a20')}"></label>
          <label>Maglia <input name="ch_shirt" type="color" value="${esc(ch.shirt || av.color || '#888888')}"></label>
          <label>Accessorio (colore) <input name="ch_accColor" type="color" value="${esc(ch.accColor || '#2a2a33')}"></label>
          <label>Occhi <input name="ch_eyes" type="color" value="${esc(ch.eyes || '#3a6fb0')}"></label>
          <label>Pettinatura <select name="ch_hairStyle">${['short', 'spiky', 'long', 'bob', 'ponytail', 'bun', 'curly', 'bald'].map((t) => `<option ${ch.hairStyle === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Vestito <select name="ch_outfit">${['tee', 'shirt', 'hoodie', 'sweater', 'apron', 'labcoat', 'vest'].map((t) => `<option ${ch.outfit === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Barba <select name="ch_facial">${['none', 'beard', 'moustache', 'stubble'].map((t) => `<option ${ch.facial === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Accessorio <select name="ch_accessory">${['none', 'glasses', 'headphones', 'beret', 'cap', 'headband', 'earrings'].map((t) => `<option ${ch.accessory === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        <label>Emoji <input name="av_emoji" value="${esc(av.emoji || '')}" maxlength="8"></label>
        <label>Colore <input name="av_color" type="color" value="${esc(av.color || '#888888')}"></label>
        <label>Stile visivo <input name="av_style" value="${esc(av.style || '')}" placeholder="pixel, flat, …"></label>
        <label>Immagine o spritesheet (png) <input name="av_file" type="file" accept="image/*"></label>
        <label>Fotogramma sprite (L×A px) <span class="row"><input name="sp_w" type="number" value="${esc(av.sprite?.frameWidth || 32)}"><input name="sp_h" type="number" value="${esc(av.sprite?.frameHeight || 32)}"></span></label>
        <label>Animazioni sprite (JSON: nome → {row, frames, fps}) <textarea name="sp_anims" rows="2" placeholder='{"typing":{"row":1,"frames":4,"fps":8}}'>${esc(av.sprite?.animations ? JSON.stringify(av.sprite.animations) : '')}</textarea></label>
        <label>Stato → animazione (JSON) <textarea name="av_anims" rows="2" placeholder='{"WORKING":"typing"}'>${esc(av.animations ? JSON.stringify(av.animations) : '')}</textarea></label>
      </fieldset>
      <label>Provider testo/codice <select name="provider">${['auto', 'claude-code', 'codex', 'gemini', 'anthropic', 'mock'].map((p) => `<option ${a.provider === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label>Modello (vuoto = predefinito) <input name="model" value="${esc(a.model || '')}" placeholder="Claude: sonnet, opus, haiku · Codex/Gemini: vuoto = predefinito"></label>
      <label>Provider immagini (se l'agente genera immagini) <select name="imageProvider">${[['auto', 'auto (il primo configurato)'], ['openai-image', 'GPT Image (qualità dal file .env)'], ['openai-image:medium', 'GPT Image · qualità media (più economica)'], ['gemini-image', 'Nano Banana (modello dal file .env)'], ['gemini-image:gemini-3.1-flash-image', 'Nano Banana 2'], ['gemini-image:gemini-3-pro-image', 'Nano Banana Pro'], ['plan', 'Codex col piano ChatGPT (sperimentale, solo se l\'agente usa Codex)']].map(([v, l]) => `<option value="${v}" ${(a.imageProvider || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Tipi di task gestiti (separati da virgola) <input name="kinds" value="${esc((a.kinds || []).join(', '))}"></label>
      <label>Capacità (separate da virgola) <input name="capabilities" value="${esc((a.capabilities || []).join(', '))}"></label>
      <label>Documenti di contesto <input name="contextDocs" value="${esc((a.contextDocs || []).join(', '))}"></label>
      <label class="check"><input type="checkbox" name="enabled" ${a.enabled !== false ? 'checked' : ''}> attivo</label>
      <label class="check"><input type="checkbox" name="visible" ${a.visible !== false ? 'checked' : ''}> visibile nello studio</label>
      <label>Istruzioni di sistema <textarea name="systemInstructions" rows="8">${esc(a.systemInstructions)}</textarea></label>
      <div class="row"><button class="btn primary" type="submit">Salva</button><button class="btn" type="button" id="agent-reset">Ripristina predefinito</button></div>
    </form>`;
  paintPortraits(d);
  $('#agent-form').onsubmit = act(async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const list = (k) => String(f.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
    const parse = (k) => { const v = String(f.get(k) || '').trim(); if (!v) return undefined; try { return JSON.parse(v); } catch { throw new Error(`JSON non valido in "${k}"`); } };
    const avatar = { ...(a.avatar || {}), type: f.get('av_type'), emoji: f.get('av_emoji'), color: f.get('av_color'), style: f.get('av_style'),
      character: { skin: f.get('ch_skin'), hair: f.get('ch_hair'), shirt: f.get('ch_shirt'), accColor: f.get('ch_accColor'), hairStyle: f.get('ch_hairStyle'), accessory: f.get('ch_accessory'), eyes: f.get('ch_eyes'), outfit: f.get('ch_outfit'), facial: f.get('ch_facial') } };
    const anims = parse('av_anims'); if (anims) avatar.animations = anims; else delete avatar.animations;
    if (avatar.sprite) { avatar.sprite = { ...avatar.sprite, frameWidth: Number(f.get('sp_w')), frameHeight: Number(f.get('sp_h')), animations: parse('sp_anims') || avatar.sprite.animations || {} }; }
    const patch = { name: f.get('name'), role: f.get('role'), description: f.get('description'), avatar, provider: f.get('provider'), model: f.get('model'), kinds: list('kinds'), capabilities: list('capabilities'), contextDocs: list('contextDocs'), enabled: f.get('enabled') === 'on', visible: f.get('visible') === 'on', systemInstructions: f.get('systemInstructions') };
    if (f.get('imageProvider')) patch.imageProvider = f.get('imageProvider');
    await api('PUT', `/api/agents/${a.id}`, patch);
    const file = f.get('av_file');
    if (file && file.size) {
      const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
      await api('POST', `/api/agents/${a.id}/avatar`, { dataUrl, kind: f.get('av_type') === 'spritesheet' ? 'spritesheet' : 'image', frameWidth: f.get('sp_w'), frameHeight: f.get('sp_h'), animations: parse('sp_anims') });
    }
    document.activeElement?.blur();
    toast('Agente salvato.');
  });
  $('#agent-reset').onclick = act(async () => { if (confirm('Ripristinare nome, ruolo, avatar e istruzioni predefiniti?')) { await api('POST', `/api/agents/${a.id}/reset`); toast('Ripristinato.'); } });
}

function drawerLive(a) {
  const r = a.runtime || {};
  const mine = Object.values(S.tasks).filter((t) => t.agentId === a.id).sort((x, y) => y.id.localeCompare(x.id));
  const cur = S.tasks[r.currentTaskId];
  const depLine = (t) => {
    const deps = t.dependsOn.map((id) => S.tasks[id]).filter(Boolean).map((d) => `${d.id} ${S.agents[d.agentId]?.name || d.agentId} (${d.status})`);
    const waiting = Object.values(S.tasks).filter((x) => x.dependsOn.includes(t.id)).map((d) => `${d.id} ${S.agents[d.agentId]?.name || d.agentId}`);
    return `${deps.length ? `dipende da: ${deps.map(esc).join(', ')}` : 'nessuna dipendenza'}${waiting.length ? ` · lo aspettano: ${waiting.map(esc).join(', ')}` : ''}`;
  };
  const errors = mine.filter((t) => t.status === 'FAILED' || t.lastError);
  return `<div class="badge b-${r.status}">${esc(r.status)}</div> <span class="muted">${esc(STATUS_IT[r.status] || '')}</span>
    <h3>Task corrente</h3>${cur ? `<div class="card" data-task="${cur.id}"><b>${esc(cur.id)}</b> ${esc(cur.title)}<br><span class="muted">${esc(depLine(cur))}</span></div>` : `<p class="muted">${esc(r.currentTaskTitle || 'nessuno')}</p>`}
    <h3>Dipendenze dei task aperti</h3><ul>${mine.filter((t) => ['PENDING', 'RUNNING'].includes(t.status)).map((t) => `<li data-task="${t.id}"><code>${t.id}</code> ${esc(t.title)} — <span class="muted">${esc(depLine(t))}</span></li>`).join('') || '<li class="muted">nessuno</li>'}</ul>
    <h3>Attività recente</h3><ul class="log">${(r.history || []).slice(-25).reverse().map((h) => `<li><span class="muted">${time(h.ts)}</span> <code>${esc(h.status || '')}</code> ${esc(h.text)}</li>`).join('') || '<li class="muted">niente</li>'}</ul>
    <h3>Task completati (${mine.filter((t) => t.status === 'DONE').length})</h3><ul>${mine.filter((t) => t.status === 'DONE').slice(0, 15).map((t) => `<li data-task="${t.id}"><code>${t.id}</code> ${esc(t.title)} ${t.result?.verdict ? `<b class="v-${t.result.verdict}">${t.result.verdict}</b>` : ''} ${t.result?.commit ? `<code>${t.result.commit.short}</code>` : ''}</li>`).join('') || '<li class="muted">nessuno</li>'}</ul>
    <h3>Errori</h3><ul>${errors.slice(0, 10).map((t) => `<li data-task="${t.id}"><code>${t.id}</code> ${esc(t.title)}: <span class="bad">${esc((t.lastError || t.result?.summary || t.status).slice(0, 300))}</span></li>`).join('') || '<li class="muted">nessuno</li>'}</ul>`;
}

// ─── finestre ────────────────────────────────────────────────────────────────────────────────────
function modal(html) { $('#modal-box').innerHTML = `<button class="btn sm close" data-act="close">✕</button>${html}`; paintPortraits($('#modal-box')); $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').onclick = (ev) => { if (ev.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeModal(); closeDrawer(); } });

async function showTask(id) {
  const t = await api('GET', `/api/tasks/${id}`); if (!t) return;
  const r = t.result || {};
  modal(`<h2>${esc(t.id)} — ${esc(t.title)}</h2>
    <p><span class="chip c-${t.status}">${t.status}${r.verdict ? ' ' + r.verdict : ''}</span> · ${esc(S.agents[t.agentId]?.name || t.agentId)} · ${esc(t.kind)} · tentativo ${t.attempt}${t.loop ? ` · giro di correzione ${t.loop}` : ''}${t.superseded ? ` · sostituito da ${esc(t.superseded)}` : ''}</p>
    <h3>Istruzioni</h3><pre>${esc(t.instructions)}</pre>
    ${t.bugReport ? `<h3>Bug report</h3><pre>${esc(t.bugReport)}</pre>` : ''}
    ${r.summary ? `<h3>Risultato</h3><p>${md(r.summary)}</p>` : ''}
    ${r.bugs?.length ? `<h3>Bug</h3><ul>${r.bugs.map((b) => `<li><b>${esc(b.title)}</b><br>Passi: ${esc(b.steps)}<br>Atteso: ${esc(b.expected)}<br>Ottenuto: ${esc(b.actual)}</li>`).join('')}</ul>` : ''}
    ${r.checks?.length ? `<h3>Verifiche</h3><ul>${r.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${r.harness ? `<h3>Test automatico</h3><pre>${esc(r.harness.summary)}</pre><div class="shots">${(r.harness.screenshots || []).map((s) => { const n = s.split('/').pop(); return `<a href="/artifacts/${t.id}/${esc(n)}" target="_blank"><img src="/artifacts/${t.id}/${esc(n)}" alt="${esc(n)}"></a>`; }).join('')}</div>` : ''}
    ${r.images?.length ? `<h3>Immagini</h3><ul>${r.images.map((i) => `<li><code>${esc(i.file)}</code> — ${esc(i.status)} ${esc(i.reason || '')}</li>`).join('')}</ul>` : ''}
    ${r.commit ? `<p>Commit <code>${esc(r.commit.short)}</code>: ${r.commit.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}
    ${t.lastError ? `<h3>Ultimo errore</h3><pre class="bad">${esc(t.lastError)}</pre>` : ''}
    ${r.output ? `<details><summary>Output completo dell'agente</summary><pre>${esc(r.output)}</pre></details>` : ''}
    <h3>Registro</h3><ul class="log">${t.log.map((l) => `<li><span class="muted">${time(l.ts)}</span> ${esc(l.text)}</li>`).join('')}</ul>`);
}

async function showDiff(reqId) {
  const d = await api('GET', `/api/requests/${reqId}/diff`);
  const lines = (d.diff || '').split('\n').map((l) => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l)}</span>`).join('\n');
  modal(`<h2>Modifiche di ${esc(reqId)}</h2><pre>${esc(d.summary?.stat || 'nessuna')}</pre><h3>Commit</h3><ul>${(d.summary?.commits || []).map((c) => `<li><code>${esc(c.short)}</code> ${esc(c.author)} — ${esc(c.subject)}</li>`).join('')}</ul><pre class="diff">${lines}</pre>`);
}

async function openModal(which) {
  if (which === 'costs') {
    const c = S.costs || { totalUsd: 0, providers: [] };
    const paid = c.providers.filter((p) => !p.included), inc = c.providers.filter((p) => p.included);
    const n = (p) => [p.images ? `${p.images} immagini` : '', p.runs ? `${p.runs} lavori` : ''].filter(Boolean).join(' · ');
    modal(`<div id="costs-box"><h2>Spese dello Studio</h2><p class="muted">Dal ${new Date(c.since).toLocaleDateString('it-IT')}. Solo subtotali: quanto ha speso lo Studio finora.</p>
      <table class="costs"><tbody>${paid.map((p) => `<tr><td>${esc(p.label)}</td><td class="muted">${n(p)}</td><td class="num">$${p.usd.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nessuna spesa a consumo finora.</td></tr>'}
      <tr class="tot"><td><b>Totale speso</b></td><td></td><td class="num"><b>$${Number(c.totalUsd).toFixed(2)}</b></td></tr>
      ${inc.map((p) => `<tr class="inc"><td>${esc(p.label)}</td><td class="muted">${n(p)}</td><td class="num">incluso</td></tr>`).join('')}</tbody></table>
      <p class="muted">Gli importi delle API sono stime dai prezzi di listino (config/studio.default.json → imagePrices); il conto vero è sulle pagine di fatturazione di OpenAI e Google. Gli abbonamenti non costano extra: qui vedi solo quante volte li usiamo.</p>
      <button class="btn sm danger" id="costs-reset">Azzera la lavagna</button></div>`);
    $('#costs-reset').onclick = act(async () => { if (confirm('Azzerare i conteggi delle spese?')) { await api('POST', '/api/costs/reset'); } });
    return;
  }
  if (which === 'agents') {
    modal(`<h2>Gestione agenti</h2><p class="muted">Nomi, ruoli e avatar sono dati: cambiali quando vuoi. Lo Studio instrada il lavoro per capacità, non per nome.</p>
      <div class="agent-list">${Object.values(S.agents).map((a) => `<div class="agent-row">${avatarHTML(a, { size: 36 })}<div><b>${esc(a.name)}</b> <span class="muted">${esc(a.role)} · ${esc(a.id)}${a.visible === false ? ' · nascosto' : ''}${a.enabled === false ? ' · disattivo' : ''}</span></div><button class="btn sm" data-edit="${esc(a.id)}">Modifica</button></div>`).join('')}</div>
      <h3>Nuovo agente</h3><form id="new-agent" class="form row-wrap"><input name="id" placeholder="id (es. sound)" required><input name="name" placeholder="nome"><input name="role" placeholder="ruolo"><input name="kinds" placeholder="tipi di task (es. audio)"><button class="btn">Crea</button></form>`);
    for (const b of document.querySelectorAll('[data-edit]')) b.onclick = () => { closeModal(); openDrawer(b.dataset.edit); };
    $('#new-agent').onsubmit = act(async (ev) => { ev.preventDefault(); const f = new FormData(ev.target); const k = String(f.get('kinds') || '').split(',').map((s) => s.trim()).filter(Boolean); await api('POST', '/api/agents', { id: f.get('id'), name: f.get('name'), role: f.get('role'), kinds: k, capabilities: k }); closeModal(); toast('Agente creato.'); });
  }
  if (which === 'memory') {
    const docs = await api('GET', '/api/memory');
    modal(`<h2>Memoria del progetto</h2><p class="muted">Conoscenza strutturata condivisa dagli agenti (non la chat). I documenti curati sono versionati nel repository del gioco, in <code>docs/memoria/</code>; TASKS e AGENT_ACTIVITY sono generati.</p>
      <div class="mem"><ul class="mem-list">${docs.map((d) => `<li><button class="btn sm wide" data-doc="${d.name}">${d.name}${d.generated ? ' ⚙' : ''}</button></li>`).join('')}</ul><div class="mem-edit"><p class="muted">Scegli un documento.</p></div></div>`);
    for (const b of document.querySelectorAll('[data-doc]')) b.onclick = act(async () => {
      const doc = await api('GET', `/api/memory/${b.dataset.doc}`);
      const gen = docs.find((x) => x.name === b.dataset.doc)?.generated;
      $('.mem-edit').innerHTML = `<h3>${esc(doc.name)}</h3><textarea id="doc-text" rows="24" ${gen ? 'readonly' : ''}>${esc(doc.content)}</textarea>${gen ? '' : '<button class="btn primary" id="doc-save">Salva</button> <span class="muted">(la parte "Stato vivo" in fondo si rigenera da sola: non serve salvarla)</span>'}`;
      const save = $('#doc-save');
      if (save) save.onclick = act(async () => { await api('PUT', `/api/memory/${doc.name}`, { content: $('#doc-text').value.split('\n\n---\n## Stato vivo del repository')[0] }); toast('Salvato.'); });
    });
  }
  if (which === 'git') {
    const g = await api('GET', '/api/git');
    const reqs = Object.values(S.requests).filter((r) => r.branch).sort((a, b) => b.id.localeCompare(a.id));
    modal(`<h2>Git</h2>${g.available ? '' : '<p class="bad">La cartella del gioco non è un repository git: lo Studio non modificherà file.</p>'}
      <p>Branch attuale: <code>${esc(g.status.branch)}</code> @ <code>${esc(g.status.head)}</code> — ${g.status.clean ? 'nessuna modifica in sospeso' : `<span class="bad">${g.status.changes.length} modifiche non committate</span> (lo Studio non le tocca)`}</p>
      <h3>Branch dello Studio</h3><ul>${reqs.map((r) => `<li><code>${esc(r.branch)}</code> — ${esc(r.id)} ${esc(REQ_IT[r.status] || r.status)}${r.merged ? ' · <b>unito</b> ' + esc(r.mergeCommit?.slice(0, 7) || '') : ''}${r.discarded ? ' · scartato' : ''}<div class="actions">${requestActions(r)}</div></li>`).join('') || '<li class="muted">nessuno</li>'}</ul>
      <h3>Ultimi commit</h3><ul>${g.commits.map((c) => `<li><code>${esc(c.short)}</code> ${esc(c.subject)} <span class="muted">${esc(c.author)}, ${esc(c.when)}</span></li>`).join('')}</ul>
      <h3>Ripristino</h3><p class="muted">Ogni unione è un merge separato: "Annulla unione" crea un revert. A mano: <code>git log --merges</code> e poi <code>git revert -m 1 &lt;commit&gt;</code>.</p>`);
  }
  if (which === 'settings') {
    const [prov, cfg] = await Promise.all([api('GET', '/api/providers'), api('GET', '/api/config')]);
    modal(`<h2>Impostazioni</h2><h3>Provider AI</h3><table class="tasks">${prov.map((p) => `<tr><td><b>${esc(p.id)}</b></td><td class="muted">${esc(p.kind === 'image' ? 'immagini' : 'testo/codice')}</td><td>${p.ok ? '✔ ' + esc(p.version || p.model || p.note || 'pronto') : '· ' + esc(p.reason)}</td><td>${p.kind === 'image' && p.ok ? `<button class="btn sm" data-imgtest="${esc(p.id)}">Prova</button>` : ''}</td></tr>`).join('')}</table>
      <div id="imgtest-out" class="shots"></div>
      <p class="muted">"auto" usa il primo disponibile: Claude Code (la CLI <code>claude</code> già autenticata sul Mac) → API Anthropic → nessun AI. Le chiavi vanno nel file <code>.env</code> dello Studio (vedi <code>.env.example</code>), poi si riavvia lo Studio. Non vengono mai salvate in git.</p>
      <h3>Studio</h3><form id="cfg" class="form">
        <label>Tentativi per task in errore <input name="maxTaskRetries" type="number" min="0" max="5" value="${cfg.maxTaskRetries}"></label>
        <label>Giri massimi test → correzione → ritest <input name="maxFixLoops" type="number" min="1" max="8" value="${cfg.maxFixLoops}"></label>
        <label>Tempo massimo per task (minuti) <input name="taskTimeoutMin" type="number" min="1" value="${cfg.taskTimeoutMin}"></label>
        <label>Personaggi generati dall'AI: fotogrammi per agente <select name="avatarFrames"><option value="full" ${cfg.avatarFrames !== 'light' ? 'selected' : ''}>completi (13: tutte le animazioni)</option><option value="light" ${cfg.avatarFrames === 'light' ? 'selected' : ''}>leggeri (6: meno costo)</option></select></label>
        <label>Stratega (sceglie i modelli per ogni task) <select name="strategist"><option value="ai" ${(cfg.strategist ?? 'ai') === 'ai' ? 'selected' : ''}>valuta con l'AI (consigliato)</option><option value="rules" ${cfg.strategist === 'rules' ? 'selected' : ''}>solo regole fisse (più veloce)</option></select></label>
        <label>Chiedi il preventivo se la spesa extra supera $ <input type="number" name="quoteThresholdUsd" min="0" step="0.5" value="${esc(cfg.quoteThresholdUsd ?? 0)}" style="width:5em"> <span class="muted">(0 = per qualsiasi spesa extra; il lavoro incluso nel piano parte da solo; scrivi "preventivo" per averlo comunque)</span></label>
        <label class="check"><input type="checkbox" name="qaBrowser" ${cfg.qaBrowser ? 'checked' : ''}> il QA prova il gioco nel browser (Playwright)</label>
        <label class="check"><input type="checkbox" name="autoMerge" ${cfg.autoMerge ? 'checked' : ''}> unisci da solo quando i test passano</label>
        <label class="check"><input type="checkbox" name="directorProseReport" ${cfg.directorProseReport ? 'checked' : ''}> rapporto finale scritto dalla Regia</label>
        <button class="btn primary">Salva</button></form>`);
    for (const b of document.querySelectorAll('[data-imgtest]')) b.onclick = act(async () => {
      b.disabled = true; b.textContent = 'Genero…';
      try { const r = await api('POST', `/api/providers/${b.dataset.imgtest}/test`, { prompt: 'pixel art, top-down view, a small Italian village square at night with a stone fountain and warm lanterns, detailed, cozy' }); $('#imgtest-out').insertAdjacentHTML('beforeend', `<a href="${esc(r.url)}" target="_blank"><img src="${esc(r.url)}" title="${esc(b.dataset.imgtest)}"></a>`); }
      finally { b.disabled = false; b.textContent = 'Prova'; }
    });
    $('#cfg').onsubmit = act(async (ev) => { ev.preventDefault(); const f = new FormData(ev.target); const c = await api('PUT', '/api/config', { maxTaskRetries: Number(f.get('maxTaskRetries')), maxFixLoops: Number(f.get('maxFixLoops')), taskTimeoutMin: Number(f.get('taskTimeoutMin')), qaBrowser: f.get('qaBrowser') === 'on', autoMerge: f.get('autoMerge') === 'on', directorProseReport: f.get('directorProseReport') === 'on', avatarFrames: f.get('avatarFrames'), quoteThresholdUsd: Number(f.get('quoteThresholdUsd') || 0), strategist: f.get('strategist') }); S.config = c; toast('Impostazioni salvate.'); });
  }
}

boot().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="bad pad">Lo Studio non risponde: ${esc(e.message)}. È acceso? (./start-studio.sh)</p>`); });
