const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'artifacts/trainer-ui-userdata'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let backend;
  try {
    backend = await (await import(pathToFileURL(path.join(root, 'src/trainer-server.mjs')).href)).startTrainer();
    const win = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(backend.url);
    let loaded = false;
    for (let n = 0; n < 100; n++) {
      loaded = await win.webContents.executeJavaScript('document.querySelector("#connection").textContent.includes("CUSA57548")');
      if (loaded) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!loaded) throw Error(await win.webContents.executeJavaScript('document.querySelector("#message").textContent'));
    const profile = JSON.parse(await fs.readFile(path.join(root, 'trainers/bo2-zombies/profile.json'), 'utf8'));
    const writesEnabled = await win.webContents.executeJavaScript('document.querySelector("#connection").textContent.includes("Write controls enabled")');
    for (const field of profile.fields) {
      const rendered = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('[data-field="${field.id}"]'); return b && {disabled:b.disabled}; })()`);
      if (!rendered) throw Error('Missing trainer control: ' + field.id);
      if (!field.verified && !rendered.disabled) throw Error('Unvalidated trainer control was enabled');
      if (field.verified && writesEnabled && rendered.disabled) throw Error('Validated trainer control was disabled');
    }
    if (!await win.webContents.executeJavaScript('document.querySelector("#value-fov")?.type === "range" && !document.querySelector("[data-field=reserve]") && !!document.querySelector("#stop-freeze")')) throw Error('Missing FOV/stop control or reserve control still present');
    await win.webContents.executeJavaScript('document.querySelector("#load-weapons").click()');
    let catalogLoaded = false;
    for (let n = 0; n < 150; n++) {
      catalogLoaded = await win.webContents.executeJavaScript('document.querySelector("#weapon-list").options.length > 0');
      if (catalogLoaded) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!catalogLoaded) throw Error('Weapon catalog did not load: ' + await win.webContents.executeJavaScript('document.querySelector("#message").textContent'));
    await fs.mkdir(path.join(root, 'artifacts/screenshots'), { recursive: true });
    await fs.writeFile(path.join(root, 'artifacts/screenshots/bo2-trainer.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.querySelector("#value-fov").scrollIntoView({block:"start"})');
    await fs.writeFile(path.join(root, 'artifacts/screenshots/bo2-trainer-armory.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: trainer desktop reads live game identity through MCP and renders. No writes performed.');
    win.destroy(); await backend.close(); app.exit(0);
  } catch (e) { console.error(e.stack); await backend?.close(); app.exit(1); }
});
