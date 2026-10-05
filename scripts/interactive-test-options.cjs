// Only the two expensive Interactive suites are narrowed by the smoke profile.
// Library isolation, supervisor checks and all other tests still run in full.
module.exports = process.env.VSCR_TEST_INTERACTIVE_SMOKE === '1'
    ? { grep: /^(?!Interactive (?:real R runtime|VS Code integration) )|\[smoke\]$/ }
    : {};
