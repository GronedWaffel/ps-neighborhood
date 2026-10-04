// Community-test firmware targets. Exact versions only; hardware validation remains scoped to 13.60.
export const ps5FirmwareTargets=Object.freeze(["7.00", "7.01", "7.20", "7.40", "7.60", "7.61", "8.00", "8.20", "8.40", "8.60", "9.00", "9.20", "9.40", "9.60", "10.00", "10.01", "10.20", "10.40", "10.60", "11.00", "11.20", "11.60", "12.00", "12.02", "12.20", "12.40", "12.60", "12.70", "13.00", "13.20", "13.40", "13.42", "13.60"]);
export const isPS5FirmwareTarget=value=>typeof value==='string'&&ps5FirmwareTargets.includes(value);
