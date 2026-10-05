// Unified PS5 firmware targets; exact versions only. Feature validation remains scoped.
export const ps5FirmwareTargets=Object.freeze(["11.00", "11.20", "11.60", "12.00", "12.02", "12.20", "12.40", "12.60", "12.70", "13.00", "13.20", "13.40", "13.42", "13.60"]);
export const isPS5FirmwareTarget=value=>typeof value==='string'&&ps5FirmwareTargets.includes(value);
