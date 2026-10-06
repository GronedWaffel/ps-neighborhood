const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const ps5 = process.argv.includes('--ps5');
const directory = process.env.PSN_DATA || path.join(root, 'data', ...(ps5 ? ['ps5'] : []));
const newWorkspace = !fs.existsSync(path.join(directory, 'workspace.json'));
fs.mkdirSync(path.join(directory, 'desktop'), { recursive: true });
app.setPath('userData', path.join(directory, 'desktop'));
let backend, sleepBlocker, tray, quitting = false, closing = false;
// This unforgeable local capability lets paired website calls reuse the exact
// desktop handlers. Renderer IPC still passes the normal origin check.
const nativeAuthority=Symbol('paired website'),nativeActions=new Map();
function registerNative(name,handler){ipcMain.handle(name,handler);nativeActions.set(name,args=>handler(nativeAuthority,args));}
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const { startServer } = await import(pathToFileURL(path.join(root, 'src', 'server.mjs')).href);
  backend = await startServer({ directory, native:async(name,args)=>{const action=nativeActions.get(name);if(!action)throw Error('Native action unavailable');return action(args);} });
  if (ps5 && newWorkspace) await backend.workbench.setProfile({...backend.workbench.profile,platform:'ps5',payloadPort:9021,firmware:'13.60'});
  const win = new BrowserWindow({ width: 1510, height: 1000, minWidth: 1100, minHeight: 760, title: 'PS Neighborhood', backgroundColor: '#0b1017', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const sleepTimer = setInterval(() => {
    const awake=backend.web?.state.active || backend.workbench.packages.server || backend.workbench.shadow.busy || backend.workbench.conversion.busy || backend.workbench.console.backup?.state==='running';
    if (awake && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!awake && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
  }, 1000);
  win.on('close', event => {
    if (closing) return;
    if(backend.web.state.active&&!quitting){event.preventDefault();win.hide();return;}
    if(backend.workbench.conversion.busy){event.preventDefault();dialog.showMessageBoxSync(win,{message:'A PKG conversion is running. Cancel it in PKG installer before closing.'});return;}
    if(backend.workbench.shadow.busy){event.preventDefault();dialog.showMessageBoxSync(win,{message:'A ShadowMount transfer is running. Cancel it in ShadowMount before closing; completed files will be kept for retry.'});return;}
    if (backend.workbench.console.busy || backend.workbench.console.backup?.state==='running') {event.preventDefault();dialog.showMessageBoxSync(win,{message:'Wait for the console action or save backup to finish before closing.'});return;}
    if (backend.workbench.packages.busy) { event.preventDefault(); dialog.showMessageBoxSync(win, { message: 'An installation is being submitted. Wait for the result before closing.' }); return; }
    if (backend.workbench.packages.server) {
      const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep serving', 'Close and stop sharing'], defaultId: 0, cancelId: 0, message: 'The PS4 is using this PC as its package source.', detail: 'Closing stops file serving. Any unfinished download will lose its source; reopening does not automatically resume sharing.' });
      if (choice === 0) { event.preventDefault(); return; }
    }
    closing = true; clearInterval(sleepTimer);
  });
  const trusted = event => event===nativeAuthority || event.senderFrame?.url.startsWith(backend.url + '/');
  registerNative('choose-file', async event => { if (!trusted(event)) return null; const result = await dialog.showOpenDialog(win, { properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0]; });
  registerNative('choose-folder', async event => { if (!trusted(event)) return null; const result = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  registerNative('open-exports', async event => { if (trusted(event)) { fs.mkdirSync(path.join(directory, 'exports'), { recursive: true }); await shell.openPath(path.join(directory, 'exports')); } });
  registerNative('open-saves', async event => {if(trusted(event)){const folder=path.join(directory,'save-backups');fs.mkdirSync(folder,{recursive:true});await shell.openPath(folder);}});
  registerNative('confirm-save-restore',async(event,request)=>{
    if(!trusted(event)||typeof request?.planId!=='string')return false;
    const plan=backend.workbench.console.saveTools.plans.get(request.planId);if(!plan)return false;
    const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Restore edited save'],defaultId:0,cancelId:0,message:'Restore '+plan.save.name+' ('+plan.save.titleId+')?',detail:plan.changes.length+' edited file(s) in '+plan.slot+'. This replaces that installed save container. The game must remain closed. A verified encrypted backup is retained on this PC.\n\n'+plan.changes.map(f=>f.path).slice(0,20).join('\n')});return result.response===1;
  });
  registerNative('confirm-console', async (event,request) => {
    if(!trusted(event))return false;
    const labels={'shadow-register':'Enable batch registration',mount:'Mount game',unmount:'Unmount game',launch:'Launch game',close:'Close game',uninstall:'Uninstall game',patch:'Uninstall patch only',shutdown:'Shut down PS4',restart:'Restart PS4',rest:'Enter rest mode'};
    const label=labels[request?.action];if(!label)return false;
    const detail={'shadow-register':'Backs up ShadowMount configuration and enables native batch registration on PS5 13.60. It scans all staged app folders and resets title registration and image retry counters. Use this when the per-title registration bridge fails.',mount:'Attach this game through ShadowMount. Close any running game first.',unmount:'Detach this game through ShadowMount. Close it first.',launch:'Launching a different game may interrupt the current session.',close:'Unsaved progress will be lost.',uninstall:'Removes the game and its installed game content. Save backups are managed separately.',patch:'Removes only the installed update, returning this game to its base version. Newer saves may require the update.',shutdown:'The console will turn off. You will need to enable the jailbreak again after booting.',restart:'The console will restart. You will need to enable the jailbreak again.',rest:'The console will suspend. Save your progress first; rest-mode support depends on your jailbreak setup.'}[request.action];
    const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel',label],defaultId:0,cancelId:0,message:label+(request.titleId?' · '+String(request.titleId).slice(0,20):'')+'?',detail});return result.response===1;
  });
  registerNative('mcp-config', event => {
    if (!trusted(event)) return null;
    return { mcpServers: { 'ps-neighborhood': { command: process.execPath, args: [path.join(root, 'src', 'mcp.mjs')], env: { ELECTRON_RUN_AS_NODE: '1', PSN_DATA: directory } } } };
  });
  registerNative('confirm-web',async(event,request)=>{
    if(event!==nativeAuthority||request?.origin!=='https://psneighborhood.com')return false;
    win.show();win.focus();
    const result=await dialog.showMessageBox(win,{type:'question',buttons:['Decline','Connect my browser'],defaultId:0,cancelId:0,message:'Connect your browser to PS Neighborhood?',detail:'Approve only if you just entered this companion’s code at https://psneighborhood.com. The browser will have the same console and local file controls as this app. MCP stays connected locally. You can disconnect website access at any time from the tray or Website panel.'});return result.response===1;
  });
  const pixels=Buffer.alloc(16*16*4);for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=(y*16+x)*4;pixels[i]=55;pixels[i+1]=145;pixels[i+2]=235;pixels[i+3]=255;if((x>=7&&x<=8)||(y>=7&&y<=8)){pixels[i]=245;pixels[i+1]=250;pixels[i+2]=255;}}
  tray=new Tray(nativeImage.createFromBitmap(pixels,{width:16,height:16}));tray.setToolTip('PS Neighborhood companion');
  const show=()=>{win.restore();win.show();win.focus();};
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Neighborhood',click:show},{label:'Open website',click:()=>shell.openExternal('https://psneighborhood.com')},{label:'Disconnect website',click:()=>{backend.web.stop();show();}},{type:'separator'},{label:'Quit companion',click:()=>app.quit()}]));tray.on('double-click',show);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.url + '/')) event.preventDefault(); });
  await win.loadURL(backend.url + (process.argv.includes('--web') ? '/#web' : process.argv.includes('--shadow') ? '/#shadow' : process.argv.includes('--console') ? '/#console' : process.argv.includes('--pkg') ? '/#pkg' : ''));
  win.show();
  app.on('second-instance', () => { win.restore(); win.show(); win.focus(); });
}).catch(e => { dialog.showErrorBox('PS Neighborhood', e.stack || e.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit',()=>{quitting=true;});
app.on('will-quit', () => { backend?.web?.stop('Application closed'); backend?.workbench.client?.close(); backend?.workbench.packages.close().catch(() => {}); backend?.server.close();tray?.destroy(); if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker); });
