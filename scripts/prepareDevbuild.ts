
import * as fs from 'fs';

// items of package.json that are modified
interface packageInfo {
    version?: string,
    name?: string,
    displayName?: string,
    preview?: boolean
}

// file names
const README = './README.md';
const README_NOTE = './README-dev-build-note.md';
const PACKAGE = './package.json';

// parse package.json
const json = <packageInfo>JSON.parse(fs.readFileSync(PACKAGE, 'utf-8'));

// construct version from year.month.monthMinutes
const date = new Date();
const monthMinutes = (date.getDate() - 1) * 24 * 60 + date.getHours() * 60 + date.getMinutes();
const version = `${date.getFullYear()}.${date.getMonth() + 1}.${monthMinutes}`;

// modify json and write back to package.json
json.version = version;
json.name = 'r-dev';
json.displayName = 'R - Development Build';
json.preview = true;

fs.writeFileSync(PACKAGE, JSON.stringify(json, undefined, 4));


// add note to readme
const readme = fs.readFileSync(README, 'utf-8');
const readmeNote = fs.readFileSync(README_NOTE, 'utf-8');
const newReadme = `${readmeNote}\n${readme}`;

fs.writeFileSync(README, newReadme);


