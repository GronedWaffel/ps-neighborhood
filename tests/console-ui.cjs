const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
app.setPath('userData',path.join(root,'artifacts','console-ui-userdata'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const {startServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')).href);
  const backend=await startServer({directory:path.join(root,'artifacts','console-ui-'+Date.now())});
  const caps=Object.fromEntries(['appInfo','storage','launch','close','uninstall','patch','shutdown','restart','rest'].map(x=>[x,true]));
  const fallback={host:'192.0.2.1',updatedAt:new Date().toISOString(),capabilities:caps,warnings:[],drives:[{index:0,path:'/user',total:400e9,free:350e9,available:320e9,used:50e9}],categories:[{drive:'/user',category:'games',bytes:40e9},{drive:'/user',category:'patches',bytes:5e9}],games:[{titleId:'CUSA12345',name:'Example <Game>',version:'01.03',baseBytes:40e9,patchBytes:5e9,dlcBytes:0,totalBytes:45e9,locations:['/user'],managed:true,running:false}],saves:[{id:'123abc:CUSA12345',titleId:'CUSA12345',userId:'123abc',name:'Example <Game>',bytes:16e6,files:2}]};
  const snapshot=process.env.PSN_VISUAL_FIXTURE?JSON.parse(await fs.readFile(process.env.PSN_VISUAL_FIXTURE)):fallback;
  backend.workbench.console.snapshot=snapshot;backend.workbench.packages.receiver.ready=true;backend.workbench.packages.receiver.host=backend.workbench.profile.host;
  if(snapshot.compatibility?.detected)backend.workbench.packages.receiver.runtimeInfo={firmware:snapshot.compatibility.detected,revision:2};
  backend.workbench.console.action=async()=>{throw Error('Cancelled UI action must never reach backend');};
  const win=new BrowserWindow({width:1510,height:1000,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}}),errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const js=c=>win.webContents.executeJavaScript(c),click=s=>js(`document.querySelector(${JSON.stringify(s)}).click()`);
  const until=async c=>{for(let i=0;i<100;i++){if(await js(c))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timed out: '+c);};
  try{
    await win.loadURL(backend.url+'/#console');await until('!!document.querySelector("[data-console-action=patch]:not(:disabled)")');
    assert.ok(await js('document.querySelector("#console-storage").textContent.includes("Reserved free space")'));
    assert.ok(await js('document.querySelector("#console-saves").textContent.includes("Download save")'));
    await js('void(window.desktop={confirmConsole:async()=>false})');await click('[data-console-action=patch]:not(:disabled)');
    await js('document.querySelector("#console-search").value="no-such-game";document.querySelector("#console-search").dispatchEvent(new Event("input",{bubbles:true}))');
    assert.ok(await js('document.querySelector("#console-games").textContent.includes("No games to show")'));
    await js('document.querySelector("#console-search").value="";document.querySelector("#console-search").dispatchEvent(new Event("input",{bubbles:true}))');
    if(!process.env.PSN_VISUAL_FIXTURE)assert.ok(await js('document.querySelector("#console-games").textContent.includes("Example <Game>")'));
    await fs.mkdir(path.join(root,'artifacts/screenshots'),{recursive:true});
    await fs.writeFile(path.join(root,'artifacts/screenshots/console-storage.png'),(await win.webContents.capturePage()).toPNG());
    if(snapshot.games.some(g=>g.content?.maps?.length)){
      await js('void(document.querySelectorAll(".console-content").forEach(e=>e.open=true))');
      await js('document.querySelector("#console-games").scrollIntoView({block:"start"})');
      assert.ok(await js('document.querySelector("#console-games").textContent.includes("Package 01.10")'));
      assert.ok(await js('document.querySelector("#console-games").textContent.includes("Origins")'));
      assert.ok(await js('document.querySelector("[data-console-action=patch][data-title-id=CUSA57548]").disabled'));
      await new Promise(r=>setTimeout(r,250));
      await fs.writeFile(path.join(root,'artifacts/screenshots/console-content.png'),(await win.webContents.capturePage()).toPNG());
    }
    await js('document.querySelector("#console-open-saves").scrollIntoView({block:"center"})');
    await fs.writeFile(path.join(root,'artifacts/screenshots/console-saves.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js('document.querySelectorAll("#toasts .error").length'),0);assert.deepEqual(errors,[]);
    console.log('PASS: Console page, capacity breakdown, escaped game names, search, backup controls and cancelled removal confirmation.');
    backend.workbench.packages.receiver.ready=false;await backend.close();win.destroy();app.exit(0);
  }catch(e){console.error(e);backend.workbench.packages.receiver.ready=false;await backend.close();win.destroy();app.exit(1);}
});
