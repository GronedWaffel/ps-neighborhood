async function session(){const r=await fetch('/api/session');return r.ok?r.json():null;}
let connected=await session();
if(!connected){
  document.querySelector('#app').innerHTML=`<main class="web-pair"><p class="web-kicker">PS NEIGHBORHOOD · WEB · IN DEVELOPMENT</p><h1>Your console.<br>Your neighborhood.</h1><p>We are building a PS5-side bridge so you can use Neighborhood here without downloading the Windows app. Console-direct access is not released yet.</p><p>The PC-companion preview release has been withdrawn. Your existing desktop app and MCP still work. <a href="https://github.com/GronedWaffel/ps-neighborhood/releases/tag/v0.13.0" target="_blank" rel="noopener">Desktop release</a></p><details><summary>Already running the companion preview?</summary><p>Choose <strong>Website → Start website session</strong> in that preview, enter its code here, then approve on your PC.</p><form id="pair-form"><label for="pair-code">Companion pairing code</label><input id="pair-code" autocomplete="off" spellcheck="false" required placeholder="Paste your code"><button type="submit">Connect companion</button></form><p id="pair-status" role="status"></p><p class="web-note">Keep the companion running. File pickers and confirmations appear on that PC.</p></details></main>`;
  await new Promise(resolve=>{
    document.querySelector('#pair-form').onsubmit=async e=>{
      e.preventDefault();const button=e.target.querySelector('button'),status=document.querySelector('#pair-status');button.disabled=true;status.textContent='Approve the website connection on your companion PC…';
      try{
        const r=await fetch('/web/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.querySelector('#pair-code').value})});const b=await r.json();if(!r.ok)throw Error(b.error);
        connected=await session();if(!connected)throw Error('Session cookie unavailable. Allow cookies for this site and pair again.');resolve();
      }catch(e){status.textContent=e.message;button.disabled=false;}
    };
  });
}
if(connected.website){
  document.body.classList.add('website-mode');
  async function native(action,args={}){
    const note=document.querySelector('#web-connection');if(note)note.textContent='Waiting for companion PC… File dialogs and confirmations open there.';
    try{const r=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connected.token},body:JSON.stringify({method:'native:'+action,args})});const b=await r.json();if(!r.ok)throw Error(b.error);return b.result;}
    finally{if(note)note.textContent='Connected to your companion · Files and operations run on its PC';}
  }
  window.desktop={chooseFile:()=>native('choose-file'),chooseFolder:()=>native('choose-folder'),openExports:()=>native('open-exports'),openSaves:()=>native('open-saves'),confirmSaveRestore:args=>native('confirm-save-restore',args),confirmConsole:args=>native('confirm-console',args),mcpConfig:()=>native('mcp-config')};
  const bar=document.createElement('div');bar.id='web-bar';bar.innerHTML='<span id="web-connection">Connected to your companion · Files and operations run on its PC</span><button id="web-disconnect">Disconnect website</button>';document.body.append(bar);
  document.querySelector('#web-disconnect').onclick=async()=>{await fetch('/web/disconnect',{method:'POST',headers:{Authorization:'Bearer '+connected.token}});location.reload();};
  setInterval(async()=>{try{if(!await session()){document.querySelector('#web-connection').textContent='Companion disconnected. Reload this page to pair again. Running PC jobs are not automatically cancelled.';document.body.classList.add('web-offline');}}catch{document.querySelector('#web-connection').textContent='Website connection lost. Check the companion before retrying an action.';}},5000);
}
await import('./app.js');
if(!connected.website)await import('./web-companion.js');
