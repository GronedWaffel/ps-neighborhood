const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
require('node:fs').mkdirSync(path.join(root, 'data', 'bo2-trainer'), { recursive: true });
app.setPath('userData', path.join(root, 'data', 'bo2-trainer'));
let backend, shuttingDown = false;
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
function showTrainer() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
app.on('second-instance', showTrainer);
app.on('activate', showTrainer);
app.whenReady().then(async () => {
  backend = await (await import(pathToFileURL(path.join(root, 'src/trainer-server.mjs')).href)).startTrainer();
  const win = new BrowserWindow({ width: 1000, height: 800, minWidth: 750, minHeight: 620, title: 'BO2 Zombies · PS Neighborhood', backgroundColor: '#10100f', autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.url + '/')) event.preventDefault(); });
  await win.loadURL(backend.url);
  showTrainer();
  console.log('BO2 Zombies trainer ready; window shown.');
}).catch(e => { console.error(e.stack || e.message); require('electron').dialog.showErrorBox('BO2 Zombies Trainer', e.message); process.exitCode = 1; app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!backend || shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  backend.close().catch(console.error).finally(() => app.quit());
});
