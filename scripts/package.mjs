import { cp, mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const converterBuild = spawnSync(process.execPath, ['scripts/build-pkg-converter.mjs'], { cwd: root, stdio: 'inherit' });
if (converterBuild.error || converterBuild.status !== 0) throw converterBuild.error || Error('PKG converter build failed');
const gtaBuild = spawnSync(process.execPath, ['scripts/build-gta-bridge.mjs'], { cwd: root, stdio: 'inherit' });
if (gtaBuild.error || gtaBuild.status !== 0) throw gtaBuild.error || Error('GTA trainer bridge build failed');
const out = path.join(process.env.PSN_PACKAGE_DIR ? path.resolve(process.env.PSN_PACKAGE_DIR) : path.join(root, 'dist'), `PS-Neighborhood-${pkg.version}-win-x64`);
try { await access(out); throw new Error('Output already exists. Move the previous build before packaging again.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
// Build and exercise the actual C dispatch before copying any payload into a
// release. Host protocol mocks cannot detect a misrouted native operation.
for(const args of [['receiver/build.mjs'],['receiver-ps5/build.mjs'],['--test','tests/receiver-console-native.test.mjs','tests/ps5-install-abi-native.test.mjs','tests/shadowmount-native.test.mjs']]) {
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if(result.error || result.status!==0)throw result.error || Error('Native receiver release check failed');
}
await mkdir(out, { recursive: true });
await cp(path.join(root, 'node_modules/electron/dist'), out, { recursive: true });
await rename(path.join(out, 'electron.exe'), path.join(out, 'PS Neighborhood.exe'));
const app = path.join(out, 'resources/app'); await mkdir(app, { recursive: true });
for (const name of ['desktop', 'src', 'ui', 'trainers', 'docs', 'package.json', 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(path.join(root, name), path.join(app, name), { recursive: true });
await mkdir(path.join(app,'scripts'),{recursive:true});
await cp(path.join(root,'converter'),path.join(app,'converter'),{recursive:true,filter:source=>!path.relative(path.join(root,'converter'),source).split(path.sep).some(p=>p==='bin'||p==='obj')});
await cp(path.join(root,'scripts/build-pkg-converter.mjs'),path.join(app,'scripts/build-pkg-converter.mjs'));
for(const name of ['verify-ghidra.ps1','prepare-ghidra-validation.mjs'])await cp(path.join(root,'scripts',name),path.join(app,'scripts',name));
await cp(path.join(root, 'scripts/build-gta-bridge.mjs'), path.join(app, 'scripts/build-gta-bridge.mjs'));
await cp(path.join(root, 'scripts/build-gta-vehicles.mjs'), path.join(app, 'scripts/build-gta-vehicles.mjs'));
await cp(path.join(root, 'receiver'), path.join(app, 'receiver'), { recursive: true, filter: source => {const relative=path.relative(path.join(root,'receiver'),source).replaceAll('\\','/');return !relative.startsWith('build/')||['build/manifest.json','build/ps-neighborhood-receiver.bin','build/receiver.elf','build/nids.h','build/syscalls.S'].includes(relative);} });
await cp(path.join(root, 'receiver-ps5'), path.join(app, 'receiver-ps5'), { recursive: true, filter: source => {const relative=path.relative(path.join(root,'receiver-ps5'),source).replaceAll('\\','/');return !relative.startsWith('build/')||['build/manifest.json','build/ps-neighborhood-ps5.elf'].includes(relative);} });
await cp(path.join(root, 'node_modules'), path.join(app, 'node_modules'), { recursive: true, filter: src => {
  const relative = path.relative(path.join(root, 'node_modules'), src).replaceAll('\\', '/');
  return !['electron', '@electron', '@electron-internal', '.bin'].some(p => relative === p || relative.startsWith(p + '/'));
} });
await writeFile(path.join(out, 'START-HERE.txt'), 'PS Neighborhood\r\n\r\nRun PS Neighborhood.exe. No Node.js installation is required.\r\nEnter your PS4 IP in the console profile. Typical ports: PS4Debug or PS5Debug 744 / FTP 2121 / PS4 BinLoader 9090 / PS5 ELF Loader 9021.\r\nPS4 10.01 and scoped PS5 13.60 workflows have hardware checks. See the option audit for limits.\r\nPS5: Start PS5 Neighborhood.cmd opens a separate workspace for memory/MCP, FTP, ELF loading, library/save archives and the storage companion. PS5 launch/close and native integer scans are verified on 13.60. PS4/PS5 package installs and rest mode passed on 13.60; test-content removal/reinstall and native pause/resume passed. Restart passed; shutdown was tested successfully by the user. See resources/app/docs/PS5-VALIDATION.md.\r\nEnable the corresponding PS4 services, then Connect console. Do not load PS4Debug twice.\r\nUse Open memory lab to explore the scanner without a console.\r\nOpen MCP bridge in the app to copy the configuration for this build.\r\nOpen BO2 Zombies Trainer.cmd for the optional build-specific trainer; keep the main app open.\r\nData, watches, downloads and RAM exports are under resources/app/data.\r\nKeep the entire folder together. See resources/app/README.md for features and limitations.\r\n');
await writeFile(path.join(out, 'BO2 Zombies Trainer.cmd'), '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE="\r\ncd /d "%~dp0"\r\n"%~dp0PS Neighborhood.exe" --trainer\r\nif errorlevel 1 pause\r\n');
await writeFile(path.join(out, 'GTA V Story Trainer.cmd'), '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE="\r\ncd /d "%~dp0"\r\n"%~dp0PS Neighborhood.exe" --gta-story\r\nif errorlevel 1 pause\r\n');
await writeFile(path.join(out, 'GTA V In-Game Menu.cmd'), '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE="\r\ncd /d "%~dp0"\r\n"%~dp0PS Neighborhood.exe" --gta-menu\r\nif errorlevel 1 pause\r\n');
for (const [name, flag] of [['ShadowMount', '--ps5 --shadow'], ['Console Manager', '--console'], ['PKG Installer', '--pkg'], ['PS5 Neighborhood', '--ps5']]) await writeFile(path.join(out, `Start ${name}.cmd`), `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "PS Neighborhood" "%~dp0PS Neighborhood.exe" ${flag}\r\n`);
console.log(out);
