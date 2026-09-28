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
export function compatibility(profile,runtime){
  const detected=runtime?.firmware||null;
  return {profile,detected,source:detected?'PS4 kern.sdk_version':null,targets:firmwareTargets,
    target:detected?firmwareTargets.includes(detected):null,hardwareTested:detected==='10.01',
    profileMismatch:!!detected&&profile!=='auto'&&profile!==detected,
    receiverRevision:runtime?.revision||null,
    note:detected==='10.01'?'Receiver and memory workflow tested on 10.01. Individual controls may still be untested.':'Other firmware targets require compatible jailbreak, BinLoader and PS4Debug payloads; hardware validation is pending.'};
}
