import { PS4Debug, integer } from './protocol.mjs';

// PS5Debug-NG 1.3.2 uses the same bounded process/read/map/info wire layouts.
// Identify the platform before enumerating processes; no attach, kernel writes,
// injection or payload reload takes place during connection.
export class PS5Debug extends PS4Debug {
  constructor(options) { super(options); this.platform = 'ps5'; }
  async detectCapabilities() {
    return this.transaction(async () => {
      await this.send(0xbd000502);
      const platformId = (await this.receive(2)).readUInt16LE();
      if (platformId !== 5) throw new Error('The debugger does not identify as PS5; check the selected console and payload');
      await this.send(0xbd000500);
      const firmwareWord = integer((await this.receive(2)).readUInt16LE(), 100, 9999, 'PS5 firmware');
      const firmware = Math.floor(firmwareWord / 100) + '.' + String(firmwareWord % 100).padStart(2, '0');
      await this.send(0xbd000501);
      const length = integer((await this.receive(4)).readUInt32LE(), 1, 512, 'Branding length');
      const [branding, capabilityLevel = ''] = (await this.receive(length)).toString('utf8').split('\0');
      if (!/ps5debug\b/i.test(branding)) throw new Error('Unrecognized PS5 debugger branding');
      this.capabilities = {
        platform: 'ps5', platformId, firmware, branding, capabilityLevel,
        nativeScan: /ps5debug[- ]ng\b.*\bv1\.3\.2\b/i.test(branding),
        reason: /\bv1\.3\.2\b/.test(branding) ? 'PS5Debug-NG 1.3.2 native integer scanning validated; host engine handles floats, text and custom alignment' : 'Unvalidated PS5Debug version; host scanner remains available'
      };
      return this.capabilities;
    });
  }
}
