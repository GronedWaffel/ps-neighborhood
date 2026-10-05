const host=document.createElement('section');host.id='remote-support';document.body.append(host);
host.innerHTML=`<button id="support-open">Remote support</button><button id="support-quick-stop" hidden>Disconnect support</button>
<dialog id="support-dialog" aria-labelledby="support-title"><div class="support-head"><h2 id="support-title">Remote support <small>Support Build</small></h2><button id="support-hide" aria-label="Close support panel">×</button></div>
<p>Let a Snipers support operator inspect your connected console. Your PC connects to our relay; no router setup is needed.</p>
<p id="support-console"></p><p>Console file reads, process lists and live memory reads are available during the session. Local console controls pause until you disconnect.</p>
<label><input type="checkbox" id="support-actions"> Allow support actions: send ELF payloads and change memory with expected-byte checks</label>
<p class="support-note">Only enable actions for a test you have agreed to. A payload may crash the console. Disconnect stops further access and active transfers, but cannot undo commands already executed.</p>
<div class="support-controls"><button id="support-start">Start support session</button><button id="support-stop" disabled>Disconnect now</button></div>
<p id="support-status" role="status" aria-live="polite">Not connected.</p><div id="support-pair" hidden><p>Share this one-use code privately with Snipers support:</p><strong id="support-code"></strong><button id="support-copy">Copy code</button></div>
<p class="support-note">Pair within 5 minutes. Sessions last at most one hour. Closing the app or losing the relay connection ends access; it will not reconnect automatically.</p>
<ol id="support-events"></ol></dialog>`;
const q=id=>host.querySelector('#'+id);let state={active:false},starting=false;
const token=(await(await fetch('/api/session')).json()).token;
async function call(method,args={}){const r=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({method,args})});const j=await r.json();if(!r.ok)throw Error(j.error);return j.result;}
function paint(){
  q('support-start').disabled=state.active||starting;q('support-actions').disabled=state.active||starting;
  q('support-stop').disabled=!(state.active||starting);q('support-quick-stop').hidden=!(state.active||starting);
  q('support-open').textContent=state.active?(state.paired?'Support connected':'Support waiting'):'Remote support';host.classList.toggle('support-active',state.active);
  q('support-status').textContent=starting?'Starting session…':state.active?(state.paired?'Operator connected · '+(state.actions?'support actions enabled':'diagnostics only'):'Waiting for operator · '+(state.actions?'support actions enabled':'diagnostics only')):'Disconnected. Remote access is off.';
  q('support-pair').hidden=!state.active||!state.code;q('support-code').textContent=state.code||'';
  q('support-events').replaceChildren(...(state.events||[]).map(e=>{const li=document.createElement('li');li.textContent=new Date(e.time).toLocaleTimeString()+' — '+e.text;return li;}));
}
async function refresh(){try{state=await call('support_status');paint();}catch(e){q('support-status').textContent='Unable to read support status: '+e.message;}}
q('support-open').onclick=async()=>{q('support-dialog').showModal();try{const s=await call('status');q('support-console').textContent='Selected console: '+s.profile.platform.toUpperCase()+' · '+s.profile.host+' · FTP '+s.profile.ftpPort+' · ELF '+s.profile.payloadPort;}catch{}await refresh();};
q('support-hide').onclick=()=>q('support-dialog').close();
q('support-start').onclick=async()=>{starting=true;paint();try{state=await call('support_start',{actions:q('support-actions').checked});}catch(e){state={active:false,events:[{time:new Date().toISOString(),text:e.message}]};}finally{starting=false;paint();}};
async function stop(){try{state=await call('support_stop');starting=false;paint();}catch(e){q('support-status').textContent='Close the app to end access. Disconnect request failed: '+e.message;}}
q('support-stop').onclick=stop;q('support-quick-stop').onclick=stop;
q('support-copy').onclick=async()=>{try{await navigator.clipboard.writeText(state.code||'');q('support-copy').textContent='Copied';}catch{q('support-status').textContent='Select and copy the code shown above.'}};
setInterval(refresh,1500);await refresh();
