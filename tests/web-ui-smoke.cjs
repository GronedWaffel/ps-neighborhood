const {app,BrowserWindow}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict'),http=require('node:http');
const {pathToFileURL}=require('node:url');const root=path.resolve(__dirname,'..');
app.setPath('userData',path.join(root,'artifacts','web-ui-userdata'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const {createWebRelay}=await import(pathToFileURL(path.join(root,'src/web-relay.mjs'))),{startServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')));
  const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));const live=process.env.PSN_WEB_SMOKE_LIVE==='1',origin=live?'https://psneighborhood.com':'http://127.0.0.1:'+port;
  const relay=live?null:createWebRelay({origin});if(relay)await new Promise(r=>relay.server.listen(port,'127.0.0.1',r));const native=[];
  const backend=await startServer({directory:path.join(root,'artifacts','web-ui-data-'+Date.now()),webOptions:{origin,allowLocal:true},native:async(name)=>{native.push(name);if(name==='confirm-web')return true;if(name==='mcp-config')return {mcpServers:{'ps-neighborhood':{command:'node',args:['src/mcp.mjs']}}};return null;}});
  const state=await backend.web.start(),win=new BrowserWindow({show:false,width:1510,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'&&!e.message.includes('401'))errors.push(e.message);});
  const js=s=>win.webContents.executeJavaScript(s),until=async(s)=>{for(let i=0;i<200;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout: '+s);},click=s=>js(`document.querySelector(${JSON.stringify(s)}).click()`);
  async function capture(){for(let attempt=0;attempt<4;attempt++){await new Promise(r=>setTimeout(r,300));try{return (await win.webContents.capturePage()).toPNG();}catch(e){if(attempt===3)throw e;}}}
  async function waitNative(name){for(let i=0;i<100;i++){if(native.includes(name))return;await new Promise(r=>setTimeout(r,50));}assert.fail('Native action not delivered: '+name);}
  try{
    await win.loadURL(origin);await until('!!document.querySelector("#pair-code")');await fs.mkdir(path.join(root,'artifacts/screenshots'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/screenshots/web-pair.png'),await capture());
    await js(`document.querySelector('#pair-code').value=${JSON.stringify(state.code)};document.querySelector('#pair-form').requestSubmit()`);
    await until('!!document.querySelector("#open-lab")');assert.ok(native.includes('confirm-web'));assert.ok(native.includes('mcp-config'));
    await click('#open-lab');await until('!!document.querySelector("#scan-new")');await click('#scan-new');await until('document.querySelector("#scan-results").textContent.includes("0x100000100")');
    await click('[data-address="0x100000100"]');await until('document.querySelector("#hex-output").textContent.includes("64 00 00 00")');
    await click('[data-page="map"]');await click('#maps-select');await click('#dump-selected');await until('document.querySelector("#dump-list")?.textContent.includes("Scan offline")');await click('#open-exports');await waitNative('open-exports');
    for(const page of ['folder','pkg','payload','mcp','activity','home']){await click(`[data-page="${page}"]`);assert.ok(await js('document.querySelector("h1").textContent.length>5'));}
    await js('window.desktop.chooseFile()');await js('window.desktop.chooseFolder()');await js('window.desktop.openSaves()');await js('window.desktop.confirmConsole({action:"close"})');await js('window.desktop.confirmSaveRestore({planId:"test"})');
    for(const name of ['choose-file','choose-folder','open-saves','confirm-console','confirm-save-restore'])assert.ok(native.includes(name));
    await fs.writeFile(path.join(root,'artifacts/screenshots/web-workbench.png'),await capture());
    await click('#web-disconnect');await until('!!document.querySelector("#pair-code")');assert.equal(backend.workbench.mode,'demo');assert.deepEqual(errors,[]);console.log('Website browser parity passed: pairing, native actions, scanner, memory, dump, navigation, MCP configuration and disconnect.');
  }finally{win.destroy();await backend.close();relay?.close();}
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
