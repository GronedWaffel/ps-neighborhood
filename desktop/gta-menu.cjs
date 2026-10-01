const { app, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
app.setPath('userData', path.join(process.env.PSN_DATA || path.join(__dirname, '..', 'data'), 'gta5-menu-installer'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.whenReady().then(async () => {
  try {
    const { installGTAInGameMenu } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'gta-menu-installer.mjs')).href);
    const result = await installGTAInGameMenu();
    await dialog.showMessageBox({ type: 'info', title: 'GTA V in-game menu', message: 'Installed inside GTA', detail: 'L1 + D-pad Right: open / close\nD-pad: navigate and change values\nCross: select\nCircle: back\n\nYou can close PS Neighborhood. Reinstall after restarting GTA.' + (result.framesAdvancing ? '' : '\n\nLeave the pause menu to let GTA run the menu.') });
  } catch (e) { dialog.showErrorBox('GTA V menu installation', e.message); }
  app.quit();
});
