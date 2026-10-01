const $ = s => document.querySelector(s);
let token, busy = false, ready = false;
async function api(route, body) {
  const r = await fetch('/api/' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok || data.error) throw Error(data.error || 'Trainer request failed'); return data;
}
function message(text, error = false) { $('#message').textContent = text; $('#message').classList.toggle('error', error); }
function lock(value) { document.querySelectorAll('main section button,main section input,main section select').forEach(e => { e.disabled = value; }); }
async function refresh() {
  if (busy) return;
  try {
    const state = await api('state'); ready = state.writable;
    $('#light').classList.add('ready'); $('#connection').textContent = state.writable ? 'Connected' : 'Writes disabled';
    $('#health').textContent = `${Math.round(state.health)} / ${Math.round(state.maxHealth)}`;
    $('#work-status').textContent = state.busy ? 'Working…' : 'Ready';
    for (const [id, value] of Object.entries({ ...state.toggles, ...state.values })) { const e = document.querySelector(`[data-action="${id}"]`); if (e) e.checked = Boolean(value); }
    if (document.activeElement !== $('#speed')) { $('#speed').value = state.values.run; $('#speed-value').textContent = state.values.run.toFixed(2) + '×'; }
    lock(!ready || !!state.busy);
    if (!ready) message('Enable “Allow MCP compare-and-write” in PS Neighborhood → MCP bridge.', true);
  } catch (e) { ready = false; lock(true); $('#light').classList.remove('ready'); $('#connection').textContent = 'Not connected'; $('#work-status').textContent = 'Waiting for game'; message(e.message, true); }
}
async function perform(action, input = {}) {
  if (busy || !ready) return;
  busy = true; lock(true); $('#work-status').textContent = 'Working…'; message('Applying change. Keep the match running; leave the pause menu closed.');
  try { const r = await api('action', { action, input }); message(r.message || 'Change applied.'); }
  catch (e) { message(e.message, true); }
  finally { busy = false; await refresh(); }
}
function confirmation(title, text) {
  $('#confirm-title').textContent = title; $('#confirm-text').textContent = text;
  const d = $('#confirm'); d.showModal();
  return new Promise(resolve => {
    const finish = v => { d.close(); d.oncancel = null; $('#accept').onclick = null; $('#cancel').onclick = null; resolve(v); };
    $('#accept').onclick = () => finish(true); $('#cancel').onclick = () => finish(false); d.oncancel = e => { e.preventDefault(); finish(false); };
  });
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-tab]').forEach(n => n.classList.toggle('selected', n === b)); document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.tab; }); $('#heading').textContent = b.querySelector('span').textContent; });
document.querySelectorAll('[data-action]').forEach(e => e.onchange = () => perform(e.dataset.action, { value: e.checked }));
document.querySelectorAll('[data-button]').forEach(e => e.onclick = () => perform(e.dataset.button));
$('#speed').oninput = () => { $('#speed-value').textContent = Number($('#speed').value).toFixed(2) + '×'; };
$('#apply-speed').onclick = () => perform('run', { value: Number($('#speed').value) });
$('#spawn').onclick = () => perform('spawn', { model: $('#vehicle-model').value.trim(), enter: $('#enter-vehicle').checked });
$('#apply-weather').onclick = () => perform('weather', { value: $('#weather').value });
$('#apply-time').onclick = () => perform('time', { hour: Number($('#hour').value), minute: Number($('#minute').value) });
$('#apply-outfit').onclick = () => perform('outfit', { component: Number($('#component').value), drawable: Number($('#drawable').value), texture: Number($('#texture').value) });
$('#apply-model').onclick = async () => { if (await confirmation('Change character model?', 'This can interrupt story missions. Return to a story protagonist before saving or progressing.')) perform('model', { model: $('#ped-model').value.trim(), confirm: true }); };
for (const [id, title, text] of [
  ['prologue', 'Finish Prologue?', 'This advances the mission through its completion branch and may autosave or award story trophies. A captured memory snapshot is diagnostic only; it is not a restorable save backup.'],
  ['money', 'Add $10,000,000?', 'This changes the active protagonist’s saved cash balance.'],
  ['skills', 'Max current character’s skills?', 'This saves seven skill stats at 100 for your current protagonist.'],
  ['drop', 'Drop a $10,000 cash pickup?', 'Collecting the pickup changes your character’s saved balance.'],
  ['achievements', 'Request all trophy unlocks?', 'Trophies cannot be undone here. The game may reject unavailable IDs. This sends 77 requests and can take several minutes; do not press it again while working.']
]) $('#' + id).onclick = async () => { if (await confirmation(title, text)) perform(id, { confirm: true }); };
$('#refresh').onclick = refresh;
lock(true);
api('session').then(async s => { token = s.token; for (const [key, target] of [['vehicles', '#vehicle-list'], ['models', '#ped-list'], ['weather', '#weather']]) for (const value of s.catalog[key]) { const option = document.createElement('option'); option.value = value; option.textContent = value; $(target).append(option); } await refresh(); setInterval(refresh, 5000); }).catch(e => message(e.message, true));
