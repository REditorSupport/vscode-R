import * as assert from 'assert';
import { execFileSync } from 'child_process';
import Mocha from 'mocha';

suite('Interactive test profiles', () => {
    for (const smoke of [false, true]) {
        test(`${smoke ? 'smoke' : 'full'} selection survives extension-host JSON transport`, () => {
            // Use a fresh process so the cached config and caller's environment
            // cannot affect which profile is serialized, as vscode-test does.
            const serialized = execFileSync(process.execPath, ['-e',
                'console.log(JSON.stringify(require("./scripts/interactive-test-options.cjs")))'], {
                encoding: 'utf8',
                env: { ...process.env, VSCR_TEST_INTERACTIVE_SMOKE: smoke ? '1' : '0' }
            });
            const options = JSON.parse(serialized) as Mocha.MochaOptions;
            const mocha = new Mocha(options);
            for (const title of ['Interactive real R runtime', 'Interactive VS Code integration']) {
                const group = Mocha.Suite.create(mocha.suite, title);
                group.addTest(new Mocha.Test('selected [smoke]', () => undefined));
                group.addTest(new Mocha.Test('full only', () => undefined));
            }
            const other = Mocha.Suite.create(mocha.suite, 'Interactive library isolation');
            other.addTest(new Mocha.Test('always selected', () => undefined));
            const runner = new Mocha.Runner(mocha.suite, false);
            // Mocha converts string patterns to RegExp, including after JSON transport.
            runner.grep(mocha.options.grep as RegExp ?? /.*/, false);
            assert.strictEqual(runner.total, smoke ? 3 : 5);
            runner.dispose();
            mocha.dispose();
        });
    }
});
