const $ = s => document.querySelector(s);
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const { token } = await (await fetch('/api/session')).json();
let state, busy = false;
async function request(url, body) {
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await r.json(); if (!r.ok) throw Error(result.error); return result;
}
function message(text, error = false) { $('#message').textContent = text; $('#message').className = error ? 'error' : ''; }
function card(f) {
  const disabled = !f.verified || !state.writesEnabled ? 'disabled' : '';
  const active = state.freeze.active && state.freeze.field === f.id;
  const controls = f.control === 'toggle'
    ? `<button data-field="${f.id}" data-toggle="${1 - f.value}" aria-pressed="${!!f.value}" ${disabled}>${f.value ? 'Disable' : 'Enable'}</button>`
    : `<input id="value-${f.id}" type="${f.control === 'range' ? 'range' : 'number'}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${f.default}" aria-label="${escape(f.label)} target"><output id="target-${f.id}">${f.default}</output><button data-field="${f.id}" ${f.freeze ? `data-freeze="${!active}"` : ''} ${disabled}>${f.freeze ? active ? 'Stop freeze' : 'Freeze clip' : 'Apply'}</button>${f.reset !== undefined ? `<button class="secondary" data-field="${f.id}" data-reset="${f.reset}" ${disabled}>Reset</button>` : ''}`;
  return `<article data-card="${f.id}"><div class="eyebrow">${escape(f.label)}</div><div class="value" data-value="${f.id}">${f.control === 'toggle' ? f.value ? 'ON' : 'OFF' : f.value.toLocaleString()}</div><div class="controls">${controls}</div><small>${escape(f.help || (f.freeze ? 'Repeated refill while this trainer is open. Starting pistol only.' : 'Confirmed in game.'))}</small></article>`;
}
async function refresh() {
  if (busy) return;
  busy = true;
  const inputs = Object.fromEntries([...document.querySelectorAll('input[id^="value-"]')].map(i => [i.id, i.value]));
  const focused = document.activeElement?.id;
  try {
    state = await request('/api/state');
    $('#connection').textContent = `${state.titleId} · PID ${state.pid} · ${state.writesEnabled ? 'Write controls enabled' : 'Read only'}`;
    $('#note').textContent = state.note;
    $('#fields').innerHTML = state.fields.filter(f => f.group !== 'perks').map(card).join('');
    $('#perks').innerHTML = state.fields.filter(f => f.group === 'perks').map(card).join('');
    for (const [id, value] of Object.entries(inputs)) if ($('#' + id)) { $('#' + id).value = value; $('#target-' + id.slice(6)).textContent = value; }
    if (focused && $('#' + focused)) $('#' + focused).focus();
    $('#freeze-status').textContent = state.freeze.active ? `Clip freeze active · target ${state.freeze.value}` : state.freeze.error ? `Freeze stopped: ${state.freeze.error}` : 'Clip freeze off';
    if (!state.writesEnabled) {
      $('#spawn-weapon').disabled = true; $('#upgrade-weapon').disabled = true;
      message('Enable “Allow MCP compare-and-write” in PS Neighborhood → MCP bridge.');
    }
  } catch (e) {
    $('#connection').textContent = 'Waiting for an active Zombies player';
    document.querySelectorAll('[data-field]').forEach(b => b.disabled = true);
    $('#spawn-weapon').disabled = true; $('#upgrade-weapon').disabled = true;
    message(e.message, true);
  } finally { busy = false; }
}
$('#refresh').addEventListener('click', refresh);
$('#stop-freeze').addEventListener('click', async () => {
  try { await request('/api/freeze', { active: false }); $('#freeze-status').textContent = 'Clip freeze off'; message('Clip freeze stopped'); }
  catch (e) { message(e.message, true); }
});
document.addEventListener('input', e => { if (e.target.id.startsWith('value-')) $('#target-' + e.target.id.slice(6)).textContent = e.target.value; });
document.addEventListener('click', async e => {
  const button = e.target.closest('[data-field]'); if (!button || busy) return;
  busy = true; button.disabled = true;
  try {
    const field = button.dataset.field, value = Number(button.dataset.toggle ?? button.dataset.reset ?? $('#value-' + field)?.value);
    const freezing = button.dataset.freeze !== undefined;
    const result = await request(freezing ? '/api/freeze' : '/api/apply', { field, value, active: button.dataset.freeze === 'true' });
    message(freezing ? result.active ? `Clip frozen at ${value}` : 'Clip freeze stopped' : `${result.field}: ${result.before} → ${result.after} · memory verified`);
  } catch (e) { message(e.message, true); }
  finally { busy = false; await refresh(); }
});
const weaponName = n => n.replace(/_upgraded_zm$/, ' · Pack-a-Punched').replace(/_zm$/, '').replaceAll('_', ' ');
$('#load-weapons').addEventListener('click', async () => {
  if (busy) return; busy = true;
  try {
    const c = await request('/api/weapons');
    $('#held-weapon').textContent = `Equipped: ${weaponName(c.held || 'unknown')} · ${c.primaryCount}/${c.primaryLimit} primary weapons`;
    $('#weapon-list').innerHTML = c.weapons.sort((a,b) => a.name.localeCompare(b.name)).map(w => `<option value="${escape(w.name)}">${escape(weaponName(w.name))}</option>`).join('');
    $('#spawn-weapon').disabled = !state?.writesEnabled || !c.weapons.length;
    $('#upgrade-weapon').disabled = !state?.writesEnabled || !c.weapons.some(w => w.name === c.held?.replace(/_zm$/, '_upgraded_zm'));
  } catch (e) { message(e.message, true); }
  finally { busy = false; }
});
for (const id of ['spawn-weapon', 'upgrade-weapon']) $('#' + id).addEventListener('click', async () => {
  if (busy) return; busy = true;
  try {
    const r = await request('/api/weapon', { weapon: $('#weapon-list').value, upgrade: id === 'upgrade-weapon' });
    message(`${weaponName(r.weapon)} replaced your held ${weaponName(r.replaced)}. Holstered weapon preserved.${r.equipped ? '' : ' Cycle weapons if the view has not updated.'}${r.gameplayObserved ? ' Retained during the live check.' : ' Unpause to check it in game.'}`);
  } catch (e) { message(e.message, true); }
  finally { busy = false; await refresh(); }
});
await refresh();
setInterval(() => { if (!document.activeElement?.matches('input') && !busy) refresh(); }, 2500);
