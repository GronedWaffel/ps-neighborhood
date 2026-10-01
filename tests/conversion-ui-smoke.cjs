const {app,BrowserWindow}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const source=path.resolve(__dirname,'..'),root=process.env.PSN_SMOKE_ROOT||source;
app.setPath('userData',path.join(source,'artifacts/conversion-ui-userdata'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const directory=await fs.mkdtemp(path.join(source,'artifacts/conversion-ui-'));
 const resultFile=path.join(source,'artifacts/conversion-ui-result.json');
 const {startServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')).href);
 const backend=await startServer({directory});
 await backend.workbench.setProfile({...backend.workbench.profile,platform:'ps5',host:'127.0.0.2',firmware:'13.60',payloadPort:9021});
 let storageMode='existing',preparations=0,refreshes=0;
 backend.workbench.shadow.refresh=async()=>{refreshes++;if(storageMode==='offline')throw Error('FTP unavailable');return {destinations:storageMode==='existing'?[{path:'/user/data/homebrew',available_bytes:1e11}]:[],internalStorage:{canPrepare:storageMode!=='custom'}};};
 backend.workbench.shadow.prepare=async()=>{preparations++;storageMode='existing';return backend.workbench.shadow.refresh();};
 const fixture=path.join(directory,'Conversion test.pkg'),b=Buffer.alloc(0x6000);b.writeUInt32BE(0x7f464948);b.writeUInt16LE(3,6);b.writeBigUInt64LE(0x100n,0x10);b.writeBigUInt64LE(0x1f00n,0x18);b.writeBigUInt64LE(0x2000n,0x58);
 const h=b.subarray(0x2000);h.writeUInt32BE(0x7f434e54);h.writeUInt32BE(1,0x10);h.writeUInt32BE(0x2000,0x18);h.writeBigUInt64BE(0x2000n,0x20);h.writeBigUInt64BE(0x2000n,0x28);h.write('UP1234-PPSA12345_00-XXXXXXXXXXXXXXXX',0x40);h.writeUInt32BE(0x20,0x74);await fs.writeFile(fixture,b);
 const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}}),errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=s=>win.webContents.executeJavaScript(s);
 async function until(s){for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timeout: '+s);}
 try{
  await win.loadURL(backend.url+'/#pkg');await until(`!!document.querySelector('#pkg-path')`);
  await js(`document.querySelector('#pkg-path').value=${JSON.stringify(fixture)};document.querySelector('#pkg-inspect').click();`);
  await until(`!!document.querySelector('dialog[open]')`);
  assert.equal(await js(`document.querySelector('dialog h2').textContent`),'Convert for ShadowMount?');
  await until(`document.querySelector('.conversion-destination').options.length===2&&!document.querySelector('.conversion-destination').disabled`);
  assert.ok(refreshes>0);assert.equal(preparations,0);
  assert.equal(await js(`document.querySelector('.conversion-destination').value`),'');
  assert.equal(await js(`document.querySelector('.conversion-prepare').hidden`),true);
  assert.equal(await js(`document.querySelector('.conversion-go').disabled`),false);
  assert.match(await js(`document.querySelector('.conversion-capacity').textContent`),/free/);
  await js(`document.querySelector('.conversion-native').click()`);await until(`!document.querySelector('dialog')`);
  assert.equal(Boolean(backend.workbench.packages.server),false);assert.equal(backend.workbench.conversion.busy,false);
  storageMode='missing';
  await js(`document.querySelector('[data-page="shadow"]').click()`);await until(`!!document.querySelector('#shadow-source')`);
  await js(`document.querySelector('#shadow-source').value=${JSON.stringify(fixture)};document.querySelector('#shadow-add').click()`);await until(`!!document.querySelector('dialog[open]')`);
  await until(`!document.querySelector('.conversion-prepare').hidden&&!document.querySelector('.conversion-prepare').disabled`);
  await js(`document.querySelector('.conversion-prepare').click()`);
  await until(`document.querySelector('.conversion-destination').value==='/user/data/homebrew'&&!document.querySelector('.conversion-destination').disabled`);
  assert.equal(preparations,1);
  storageMode='offline';await js(`document.querySelector('.conversion-refresh').click()`);
  await until(`document.querySelector('.conversion-storage').textContent.includes('FTP unavailable')&&!document.querySelector('.conversion-refresh').disabled`);
  assert.equal(await js(`document.querySelector('.conversion-go').disabled`),false);
  storageMode='custom';await js(`document.querySelector('.conversion-refresh').click()`);
  await until(`document.querySelector('.conversion-storage').textContent.includes('No writable scan folder')&&!document.querySelector('.conversion-refresh').disabled`);
  assert.equal(await js(`document.querySelector('.conversion-prepare').hidden`),true);
  assert.equal(await js(`document.querySelector('.conversion-destination').value`),'');
  storageMode='existing';await js(`document.querySelector('.conversion-refresh').click()`);
  await until(`document.querySelector('.conversion-storage').textContent.includes('Console storage found')&&!document.querySelector('.conversion-refresh').disabled`);
  await fs.writeFile(path.join(source,'artifacts/conversion-ui-dialog.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.conversion-close').click()`);await until(`!document.querySelector('dialog')`);
  assert.equal(backend.workbench.shadow.items.length,0);assert.deepEqual(errors,[]);
  await fs.writeFile(resultFile,JSON.stringify({passed:true,root,version:backend.workbench.status().version,checks:['PKG prompt','converter present','automatic destination discovery','prepare missing folder inside dialog','FTP failure permits local conversion','custom roots respected','refresh clears storage warning','space check','native choice without install','ShadowMount PKG prompt','cancel without queue mutation','no renderer errors']}));
 }catch(e){await fs.writeFile(resultFile,JSON.stringify({passed:false,error:e.stack}));process.exitCode=1;}
 finally{win.destroy();await backend.close();app.quit();}
});
