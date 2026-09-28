// Packaged Electron always starts the package entry point. Route the optional
// trainer explicitly so its launcher also works without a source checkout.
require(process.argv.includes('--trainer') ? './trainer.cjs' : './main.cjs');
