const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
app.setPath('userData',path.join(root,'artifacts/connection-ui-userdata'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const directory=await fs.mkdtemp(path.join(root,'artifacts/connection-ui-'));
 const {startServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')).href);
 const backend=await startServer({directory}),w=backend.workbench,attempts=[],checks=[];
 const originalConnect=w.connect.bind(w),dispatch=w.dispatch.bind(w);let fail=true;
 // Real renderer, HTTP bridge and disk persistence; never contact a console.
 w.connect=async()=>{attempts.push({...w.profile});if(fail){await w.disconnect();throw Error('Test connection unavailable');}return originalConnect(true);};
 w.dispatch=async(method,args,source)=>{if(method==='probe'){checks.push({...w.profile});return [{port:w.profile.debugPort,open:true,latencyMs:1},{port:w.profile.payloadPort,skipped:true,error:'Loader not probed'}];}return dispatch(method,args,source);};
 const win=new BrowserWindow({show:false,width:1510,height:1000,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}}),errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=code=>win.webContents.executeJavaScript(code),click=s=>js(`document.querySelector(${JSON.stringify(s)}).click()`);
 async function until(code){for(let i=0;i<150;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timeout: '+code);}
 async function fill(id,value){await js(`document.querySelector('#${id}').value=${JSON.stringify(value)};document.querySelector('#${id}').dispatchEvent(new Event('input',{bubbles:true}));`);}
 try{
  await win.loadURL(backend.url);await until(`!!document.querySelector('#host')`);
  for(const platform of ['ps4','ps5']){
   await js(`document.querySelector('#console-platform').value='${platform}';document.querySelector('#console-platform').dispatchEvent(new Event('change',{bubbles:true}));`);
   await fill('host','192.0.2.42');await fill('debug-port','1744');
   await click('#top-connect');await until(`document.querySelector('#top-connect').disabled===false`);
   assert.equal(attempts.at(-1).host,'192.0.2.42');assert.equal(attempts.at(-1).platform,platform);assert.equal(attempts.at(-1).debugPort,1744);
   await new Promise(r=>setTimeout(r,1200));assert.equal(await js(`document.querySelector('#host').value`),'192.0.2.42');
   assert.equal(JSON.parse(await fs.readFile(path.join(directory,'workspace.json'),'utf8')).profile.host,'192.0.2.42');
  }
  await fill('host','');await w.disconnect();await new Promise(r=>setTimeout(r,1200));assert.equal(await js(`document.querySelector('#host').value`),'');
  const count=attempts.length;await click('#top-connect');await until(`!document.querySelector('#top-connect').disabled`);assert.equal(attempts.length,count);assert.equal(await js(`document.querySelector('#host').value`),'');
  await fill('host','192.0.2.43');await click('#probe');await until(`document.querySelector('#service-results').textContent.includes('192.0.2.43')`);assert.equal(checks.at(-1).host,'192.0.2.43');
  await fill('host','192.0.2.44');await click('[data-page="folder"]');await until(`!!document.querySelector('#ftp-path')`);assert.equal(w.profile.host,'192.0.2.44');
  await click('[data-page="home"]');await until(`!!document.querySelector('#host')`);assert.equal(await js(`document.querySelector('#host').value`),'192.0.2.44');
  await fill('host','192.0.2.45');fail=false;await click('#top-connect');await until(`document.querySelector('#top-connect').textContent==='Disconnect'`);assert.equal(attempts.at(-1).host,'192.0.2.45');
  await click('#top-connect');await until(`document.querySelector('#top-connect').textContent==='Connect console'`);
  await win.reload();await until(`!!document.querySelector('#host')`);assert.equal(await js(`document.querySelector('#host').value`),'192.0.2.45');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'artifacts/connection-ui-result.json'),JSON.stringify({passed:true,checks:['PS4 and PS5 typed IP/port used without Save','failed connection retains IP','invalid draft survives polling','service check autosaves','FTP navigation autosaves','successful connection uses edits','profile survives reload','no renderer errors']}));
 }catch(e){await fs.writeFile(path.join(root,'artifacts/connection-ui-result.json'),JSON.stringify({passed:false,error:e.stack}));}
 finally{win.destroy();await backend.close();app.quit();}
});
