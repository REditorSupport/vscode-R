"use strict";
exports.__esModule = true;
var fs = require("fs");
// file names
var README = './README.md';
var README_NOTE = './README-dev-build-note.md';
var PACKAGE = './package.json';
// parse package.json
var json = JSON.parse(fs.readFileSync(PACKAGE, 'utf-8'));
// construct version from year.month.monthMinutes
var date = new Date();
var monthMinutes = (date.getDate() - 1) * 24 * 60 + date.getHours() * 60 + date.getMinutes();
var version = date.getFullYear() + "." + (date.getMonth() + 1) + "." + monthMinutes;
// modify json and write back to package.json
json.version = version;
json.name = 'r-dev';
json.displayName = 'R - Development Build';
json.preview = true;
fs.writeFileSync(PACKAGE, JSON.stringify(json, undefined, 4));
// add note to readme
var readme = fs.readFileSync(README, 'utf-8');
var readmeNote = fs.readFileSync(README_NOTE, 'utf-8');
var newReadme = readmeNote + "\n" + readme;
fs.writeFileSync(README, newReadme);
