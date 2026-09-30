export const firmwareTargets=['9.00','9.03','9.04','9.50','9.51','9.60','10.00','10.01','10.50','10.70','10.71','11.00','13.52'];
export function firmwareProfile(value){
  if(value==='auto')return value;
  if(typeof value!=='string'||!/^\d{1,2}\.\d{2}$/.test(value))throw Error('Firmware must be auto or a version such as 9.00, 11.00 or 13.52');
  return value;
}
export function decodeFirmware(raw){
  const hex=(raw>>>0).toString(16).padStart(8,'0').slice(0,4);
  if(!/^[0-9]{4}$/.test(hex)||hex==='0000')return null;
  return Number(hex.slice(0,2))+'.'+hex.slice(2);
}
export function compatibility(profile,runtime,platform='ps4'){
  const detected=runtime?.firmware||null;
  if(platform==='ps5')return {platform,profile,detected,source:detected?'PS5Debug firmware command':null,targets:['13.60'],target:detected?detected==='13.60':null,hardwareTested:detected==='13.60',receiverSupported:true,profileMismatch:!!detected&&profile!=='auto'&&profile!==detected,note:'PS5 13.60 has live checks for memory reads/scans, RAM export, MCP, FTP, inventory and partition capacity. PS5 save archives contain encrypted files and visible metadata; restore is unverified. The PS5 companion is separate from PS5Debug. Launch/close and native integer scans passed on 13.60. Rest mode passed. Uninstall, patch removal and reinstall passed on test content. Restart passed with user confirmation; shutdown was tested successfully by the user. PS4 Minecraft and a PS5 browser package installed successfully over HTTP and were confirmed by the user. The update/DLC queue and native base/update pause/resume passed. Minecraft launch/close passed; the user subsequently confirmed the browser works after an earlier automated launch error.'};
  return {profile,detected,source:detected?'PS4 kern.sdk_version':null,targets:firmwareTargets,
    target:detected?firmwareTargets.includes(detected):null,hardwareTested:detected==='10.01',
    profileMismatch:!!detected&&profile!=='auto'&&profile!==detected,
    receiverRevision:runtime?.revision||null,
    note:detected==='10.01'?'Receiver and memory workflow tested on 10.01. Individual controls may still be untested.':'Other firmware targets require compatible jailbreak, BinLoader and PS4Debug payloads; hardware validation is pending.'};
}
