const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(process.env.PSN_DATA || path.join(root, 'data'), 'gta5-trainer-ui'));
let backend, closing = false;
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
const focus = () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } };
app.on('second-instance', focus);
app.whenReady().then(async () => {
  backend = await (await import(pathToFileURL(path.join(root, 'src/gta-story-server.mjs')).href)).startGTAStoryTrainer();
  const win = new BrowserWindow({ width: 1200, height: 850, minWidth: 900, minHeight: 650, title: 'GTA V Story · PS Neighborhood', backgroundColor: '#0c100f', autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.url + '/')) event.preventDefault(); });
  await win.loadURL(backend.url);
}).catch(e => { dialog.showErrorBox('GTA V Story Trainer', e.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!backend || closing) return;
  event.preventDefault(); closing = true;
  backend.close().catch(e => dialog.showErrorBox('Trainer cleanup', e.message + '\nRestart GTA before reconnecting the trainer.')).finally(() => app.quit());
});
