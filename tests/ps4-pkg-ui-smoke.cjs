const {app,BrowserWindow}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const source=path.resolve(__dirname,'..'),root=process.env.PSN_SMOKE_ROOT||source;
app.setPath('userData',path.join(source,'artifacts/ps4-pkg-ui-userdata'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const directory=await fs.mkdtemp(path.join(source,'artifacts/ps4-pkg-ui-'));
 const {startServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')).href);
 const backend=await startServer({directory}),w=backend.workbench;
 const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}}),errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=s=>win.webContents.executeJavaScript(s);
 async function until(s){for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timeout: '+s);}
 const installed=[];
 // The real renderer, API and package inspection run; only console submission
 // is substituted. This check must never send test packages to a real console.
 w.packages.start=async args=>{const p=await w.packages.inspect(args.local);installed.push(p);w.packages.job={...p,state:'submitted'};return w.packages.status();};
 try{
  for(const platform of ['ps4','ps5']){
   await w.setProfile({...w.profile,platform,host:'127.0.0.2',payloadPort:platform==='ps5'?9021:9090});
   for(const title of ['CUSA00001','ITEM00001','SFIN00000']){
    const local=path.join(directory,title+'.pkg'),b=Buffer.alloc(0x3000);
    b.writeUInt32BE(0x7f434e54);b.write('IV0002-'+title+'_00-TESTPACKAGE00001',0x40);b.writeUInt32BE(0x1a,0x74);b.writeBigUInt64BE(BigInt(b.length),0x430);await fs.writeFile(local,b);
    await win.loadURL('about:blank');await win.loadURL(backend.url+'/#pkg');await until(`!!document.querySelector('#pkg-path')`);
    await js(`document.querySelector('#pkg-path').value=${JSON.stringify(local)};document.querySelector('#pkg-inspect').click()`);
    await until(`document.querySelector('#pkg-preview').textContent.includes('${title}')`);
    assert.equal(await js(`!!document.querySelector('dialog[open]')`),false);
    const before=installed.length;
    await js(`document.querySelector('#pkg-install').click()`);
    await until(`!document.querySelector('#pkg-install').disabled`);
    assert.equal(installed.length,before+1);assert.equal(installed.at(-1).titleId,title);assert.equal(installed.at(-1).platform,'ps4');
    if(platform==='ps5'){
     await js(`document.querySelector('[data-page="shadow"]').click()`);await until(`!!document.querySelector('#shadow-source')`);
     await js(`document.querySelector('#shadow-source').value=${JSON.stringify(local)};document.querySelector('#shadow-add').click()`);
     await until(`!!document.querySelector('#pkg-path')`);
     assert.equal(await js(`document.querySelector('#pkg-path').value`),local);
     assert.equal(w.conversion.busy,false);assert.equal(w.shadow.items.length,0);
    }
   }
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(source,'artifacts/ps4-pkg-ui-result.json'),JSON.stringify({passed:true,root,submissions:installed.length,checks:['PS4 and PS5 profiles','CUSA/ITEM/SFIN inspection and install button','no PS5 conversion prompt','ShadowMount routes PS4 PKGs to installer','no console contacted']}));
 }catch(e){console.error(e);process.exitCode=1;}
 finally{win.destroy();await backend.close();app.quit();}
});
