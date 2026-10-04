import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { prepareStorage } from '../storage';

const run = promisify(execFile);

export async function installSessRuntime(extensionPath: string, root: string, rPath: string,
    log: (text: string) => void): Promise<{ library: string; resources: string }> {
    prepareStorage(root);
    const hash = createHash('sha256');
    const sources = ['sess/DESCRIPTION', 'sess/NAMESPACE',
        'R/interactive-worker.R', 'R/interactive-metrics.R', 'R/install_sess.R', 'R/sess-package-install.R'];
    for (const directory of ['sess/R', 'sess/src']) {
        for (const name of fs.readdirSync(path.join(extensionPath, directory)).sort()) {
            if (/\.(R|c|h)$/.test(name)) { sources.push(`${directory}/${name}`); }
        }
    }
    for (const file of sources) { hash.update(file).update(fs.readFileSync(path.join(extensionPath, file))); }
    const version = await run(rPath, ['--vanilla', '--slave', '-e', 'cat(R.version$platform, R.version$major, R.version$minor)']);
    hash.update(version.stdout);
    const runtime = path.join(root, 'runtimes', hash.digest('hex').slice(0, 20));
    const library = path.join(runtime, 'library');
    const resources = path.join(runtime, 'R');
    if (fs.existsSync(path.join(runtime, 'ready'))) { return { library, resources }; }
    const lock = `${runtime}.lock`;
    const deadline = Date.now() + 120000;
    for (;;) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            if (fs.existsSync(path.join(runtime, 'ready'))) { return { library, resources }; }
            if (Date.now() >= deadline) { throw new Error(`Runtime installation is locked. If its installer has exited, remove ${lock} and retry.`); }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    try {
        fs.mkdirSync(library, { recursive: true, mode: 0o700 });
        fs.mkdirSync(resources, { recursive: true, mode: 0o700 });
        const packagePath = path.join(runtime, 'sess');
        fs.cpSync(path.join(extensionPath, 'sess'), packagePath, { recursive: true,
            filter: source => !/\.(o|so|dll)$/.test(source) });
        for (const file of ['interactive-worker.R', 'interactive-metrics.R', 'install_sess.R', 'sess-package-install.R']) {
            fs.copyFileSync(path.join(extensionPath, 'R', file), path.join(resources, file));
        }
        await new Promise<void>((resolve, reject) => {
            const child = spawn(rPath, ['--vanilla', '--slave', '-f', path.join(resources, 'install_sess.R')], {
                stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
                    VSCODE_R_SESS_PKG_PATH: packagePath, VSCODE_R_SESS_LIBRARY: library, VSCODE_R_SESS_INTERACTIVE: '1' },
            });
            child.stdout.on('data', (data: Buffer) => log(data.toString()));
            child.stderr.on('data', (data: Buffer) => log(data.toString()));
            child.on('error', reject);
            child.on('exit', code => code === 0 ? resolve() : reject(new Error('Could not install the private sess runtime from the bundle or a compatible R-universe package. See R Interactive output for details.')));
        });
        fs.writeFileSync(path.join(runtime, 'ready'), version.stdout, { mode: 0o600 });
        return { library, resources };
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
