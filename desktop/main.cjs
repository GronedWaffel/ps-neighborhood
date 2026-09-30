const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const ps5 = process.argv.includes('--ps5');
const directory = process.env.PSN_DATA || path.join(root, 'data', ...(ps5 ? ['ps5'] : []));
const newWorkspace = !fs.existsSync(path.join(directory, 'workspace.json'));
fs.mkdirSync(path.join(directory, 'desktop'), { recursive: true });
app.setPath('userData', path.join(directory, 'desktop'));
let backend, sleepBlocker, closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const { startServer } = await import(pathToFileURL(path.join(root, 'src', 'server.mjs')).href);
  backend = await startServer({ directory });
  if (ps5 && newWorkspace) await backend.workbench.setProfile({...backend.workbench.profile,platform:'ps5',payloadPort:9021,firmware:'13.60'});
  const win = new BrowserWindow({ width: 1510, height: 1000, minWidth: 1100, minHeight: 760, title: 'PS Neighbourhood', backgroundColor: '#0b1017', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const sleepTimer = setInterval(() => {
    const awake=backend.workbench.packages.server || backend.workbench.console.backup?.state==='running';
    if (awake && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!awake && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
  }, 1000);
  win.on('close', event => {
    if (closing) return;
    if (backend.workbench.console.busy || backend.workbench.console.backup?.state==='running') {event.preventDefault();dialog.showMessageBoxSync(win,{message:'Wait for the console action or save backup to finish before closing.'});return;}
    if (backend.workbench.packages.busy) { event.preventDefault(); dialog.showMessageBoxSync(win, { message: 'An installation is being submitted. Wait for the result before closing.' }); return; }
    if (backend.workbench.packages.server) {
      const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep serving', 'Close and stop sharing'], defaultId: 0, cancelId: 0, message: 'The PS4 is using this PC as its package source.', detail: 'Closing stops file serving. Any unfinished download will lose its source; reopening does not automatically resume sharing.' });
      if (choice === 0) { event.preventDefault(); return; }
    }
    closing = true; clearInterval(sleepTimer);
  });
  const trusted = event => event.senderFrame.url.startsWith(backend.url + '/');
  ipcMain.handle('choose-file', async event => { if (!trusted(event)) return null; const result = await dialog.showOpenDialog(win, { properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('choose-folder', async event => { if (!trusted(event)) return null; const result = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('open-exports', async event => { if (trusted(event)) { fs.mkdirSync(path.join(directory, 'exports'), { recursive: true }); await shell.openPath(path.join(directory, 'exports')); } });
  ipcMain.handle('open-saves', async event => {if(trusted(event)){const folder=path.join(directory,'save-backups');fs.mkdirSync(folder,{recursive:true});await shell.openPath(folder);}});
  ipcMain.handle('confirm-save-restore',async(event,request)=>{
    if(!trusted(event)||typeof request?.planId!=='string')return false;
    const plan=backend.workbench.console.saveTools.plans.get(request.planId);if(!plan)return false;
    const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Restore edited save'],defaultId:0,cancelId:0,message:'Restore '+plan.save.name+' ('+plan.save.titleId+')?',detail:plan.changes.length+' edited file(s) in '+plan.slot+'. This replaces that installed save container. The game must remain closed. A verified encrypted backup is retained on this PC.\n\n'+plan.changes.map(f=>f.path).slice(0,20).join('\n')});return result.response===1;
  });
  ipcMain.handle('confirm-console', async (event,request) => {
    if(!trusted(event))return false;
    const labels={launch:'Launch game',close:'Close game',uninstall:'Uninstall game',patch:'Uninstall patch only',shutdown:'Shut down PS4',restart:'Restart PS4',rest:'Enter rest mode'};
    const label=labels[request?.action];if(!label)return false;
    const detail={launch:'Launching a different game may interrupt the current session.',close:'Unsaved progress will be lost.',uninstall:'Removes the game and its installed game content. Save backups are managed separately.',patch:'Removes only the installed update, returning this game to its base version. Newer saves may require the update.',shutdown:'The console will turn off. You will need to enable the jailbreak again after booting.',restart:'The console will restart. You will need to enable the jailbreak again.',rest:'The console will suspend. Save your progress first; rest-mode support depends on your jailbreak setup.'}[request.action];
    const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel',label],defaultId:0,cancelId:0,message:label+(request.titleId?' · '+String(request.titleId).slice(0,20):'')+'?',detail});return result.response===1;
  });
  ipcMain.handle('mcp-config', event => {
    if (!trusted(event)) return null;
    return { mcpServers: { 'ps-neighbourhood': { command: process.execPath, args: [path.join(root, 'src', 'mcp.mjs')], env: { ELECTRON_RUN_AS_NODE: '1', PSN_DATA: directory } } } };
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.url + '/')) event.preventDefault(); });
  await win.loadURL(backend.url + (process.argv.includes('--console') ? '/#console' : process.argv.includes('--pkg') ? '/#pkg' : ''));
  win.show();
  app.on('second-instance', () => { win.restore(); win.show(); win.focus(); });
}).catch(e => { dialog.showErrorBox('PS Neighbourhood', e.stack || e.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { backend?.workbench.client?.close(); backend?.workbench.packages.close().catch(() => {}); backend?.server.close(); if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker); });
