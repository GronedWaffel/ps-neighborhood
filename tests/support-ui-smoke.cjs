const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=process.env.PSN_TEST_APP_ROOT||path.resolve(__dirname,'..');
app.setPath('userData',path.resolve(__dirname,'../artifacts/support-ui-profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let backend,relay,win;
 try{
  const {startServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')));
  const {createSupportRelay}=await import(pathToFileURL(path.join(root,'src/support-relay.mjs')));
  const {supportRequest}=await import(pathToFileURL(path.join(root,'src/support-protocol.mjs')));
  relay=createSupportRelay({operatorKey:'b'.repeat(64)});await new Promise(r=>relay.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+relay.server.address().port;
  backend=await startServer({directory:path.resolve(__dirname,'../artifacts/support-ui-data')});backend.support.relay=base;backend.support.pollMs=30;
  backend.support.executorFactory=()=>({async run(method){return {method,fixture:true};},close(){}});
  const errors=[];win=new BrowserWindow({show:false,width:1510,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  const js=s=>win.webContents.executeJavaScript(s);const until=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timed out: '+s);};
  await win.loadURL(backend.url);await until('!!document.querySelector("#support-open")');await js('document.querySelector("#support-open").click()');await until('document.querySelector("#support-dialog").open');
  assert.equal(await js('document.querySelector("#support-actions").checked'),false);
  await js('document.querySelector("#support-start").click()');await until('!document.querySelector("#support-pair").hidden');
  const code=await js('document.querySelector("#support-code").textContent');assert.match(code,/^[A-F0-9]{16}$/);
  const c=await supportRequest(base,'/claim','b'.repeat(64),{code});await until('document.querySelector("#support-status").textContent.includes("Operator connected")');
  const result=await supportRequest(base,`/sessions/${c.id}/call`,c.controller,{method:'status',args:{}});assert.equal(result.result.fixture,true);
  await fs.mkdir(path.resolve(__dirname,'../artifacts/support'),{recursive:true});await fs.writeFile(path.resolve(__dirname,'../artifacts/support/connected.png'),(await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("#support-hide").click()');assert.equal(await js('document.querySelector("#support-quick-stop").hidden'),false);
  await js('document.querySelector("#support-quick-stop").click()');await until('document.querySelector("#support-quick-stop").hidden');
  await assert.rejects(supportRequest(base,`/sessions/${c.id}/call`,c.controller,{method:'status',args:{}}));assert.deepEqual(errors,[]);
  console.log('PASS: packaged UI pairing, read-only default, live command, persistent disconnect, revoked operator, no browser errors');
  await backend.close();await relay.close();win.destroy();app.exit(0);
 }catch(e){console.error(e.stack);await backend?.close();await relay?.close();win?.destroy();app.exit(1);}
});
