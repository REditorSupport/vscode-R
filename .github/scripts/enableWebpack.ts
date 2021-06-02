
import * as fs from 'fs';

// adjust .vscodeignore
const fileVscodeignore = './.vscodeignore';

let vscodeignore = fs.readFileSync(fileVscodeignore, 'utf-8');
vscodeignore = vscodeignore.replace(/^#(.*)#\s*withWebpack\s*$/gm, '$1');
vscodeignore = vscodeignore.replace(/^\s*#\s*withoutWebpack(?:.|\r|\n)*?^\s*#\s*\/withoutWebpack/gm, '');
fs.writeFileSync(fileVscodeignore, vscodeignore);


// adjust package.json
const filePkgJson = './package.json';
interface PkgJson {
    withWebpack?: {
        [k: string]: any;
    }
    [k: string]: any;
}

const pkgJson = JSON.parse(fs.readFileSync(filePkgJson, 'utf-8')) as PkgJson;
if('withWebpack' in pkgJson){
    for(const k in pkgJson.withWebpack){
        pkgJson[k] = pkgJson.withWebpack[k];
    }
    pkgJson.withWebpack = undefined;
}
fs.writeFileSync(filePkgJson, JSON.stringify(pkgJson, undefined, 2));
