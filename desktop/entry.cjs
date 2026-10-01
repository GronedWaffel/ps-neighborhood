// Packaged Electron always starts the package entry point. Route the optional
// trainer explicitly so its launcher also works without a source checkout.
require(process.argv.includes('--gta-menu') ? './gta-menu.cjs' : process.argv.includes('--gta-story') ? './gta-story.cjs' : process.argv.includes('--trainer') ? './trainer.cjs' : './main.cjs');
