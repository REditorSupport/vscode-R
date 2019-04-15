module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId]) {
/******/ 			return installedModules[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, { enumerable: true, get: getter });
/******/ 		}
/******/ 	};
/******/
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = function(exports) {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/
/******/ 	// create a fake namespace object
/******/ 	// mode & 1: value is a module id, require it
/******/ 	// mode & 2: merge all properties of value into the ns
/******/ 	// mode & 4: return value when already ns object
/******/ 	// mode & 8|1: behave like require
/******/ 	__webpack_require__.t = function(value, mode) {
/******/ 		if(mode & 1) value = __webpack_require__(value);
/******/ 		if(mode & 8) return value;
/******/ 		if((mode & 4) && typeof value === 'object' && value && value.__esModule) return value;
/******/ 		var ns = Object.create(null);
/******/ 		__webpack_require__.r(ns);
/******/ 		Object.defineProperty(ns, 'default', { enumerable: true, value: value });
/******/ 		if(mode & 2 && typeof value != 'string') for(var key in value) __webpack_require__.d(ns, key, function(key) { return value[key]; }.bind(null, key));
/******/ 		return ns;
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = 0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const util_1 = __webpack_require__(1);
const vscode_1 = __webpack_require__(2);
const package_1 = __webpack_require__(3);
const preview_1 = __webpack_require__(47);
const rGitignore_1 = __webpack_require__(83);
const rTerminal_1 = __webpack_require__(4);
const selection_1 = __webpack_require__(48);
const util_2 = __webpack_require__(46);
const wordPattern = /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\<\>\/\s]+)/g;
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
function activate(context) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    function runSource(echo) {
        const wad = vscode_1.window.activeTextEditor.document;
        wad.save();
        let rPath = ToRStringLiteral(wad.fileName, '"');
        let encodingParam = util_2.config.get("source.encoding");
        if (encodingParam) {
            encodingParam = `encoding = "${encodingParam}"`;
            rPath = [rPath, encodingParam].join(", ");
        }
        if (echo) {
            rPath = [rPath, "echo = TRUE"].join(", ");
        }
        if (!rTerminal_1.rTerm) {
            const success = rTerminal_1.createRTerm(true);
            if (!success) {
                return;
            }
        }
        rTerminal_1.rTerm.sendText(`source(${rPath})`);
        setFocus(rTerminal_1.rTerm);
    }
    async function runSelection(rFunctionName) {
        const callableTerminal = await chooseTerminal();
        if (util_1.isNull(callableTerminal)) {
            return;
        }
        setFocus(callableTerminal);
        runSelectionInTerm(callableTerminal, rFunctionName);
    }
    async function chooseTerminal() {
        if (vscode_1.window.terminals.length > 0) {
            const RTermNameOpinions = ["R", "R Interactive"];
            if (vscode_1.window.activeTerminal) {
                const activeTerminalName = vscode_1.window.activeTerminal.name;
                if (RTermNameOpinions.includes(activeTerminalName)) {
                    return vscode_1.window.activeTerminal;
                }
            }
            else {
                // Creating a terminal when there aren't any already
                // does not seem to set activeTerminal
                if (vscode_1.window.terminals.length === 1) {
                    const activeTerminalName = vscode_1.window.terminals[0].name;
                    if (RTermNameOpinions.includes(activeTerminalName)) {
                        return vscode_1.window.terminals[0];
                    }
                }
                else {
                    // tslint:disable-next-line: max-line-length
                    vscode_1.window.showInformationMessage("Error identifying terminal! This shouldn't happen, so please file an issue at https://github.com/Ikuyadeu/vscode-R/issues");
                    return null;
                }
            }
        }
        if (!rTerminal_1.rTerm) {
            const success = rTerminal_1.createRTerm(true);
            await util_2.delay(200); // Let RTerm warm up
            if (!success) {
                return null;
            }
        }
        return rTerminal_1.rTerm;
    }
    function runSelectionInActiveTerm(rFunctionName) {
        if (vscode_1.window.terminals.length < 1) {
            vscode_1.window.showInformationMessage("There are no open terminals.");
        }
        else {
            runSelectionInTerm(vscode_1.window.activeTerminal, rFunctionName);
            setFocus(vscode_1.window.activeTerminal);
        }
    }
    async function runSelectionInTerm(term, rFunctionName) {
        const selection = selection_1.getSelection();
        if (selection.linesDownToMoveCursor > 0) {
            vscode_1.commands.executeCommand("cursorMove", { to: "down", value: selection.linesDownToMoveCursor });
            vscode_1.commands.executeCommand("cursorMove", { to: "wrappedLineEnd" });
        }
        for (let line of selection.selectedTextArray) {
            if (selection_1.checkForComment(line)) {
                continue;
            }
            await util_2.delay(8); // Increase delay if RTerm can't handle speed.
            if (rFunctionName && rFunctionName.length) {
                let rFunctionCall = "";
                for (const feature of rFunctionName) {
                    rFunctionCall += feature + "(";
                }
                line = rFunctionCall + line.trim() + ")".repeat(rFunctionName.length);
            }
            term.sendText(line);
        }
    }
    function setFocus(term) {
        const focus = util_2.config.get("source.focus");
        term.show(focus !== "terminal");
    }
    vscode_1.languages.setLanguageConfiguration("r", {
        wordPattern,
    });
    context.subscriptions.push(vscode_1.commands.registerCommand("r.nrow", () => runSelection(["nrow"])), vscode_1.commands.registerCommand("r.length", () => runSelection(["length"])), vscode_1.commands.registerCommand("r.head", () => runSelection(["head"])), vscode_1.commands.registerCommand("r.thead", () => runSelection(["t", "head"])), vscode_1.commands.registerCommand("r.names", () => runSelection(["names"])), vscode_1.commands.registerCommand("r.runSource", () => runSource(false)), vscode_1.commands.registerCommand("r.createRTerm", rTerminal_1.createRTerm), vscode_1.commands.registerCommand("r.runSourcewithEcho", () => runSource(true)), vscode_1.commands.registerCommand("r.runSelection", () => runSelection([])), vscode_1.commands.registerCommand("r.runSelectionInActiveTerm", () => runSelectionInActiveTerm([])), vscode_1.commands.registerCommand("r.createGitignore", rGitignore_1.createGitignore), vscode_1.commands.registerCommand("r.previewDataframe", preview_1.previewDataframe), vscode_1.commands.registerCommand("r.previewEnvironment", preview_1.previewEnvironment), vscode_1.commands.registerCommand("r.loadAll", package_1.loadAllPkg), vscode_1.commands.registerCommand("r.test", package_1.testPkg), vscode_1.commands.registerCommand("r.install", package_1.installPkg), vscode_1.commands.registerCommand("r.build", package_1.buildPkg), vscode_1.commands.registerCommand("r.document", package_1.documentPkg), vscode_1.window.onDidCloseTerminal(rTerminal_1.deleteTerminal));
    function ToRStringLiteral(s, quote) {
        if (s === null) {
            return "NULL";
        }
        return (quote +
            s.replace(/\\/g, "\\\\")
                .replace(/"""/g, "\\" + quote)
                .replace(/\\n/g, "\\n")
                .replace(/\\r/g, "\\r")
                .replace(/\\t/g, "\\t")
                .replace(/\\b/g, "\\b")
                .replace(/\\a/g, "\\a")
                .replace(/\\f/g, "\\f")
                .replace(/\\v/g, "\\v") +
            quote);
    }
}
exports.activate = activate;


/***/ }),
/* 1 */
/***/ (function(module, exports) {

module.exports = require("util");

/***/ }),
/* 2 */
/***/ (function(module, exports) {

module.exports = require("vscode");

/***/ }),
/* 3 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const rTerminal_1 = __webpack_require__(4);
async function loadAllPkg() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    const rLoadAllCommand = "devtools::load_all('.')";
    rTerminal_1.rTerm.sendText(rLoadAllCommand);
}
exports.loadAllPkg = loadAllPkg;
async function testPkg() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    const rTestCommand = "devtools::test()";
    rTerminal_1.rTerm.sendText(rTestCommand);
}
exports.testPkg = testPkg;
async function installPkg() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    const rInstallCommand = "devtools::install()";
    rTerminal_1.rTerm.sendText(rInstallCommand);
}
exports.installPkg = installPkg;
async function buildPkg() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    const rBuildCommand = "devtools::build()";
    rTerminal_1.rTerm.sendText(rBuildCommand);
}
exports.buildPkg = buildPkg;
async function documentPkg() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    const rDocumentCommand = "devtools::document()";
    rTerminal_1.rTerm.sendText(rDocumentCommand);
}
exports.documentPkg = documentPkg;


/***/ }),
/* 4 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const fs = __webpack_require__(5);
const vscode_1 = __webpack_require__(2);
const util_1 = __webpack_require__(46);
function createRTerm(preserveshow) {
    const termName = "R Interactive";
    const termPath = util_1.getRpath();
    if (!termPath) {
        return;
    }
    const termOpt = util_1.config.get("rterm.option");
    fs.pathExists(termPath, (err, exists) => {
        if (exists) {
            exports.rTerm = vscode_1.window.createTerminal(termName, termPath, termOpt);
            exports.rTerm.show(preserveshow);
            return true;
        }
        else {
            vscode_1.window.showErrorMessage("Cannot find R client.  Please check R path in preferences and reload.");
            return false;
        }
    });
}
exports.createRTerm = createRTerm;
function deleteTerminal(term) {
    if (term === exports.rTerm) {
        exports.rTerm = null;
    }
}
exports.deleteTerminal = deleteTerminal;


/***/ }),
/* 5 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


module.exports = Object.assign(
  {},
  // Export promiseified graceful-fs:
  __webpack_require__(6),
  // Export extra methods:
  __webpack_require__(16),
  __webpack_require__(26),
  __webpack_require__(29),
  __webpack_require__(32),
  __webpack_require__(38),
  __webpack_require__(19),
  __webpack_require__(43),
  __webpack_require__(44),
  __webpack_require__(45),
  __webpack_require__(28),
  __webpack_require__(30)
)

// Export fs.promises as a getter property so that we don't trigger
// ExperimentalWarning before fs.promises is actually accessed.
const fs = __webpack_require__(9)
if (Object.getOwnPropertyDescriptor(fs, 'promises')) {
  Object.defineProperty(module.exports, 'promises', {
    get () { return fs.promises }
  })
}


/***/ }),
/* 6 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

// This is adapted from https://github.com/normalize/mz
// Copyright (c) 2014-2016 Jonathan Ong me@jongleberry.com and Contributors
const u = __webpack_require__(7).fromCallback
const fs = __webpack_require__(8)

const api = [
  'access',
  'appendFile',
  'chmod',
  'chown',
  'close',
  'copyFile',
  'fchmod',
  'fchown',
  'fdatasync',
  'fstat',
  'fsync',
  'ftruncate',
  'futimes',
  'lchown',
  'lchmod',
  'link',
  'lstat',
  'mkdir',
  'mkdtemp',
  'open',
  'readFile',
  'readdir',
  'readlink',
  'realpath',
  'rename',
  'rmdir',
  'stat',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile'
].filter(key => {
  // Some commands are not available on some systems. Ex:
  // fs.copyFile was added in Node.js v8.5.0
  // fs.mkdtemp was added in Node.js v5.10.0
  // fs.lchown is not available on at least some Linux
  return typeof fs[key] === 'function'
})

// Export all keys:
Object.keys(fs).forEach(key => {
  if (key === 'promises') {
    // fs.promises is a getter property that triggers ExperimentalWarning
    // Don't re-export it here, the getter is defined in "lib/index.js"
    return
  }
  exports[key] = fs[key]
})

// Universalify async methods:
api.forEach(method => {
  exports[method] = u(fs[method])
})

// We differ from mz/fs in that we still ship the old, broken, fs.exists()
// since we are a drop-in replacement for the native module
exports.exists = function (filename, callback) {
  if (typeof callback === 'function') {
    return fs.exists(filename, callback)
  }
  return new Promise(resolve => {
    return fs.exists(filename, resolve)
  })
}

// fs.read() & fs.write need special treatment due to multiple callback args

exports.read = function (fd, buffer, offset, length, position, callback) {
  if (typeof callback === 'function') {
    return fs.read(fd, buffer, offset, length, position, callback)
  }
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (err, bytesRead, buffer) => {
      if (err) return reject(err)
      resolve({ bytesRead, buffer })
    })
  })
}

// Function signature can be
// fs.write(fd, buffer[, offset[, length[, position]]], callback)
// OR
// fs.write(fd, string[, position[, encoding]], callback)
// We need to handle both cases, so we use ...args
exports.write = function (fd, buffer, ...args) {
  if (typeof args[args.length - 1] === 'function') {
    return fs.write(fd, buffer, ...args)
  }

  return new Promise((resolve, reject) => {
    fs.write(fd, buffer, ...args, (err, bytesWritten, buffer) => {
      if (err) return reject(err)
      resolve({ bytesWritten, buffer })
    })
  })
}


/***/ }),
/* 7 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


exports.fromCallback = function (fn) {
  return Object.defineProperty(function () {
    if (typeof arguments[arguments.length - 1] === 'function') fn.apply(this, arguments)
    else {
      return new Promise((resolve, reject) => {
        arguments[arguments.length] = (err, res) => {
          if (err) return reject(err)
          resolve(res)
        }
        arguments.length++
        fn.apply(this, arguments)
      })
    }
  }, 'name', { value: fn.name })
}

exports.fromPromise = function (fn) {
  return Object.defineProperty(function () {
    const cb = arguments[arguments.length - 1]
    if (typeof cb !== 'function') return fn.apply(this, arguments)
    else fn.apply(this, arguments).then(r => cb(null, r), cb)
  }, 'name', { value: fn.name })
}


/***/ }),
/* 8 */
/***/ (function(module, exports, __webpack_require__) {

var fs = __webpack_require__(9)
var polyfills = __webpack_require__(10)
var legacy = __webpack_require__(12)
var clone = __webpack_require__(14)

var queue = []

var util = __webpack_require__(1)

function noop () {}

var debug = noop
if (util.debuglog)
  debug = util.debuglog('gfs4')
else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ''))
  debug = function() {
    var m = util.format.apply(util, arguments)
    m = 'GFS4: ' + m.split(/\n/).join('\nGFS4: ')
    console.error(m)
  }

if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || '')) {
  process.on('exit', function() {
    debug(queue)
    __webpack_require__(15).equal(queue.length, 0)
  })
}

module.exports = patch(clone(fs))
if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
    module.exports = patch(fs)
    fs.__patched = true;
}

// Always patch fs.close/closeSync, because we want to
// retry() whenever a close happens *anywhere* in the program.
// This is essential when multiple graceful-fs instances are
// in play at the same time.
module.exports.close = (function (fs$close) { return function (fd, cb) {
  return fs$close.call(fs, fd, function (err) {
    if (!err)
      retry()

    if (typeof cb === 'function')
      cb.apply(this, arguments)
  })
}})(fs.close)

module.exports.closeSync = (function (fs$closeSync) { return function (fd) {
  // Note that graceful-fs also retries when fs.closeSync() fails.
  // Looks like a bug to me, although it's probably a harmless one.
  var rval = fs$closeSync.apply(fs, arguments)
  retry()
  return rval
}})(fs.closeSync)

// Only patch fs once, otherwise we'll run into a memory leak if
// graceful-fs is loaded multiple times, such as in test environments that
// reset the loaded modules between tests.
// We look for the string `graceful-fs` from the comment above. This
// way we are not adding any extra properties and it will detect if older
// versions of graceful-fs are installed.
if (!/\bgraceful-fs\b/.test(fs.closeSync.toString())) {
  fs.closeSync = module.exports.closeSync;
  fs.close = module.exports.close;
}

function patch (fs) {
  // Everything that references the open() function needs to be in here
  polyfills(fs)
  fs.gracefulify = patch
  fs.FileReadStream = ReadStream;  // Legacy name.
  fs.FileWriteStream = WriteStream;  // Legacy name.
  fs.createReadStream = createReadStream
  fs.createWriteStream = createWriteStream
  var fs$readFile = fs.readFile
  fs.readFile = readFile
  function readFile (path, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$readFile(path, options, cb)

    function go$readFile (path, options, cb) {
      return fs$readFile(path, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$readFile, [path, options, cb]])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
          retry()
        }
      })
    }
  }

  var fs$writeFile = fs.writeFile
  fs.writeFile = writeFile
  function writeFile (path, data, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$writeFile(path, data, options, cb)

    function go$writeFile (path, data, options, cb) {
      return fs$writeFile(path, data, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$writeFile, [path, data, options, cb]])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
          retry()
        }
      })
    }
  }

  var fs$appendFile = fs.appendFile
  if (fs$appendFile)
    fs.appendFile = appendFile
  function appendFile (path, data, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$appendFile(path, data, options, cb)

    function go$appendFile (path, data, options, cb) {
      return fs$appendFile(path, data, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$appendFile, [path, data, options, cb]])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
          retry()
        }
      })
    }
  }

  var fs$readdir = fs.readdir
  fs.readdir = readdir
  function readdir (path, options, cb) {
    var args = [path]
    if (typeof options !== 'function') {
      args.push(options)
    } else {
      cb = options
    }
    args.push(go$readdir$cb)

    return go$readdir(args)

    function go$readdir$cb (err, files) {
      if (files && files.sort)
        files.sort()

      if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
        enqueue([go$readdir, [args]])

      else {
        if (typeof cb === 'function')
          cb.apply(this, arguments)
        retry()
      }
    }
  }

  function go$readdir (args) {
    return fs$readdir.apply(fs, args)
  }

  if (process.version.substr(0, 4) === 'v0.8') {
    var legStreams = legacy(fs)
    ReadStream = legStreams.ReadStream
    WriteStream = legStreams.WriteStream
  }

  var fs$ReadStream = fs.ReadStream
  if (fs$ReadStream) {
    ReadStream.prototype = Object.create(fs$ReadStream.prototype)
    ReadStream.prototype.open = ReadStream$open
  }

  var fs$WriteStream = fs.WriteStream
  if (fs$WriteStream) {
    WriteStream.prototype = Object.create(fs$WriteStream.prototype)
    WriteStream.prototype.open = WriteStream$open
  }

  fs.ReadStream = ReadStream
  fs.WriteStream = WriteStream

  function ReadStream (path, options) {
    if (this instanceof ReadStream)
      return fs$ReadStream.apply(this, arguments), this
    else
      return ReadStream.apply(Object.create(ReadStream.prototype), arguments)
  }

  function ReadStream$open () {
    var that = this
    open(that.path, that.flags, that.mode, function (err, fd) {
      if (err) {
        if (that.autoClose)
          that.destroy()

        that.emit('error', err)
      } else {
        that.fd = fd
        that.emit('open', fd)
        that.read()
      }
    })
  }

  function WriteStream (path, options) {
    if (this instanceof WriteStream)
      return fs$WriteStream.apply(this, arguments), this
    else
      return WriteStream.apply(Object.create(WriteStream.prototype), arguments)
  }

  function WriteStream$open () {
    var that = this
    open(that.path, that.flags, that.mode, function (err, fd) {
      if (err) {
        that.destroy()
        that.emit('error', err)
      } else {
        that.fd = fd
        that.emit('open', fd)
      }
    })
  }

  function createReadStream (path, options) {
    return new ReadStream(path, options)
  }

  function createWriteStream (path, options) {
    return new WriteStream(path, options)
  }

  var fs$open = fs.open
  fs.open = open
  function open (path, flags, mode, cb) {
    if (typeof mode === 'function')
      cb = mode, mode = null

    return go$open(path, flags, mode, cb)

    function go$open (path, flags, mode, cb) {
      return fs$open(path, flags, mode, function (err, fd) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$open, [path, flags, mode, cb]])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
          retry()
        }
      })
    }
  }

  return fs
}

function enqueue (elem) {
  debug('ENQUEUE', elem[0].name, elem[1])
  queue.push(elem)
}

function retry () {
  var elem = queue.shift()
  if (elem) {
    debug('RETRY', elem[0].name, elem[1])
    elem[0].apply(null, elem[1])
  }
}


/***/ }),
/* 9 */
/***/ (function(module, exports) {

module.exports = require("fs");

/***/ }),
/* 10 */
/***/ (function(module, exports, __webpack_require__) {

var constants = __webpack_require__(11)

var origCwd = process.cwd
var cwd = null

var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform

process.cwd = function() {
  if (!cwd)
    cwd = origCwd.call(process)
  return cwd
}
try {
  process.cwd()
} catch (er) {}

var chdir = process.chdir
process.chdir = function(d) {
  cwd = null
  chdir.call(process, d)
}

module.exports = patch

function patch (fs) {
  // (re-)implement some things that are known busted or missing.

  // lchmod, broken prior to 0.6.2
  // back-port the fix here.
  if (constants.hasOwnProperty('O_SYMLINK') &&
      process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
    patchLchmod(fs)
  }

  // lutimes implementation, or no-op
  if (!fs.lutimes) {
    patchLutimes(fs)
  }

  // https://github.com/isaacs/node-graceful-fs/issues/4
  // Chown should not fail on einval or eperm if non-root.
  // It should not fail on enosys ever, as this just indicates
  // that a fs doesn't support the intended operation.

  fs.chown = chownFix(fs.chown)
  fs.fchown = chownFix(fs.fchown)
  fs.lchown = chownFix(fs.lchown)

  fs.chmod = chmodFix(fs.chmod)
  fs.fchmod = chmodFix(fs.fchmod)
  fs.lchmod = chmodFix(fs.lchmod)

  fs.chownSync = chownFixSync(fs.chownSync)
  fs.fchownSync = chownFixSync(fs.fchownSync)
  fs.lchownSync = chownFixSync(fs.lchownSync)

  fs.chmodSync = chmodFixSync(fs.chmodSync)
  fs.fchmodSync = chmodFixSync(fs.fchmodSync)
  fs.lchmodSync = chmodFixSync(fs.lchmodSync)

  fs.stat = statFix(fs.stat)
  fs.fstat = statFix(fs.fstat)
  fs.lstat = statFix(fs.lstat)

  fs.statSync = statFixSync(fs.statSync)
  fs.fstatSync = statFixSync(fs.fstatSync)
  fs.lstatSync = statFixSync(fs.lstatSync)

  // if lchmod/lchown do not exist, then make them no-ops
  if (!fs.lchmod) {
    fs.lchmod = function (path, mode, cb) {
      if (cb) process.nextTick(cb)
    }
    fs.lchmodSync = function () {}
  }
  if (!fs.lchown) {
    fs.lchown = function (path, uid, gid, cb) {
      if (cb) process.nextTick(cb)
    }
    fs.lchownSync = function () {}
  }

  // on Windows, A/V software can lock the directory, causing this
  // to fail with an EACCES or EPERM if the directory contains newly
  // created files.  Try again on failure, for up to 60 seconds.

  // Set the timeout this long because some Windows Anti-Virus, such as Parity
  // bit9, may lock files for up to a minute, causing npm package install
  // failures. Also, take care to yield the scheduler. Windows scheduling gives
  // CPU to a busy looping process, which can cause the program causing the lock
  // contention to be starved of CPU by node, so the contention doesn't resolve.
  if (platform === "win32") {
    fs.rename = (function (fs$rename) { return function (from, to, cb) {
      var start = Date.now()
      var backoff = 0;
      fs$rename(from, to, function CB (er) {
        if (er
            && (er.code === "EACCES" || er.code === "EPERM")
            && Date.now() - start < 60000) {
          setTimeout(function() {
            fs.stat(to, function (stater, st) {
              if (stater && stater.code === "ENOENT")
                fs$rename(from, to, CB);
              else
                cb(er)
            })
          }, backoff)
          if (backoff < 100)
            backoff += 10;
          return;
        }
        if (cb) cb(er)
      })
    }})(fs.rename)
  }

  // if read() returns EAGAIN, then just try it again.
  fs.read = (function (fs$read) { return function (fd, buffer, offset, length, position, callback_) {
    var callback
    if (callback_ && typeof callback_ === 'function') {
      var eagCounter = 0
      callback = function (er, _, __) {
        if (er && er.code === 'EAGAIN' && eagCounter < 10) {
          eagCounter ++
          return fs$read.call(fs, fd, buffer, offset, length, position, callback)
        }
        callback_.apply(this, arguments)
      }
    }
    return fs$read.call(fs, fd, buffer, offset, length, position, callback)
  }})(fs.read)

  fs.readSync = (function (fs$readSync) { return function (fd, buffer, offset, length, position) {
    var eagCounter = 0
    while (true) {
      try {
        return fs$readSync.call(fs, fd, buffer, offset, length, position)
      } catch (er) {
        if (er.code === 'EAGAIN' && eagCounter < 10) {
          eagCounter ++
          continue
        }
        throw er
      }
    }
  }})(fs.readSync)

  function patchLchmod (fs) {
    fs.lchmod = function (path, mode, callback) {
      fs.open( path
             , constants.O_WRONLY | constants.O_SYMLINK
             , mode
             , function (err, fd) {
        if (err) {
          if (callback) callback(err)
          return
        }
        // prefer to return the chmod error, if one occurs,
        // but still try to close, and report closing errors if they occur.
        fs.fchmod(fd, mode, function (err) {
          fs.close(fd, function(err2) {
            if (callback) callback(err || err2)
          })
        })
      })
    }

    fs.lchmodSync = function (path, mode) {
      var fd = fs.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode)

      // prefer to return the chmod error, if one occurs,
      // but still try to close, and report closing errors if they occur.
      var threw = true
      var ret
      try {
        ret = fs.fchmodSync(fd, mode)
        threw = false
      } finally {
        if (threw) {
          try {
            fs.closeSync(fd)
          } catch (er) {}
        } else {
          fs.closeSync(fd)
        }
      }
      return ret
    }
  }

  function patchLutimes (fs) {
    if (constants.hasOwnProperty("O_SYMLINK")) {
      fs.lutimes = function (path, at, mt, cb) {
        fs.open(path, constants.O_SYMLINK, function (er, fd) {
          if (er) {
            if (cb) cb(er)
            return
          }
          fs.futimes(fd, at, mt, function (er) {
            fs.close(fd, function (er2) {
              if (cb) cb(er || er2)
            })
          })
        })
      }

      fs.lutimesSync = function (path, at, mt) {
        var fd = fs.openSync(path, constants.O_SYMLINK)
        var ret
        var threw = true
        try {
          ret = fs.futimesSync(fd, at, mt)
          threw = false
        } finally {
          if (threw) {
            try {
              fs.closeSync(fd)
            } catch (er) {}
          } else {
            fs.closeSync(fd)
          }
        }
        return ret
      }

    } else {
      fs.lutimes = function (_a, _b, _c, cb) { if (cb) process.nextTick(cb) }
      fs.lutimesSync = function () {}
    }
  }

  function chmodFix (orig) {
    if (!orig) return orig
    return function (target, mode, cb) {
      return orig.call(fs, target, mode, function (er) {
        if (chownErOk(er)) er = null
        if (cb) cb.apply(this, arguments)
      })
    }
  }

  function chmodFixSync (orig) {
    if (!orig) return orig
    return function (target, mode) {
      try {
        return orig.call(fs, target, mode)
      } catch (er) {
        if (!chownErOk(er)) throw er
      }
    }
  }


  function chownFix (orig) {
    if (!orig) return orig
    return function (target, uid, gid, cb) {
      return orig.call(fs, target, uid, gid, function (er) {
        if (chownErOk(er)) er = null
        if (cb) cb.apply(this, arguments)
      })
    }
  }

  function chownFixSync (orig) {
    if (!orig) return orig
    return function (target, uid, gid) {
      try {
        return orig.call(fs, target, uid, gid)
      } catch (er) {
        if (!chownErOk(er)) throw er
      }
    }
  }


  function statFix (orig) {
    if (!orig) return orig
    // Older versions of Node erroneously returned signed integers for
    // uid + gid.
    return function (target, cb) {
      return orig.call(fs, target, function (er, stats) {
        if (!stats) return cb.apply(this, arguments)
        if (stats.uid < 0) stats.uid += 0x100000000
        if (stats.gid < 0) stats.gid += 0x100000000
        if (cb) cb.apply(this, arguments)
      })
    }
  }

  function statFixSync (orig) {
    if (!orig) return orig
    // Older versions of Node erroneously returned signed integers for
    // uid + gid.
    return function (target) {
      var stats = orig.call(fs, target)
      if (stats.uid < 0) stats.uid += 0x100000000
      if (stats.gid < 0) stats.gid += 0x100000000
      return stats;
    }
  }

  // ENOSYS means that the fs doesn't support the op. Just ignore
  // that, because it doesn't matter.
  //
  // if there's no getuid, or if getuid() is something other
  // than 0, and the error is EINVAL or EPERM, then just ignore
  // it.
  //
  // This specific case is a silent failure in cp, install, tar,
  // and most other unix tools that manage permissions.
  //
  // When running as root, or if other types of errors are
  // encountered, then it's strict.
  function chownErOk (er) {
    if (!er)
      return true

    if (er.code === "ENOSYS")
      return true

    var nonroot = !process.getuid || process.getuid() !== 0
    if (nonroot) {
      if (er.code === "EINVAL" || er.code === "EPERM")
        return true
    }

    return false
  }
}


/***/ }),
/* 11 */
/***/ (function(module, exports) {

module.exports = require("constants");

/***/ }),
/* 12 */
/***/ (function(module, exports, __webpack_require__) {

var Stream = __webpack_require__(13).Stream

module.exports = legacy

function legacy (fs) {
  return {
    ReadStream: ReadStream,
    WriteStream: WriteStream
  }

  function ReadStream (path, options) {
    if (!(this instanceof ReadStream)) return new ReadStream(path, options);

    Stream.call(this);

    var self = this;

    this.path = path;
    this.fd = null;
    this.readable = true;
    this.paused = false;

    this.flags = 'r';
    this.mode = 438; /*=0666*/
    this.bufferSize = 64 * 1024;

    options = options || {};

    // Mixin options into this
    var keys = Object.keys(options);
    for (var index = 0, length = keys.length; index < length; index++) {
      var key = keys[index];
      this[key] = options[key];
    }

    if (this.encoding) this.setEncoding(this.encoding);

    if (this.start !== undefined) {
      if ('number' !== typeof this.start) {
        throw TypeError('start must be a Number');
      }
      if (this.end === undefined) {
        this.end = Infinity;
      } else if ('number' !== typeof this.end) {
        throw TypeError('end must be a Number');
      }

      if (this.start > this.end) {
        throw new Error('start must be <= end');
      }

      this.pos = this.start;
    }

    if (this.fd !== null) {
      process.nextTick(function() {
        self._read();
      });
      return;
    }

    fs.open(this.path, this.flags, this.mode, function (err, fd) {
      if (err) {
        self.emit('error', err);
        self.readable = false;
        return;
      }

      self.fd = fd;
      self.emit('open', fd);
      self._read();
    })
  }

  function WriteStream (path, options) {
    if (!(this instanceof WriteStream)) return new WriteStream(path, options);

    Stream.call(this);

    this.path = path;
    this.fd = null;
    this.writable = true;

    this.flags = 'w';
    this.encoding = 'binary';
    this.mode = 438; /*=0666*/
    this.bytesWritten = 0;

    options = options || {};

    // Mixin options into this
    var keys = Object.keys(options);
    for (var index = 0, length = keys.length; index < length; index++) {
      var key = keys[index];
      this[key] = options[key];
    }

    if (this.start !== undefined) {
      if ('number' !== typeof this.start) {
        throw TypeError('start must be a Number');
      }
      if (this.start < 0) {
        throw new Error('start must be >= zero');
      }

      this.pos = this.start;
    }

    this.busy = false;
    this._queue = [];

    if (this.fd === null) {
      this._open = fs.open;
      this._queue.push([this._open, this.path, this.flags, this.mode, undefined]);
      this.flush();
    }
  }
}


/***/ }),
/* 13 */
/***/ (function(module, exports) {

module.exports = require("stream");

/***/ }),
/* 14 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


module.exports = clone

function clone (obj) {
  if (obj === null || typeof obj !== 'object')
    return obj

  if (obj instanceof Object)
    var copy = { __proto__: obj.__proto__ }
  else
    var copy = Object.create(null)

  Object.getOwnPropertyNames(obj).forEach(function (key) {
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key))
  })

  return copy
}


/***/ }),
/* 15 */
/***/ (function(module, exports) {

module.exports = require("assert");

/***/ }),
/* 16 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


module.exports = {
  copySync: __webpack_require__(17)
}


/***/ }),
/* 17 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const mkdirpSync = __webpack_require__(19).mkdirsSync
const utimesSync = __webpack_require__(23).utimesMillisSync

const notExist = Symbol('notExist')

function copySync (src, dest, opts) {
  if (typeof opts === 'function') {
    opts = {filter: opts}
  }

  opts = opts || {}
  opts.clobber = 'clobber' in opts ? !!opts.clobber : true // default to true for now
  opts.overwrite = 'overwrite' in opts ? !!opts.overwrite : opts.clobber // overwrite falls back to clobber

  // Warn about using preserveTimestamps on 32-bit node
  if (opts.preserveTimestamps && process.arch === 'ia32') {
    console.warn(`fs-extra: Using the preserveTimestamps option in 32-bit node is not recommended;\n
    see https://github.com/jprichardson/node-fs-extra/issues/269`)
  }

  const destStat = checkPaths(src, dest)

  if (opts.filter && !opts.filter(src, dest)) return

  const destParent = path.dirname(dest)
  if (!fs.existsSync(destParent)) mkdirpSync(destParent)
  return startCopy(destStat, src, dest, opts)
}

function startCopy (destStat, src, dest, opts) {
  if (opts.filter && !opts.filter(src, dest)) return
  return getStats(destStat, src, dest, opts)
}

function getStats (destStat, src, dest, opts) {
  const statSync = opts.dereference ? fs.statSync : fs.lstatSync
  const srcStat = statSync(src)

  if (srcStat.isDirectory()) return onDir(srcStat, destStat, src, dest, opts)
  else if (srcStat.isFile() ||
           srcStat.isCharacterDevice() ||
           srcStat.isBlockDevice()) return onFile(srcStat, destStat, src, dest, opts)
  else if (srcStat.isSymbolicLink()) return onLink(destStat, src, dest, opts)
}

function onFile (srcStat, destStat, src, dest, opts) {
  if (destStat === notExist) return copyFile(srcStat, src, dest, opts)
  return mayCopyFile(srcStat, src, dest, opts)
}

function mayCopyFile (srcStat, src, dest, opts) {
  if (opts.overwrite) {
    fs.unlinkSync(dest)
    return copyFile(srcStat, src, dest, opts)
  } else if (opts.errorOnExist) {
    throw new Error(`'${dest}' already exists`)
  }
}

function copyFile (srcStat, src, dest, opts) {
  if (typeof fs.copyFileSync === 'function') {
    fs.copyFileSync(src, dest)
    fs.chmodSync(dest, srcStat.mode)
    if (opts.preserveTimestamps) {
      return utimesSync(dest, srcStat.atime, srcStat.mtime)
    }
    return
  }
  return copyFileFallback(srcStat, src, dest, opts)
}

function copyFileFallback (srcStat, src, dest, opts) {
  const BUF_LENGTH = 64 * 1024
  const _buff = __webpack_require__(25)(BUF_LENGTH)

  const fdr = fs.openSync(src, 'r')
  const fdw = fs.openSync(dest, 'w', srcStat.mode)
  let pos = 0

  while (pos < srcStat.size) {
    const bytesRead = fs.readSync(fdr, _buff, 0, BUF_LENGTH, pos)
    fs.writeSync(fdw, _buff, 0, bytesRead)
    pos += bytesRead
  }

  if (opts.preserveTimestamps) fs.futimesSync(fdw, srcStat.atime, srcStat.mtime)

  fs.closeSync(fdr)
  fs.closeSync(fdw)
}

function onDir (srcStat, destStat, src, dest, opts) {
  if (destStat === notExist) return mkDirAndCopy(srcStat, src, dest, opts)
  if (destStat && !destStat.isDirectory()) {
    throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`)
  }
  return copyDir(src, dest, opts)
}

function mkDirAndCopy (srcStat, src, dest, opts) {
  fs.mkdirSync(dest)
  copyDir(src, dest, opts)
  return fs.chmodSync(dest, srcStat.mode)
}

function copyDir (src, dest, opts) {
  fs.readdirSync(src).forEach(item => copyDirItem(item, src, dest, opts))
}

function copyDirItem (item, src, dest, opts) {
  const srcItem = path.join(src, item)
  const destItem = path.join(dest, item)
  const destStat = checkPaths(srcItem, destItem)
  return startCopy(destStat, srcItem, destItem, opts)
}

function onLink (destStat, src, dest, opts) {
  let resolvedSrc = fs.readlinkSync(src)

  if (opts.dereference) {
    resolvedSrc = path.resolve(process.cwd(), resolvedSrc)
  }

  if (destStat === notExist) {
    return fs.symlinkSync(resolvedSrc, dest)
  } else {
    let resolvedDest
    try {
      resolvedDest = fs.readlinkSync(dest)
    } catch (err) {
      // dest exists and is a regular file or directory,
      // Windows may throw UNKNOWN error. If dest already exists,
      // fs throws error anyway, so no need to guard against it here.
      if (err.code === 'EINVAL' || err.code === 'UNKNOWN') return fs.symlinkSync(resolvedSrc, dest)
      throw err
    }
    if (opts.dereference) {
      resolvedDest = path.resolve(process.cwd(), resolvedDest)
    }
    if (isSrcSubdir(resolvedSrc, resolvedDest)) {
      throw new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`)
    }

    // prevent copy if src is a subdir of dest since unlinking
    // dest in this case would result in removing src contents
    // and therefore a broken symlink would be created.
    if (fs.statSync(dest).isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) {
      throw new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`)
    }
    return copyLink(resolvedSrc, dest)
  }
}

function copyLink (resolvedSrc, dest) {
  fs.unlinkSync(dest)
  return fs.symlinkSync(resolvedSrc, dest)
}

// return true if dest is a subdir of src, otherwise false.
function isSrcSubdir (src, dest) {
  const srcArray = path.resolve(src).split(path.sep)
  const destArray = path.resolve(dest).split(path.sep)
  return srcArray.reduce((acc, current, i) => acc && destArray[i] === current, true)
}

function checkStats (src, dest) {
  const srcStat = fs.statSync(src)
  let destStat
  try {
    destStat = fs.statSync(dest)
  } catch (err) {
    if (err.code === 'ENOENT') return {srcStat, destStat: notExist}
    throw err
  }
  return {srcStat, destStat}
}

function checkPaths (src, dest) {
  const {srcStat, destStat} = checkStats(src, dest)
  if (destStat.ino && destStat.ino === srcStat.ino) {
    throw new Error('Source and destination must not be the same.')
  }
  if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
    throw new Error(`Cannot copy '${src}' to a subdirectory of itself, '${dest}'.`)
  }
  return destStat
}

module.exports = copySync


/***/ }),
/* 18 */
/***/ (function(module, exports) {

module.exports = require("path");

/***/ }),
/* 19 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const u = __webpack_require__(7).fromCallback
const mkdirs = u(__webpack_require__(20))
const mkdirsSync = __webpack_require__(22)

module.exports = {
  mkdirs,
  mkdirsSync,
  // alias
  mkdirp: mkdirs,
  mkdirpSync: mkdirsSync,
  ensureDir: mkdirs,
  ensureDirSync: mkdirsSync
}


/***/ }),
/* 20 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const invalidWin32Path = __webpack_require__(21).invalidWin32Path

const o777 = parseInt('0777', 8)

function mkdirs (p, opts, callback, made) {
  if (typeof opts === 'function') {
    callback = opts
    opts = {}
  } else if (!opts || typeof opts !== 'object') {
    opts = { mode: opts }
  }

  if (process.platform === 'win32' && invalidWin32Path(p)) {
    const errInval = new Error(p + ' contains invalid WIN32 path characters.')
    errInval.code = 'EINVAL'
    return callback(errInval)
  }

  let mode = opts.mode
  const xfs = opts.fs || fs

  if (mode === undefined) {
    mode = o777 & (~process.umask())
  }
  if (!made) made = null

  callback = callback || function () {}
  p = path.resolve(p)

  xfs.mkdir(p, mode, er => {
    if (!er) {
      made = made || p
      return callback(null, made)
    }
    switch (er.code) {
      case 'ENOENT':
        if (path.dirname(p) === p) return callback(er)
        mkdirs(path.dirname(p), opts, (er, made) => {
          if (er) callback(er, made)
          else mkdirs(p, opts, callback, made)
        })
        break

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        xfs.stat(p, (er2, stat) => {
          // if the stat fails, then that's super weird.
          // let the original error be the failure reason.
          if (er2 || !stat.isDirectory()) callback(er, made)
          else callback(null, made)
        })
        break
    }
  })
}

module.exports = mkdirs


/***/ }),
/* 21 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const path = __webpack_require__(18)

// get drive on windows
function getRootPath (p) {
  p = path.normalize(path.resolve(p)).split(path.sep)
  if (p.length > 0) return p[0]
  return null
}

// http://stackoverflow.com/a/62888/10333 contains more accurate
// TODO: expand to include the rest
const INVALID_PATH_CHARS = /[<>:"|?*]/

function invalidWin32Path (p) {
  const rp = getRootPath(p)
  p = p.replace(rp, '')
  return INVALID_PATH_CHARS.test(p)
}

module.exports = {
  getRootPath,
  invalidWin32Path
}


/***/ }),
/* 22 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const invalidWin32Path = __webpack_require__(21).invalidWin32Path

const o777 = parseInt('0777', 8)

function mkdirsSync (p, opts, made) {
  if (!opts || typeof opts !== 'object') {
    opts = { mode: opts }
  }

  let mode = opts.mode
  const xfs = opts.fs || fs

  if (process.platform === 'win32' && invalidWin32Path(p)) {
    const errInval = new Error(p + ' contains invalid WIN32 path characters.')
    errInval.code = 'EINVAL'
    throw errInval
  }

  if (mode === undefined) {
    mode = o777 & (~process.umask())
  }
  if (!made) made = null

  p = path.resolve(p)

  try {
    xfs.mkdirSync(p, mode)
    made = made || p
  } catch (err0) {
    if (err0.code === 'ENOENT') {
      if (path.dirname(p) === p) throw err0
      made = mkdirsSync(path.dirname(p), opts, made)
      mkdirsSync(p, opts, made)
    } else {
      // In the case of any other error, just see if there's a dir there
      // already. If so, then hooray!  If not, then something is borked.
      let stat
      try {
        stat = xfs.statSync(p)
      } catch (err1) {
        throw err0
      }
      if (!stat.isDirectory()) throw err0
    }
  }

  return made
}

module.exports = mkdirsSync


/***/ }),
/* 23 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const os = __webpack_require__(24)
const path = __webpack_require__(18)

// HFS, ext{2,3}, FAT do not, Node.js v0.10 does not
function hasMillisResSync () {
  let tmpfile = path.join('millis-test-sync' + Date.now().toString() + Math.random().toString().slice(2))
  tmpfile = path.join(os.tmpdir(), tmpfile)

  // 550 millis past UNIX epoch
  const d = new Date(1435410243862)
  fs.writeFileSync(tmpfile, 'https://github.com/jprichardson/node-fs-extra/pull/141')
  const fd = fs.openSync(tmpfile, 'r+')
  fs.futimesSync(fd, d, d)
  fs.closeSync(fd)
  return fs.statSync(tmpfile).mtime > 1435410243000
}

function hasMillisRes (callback) {
  let tmpfile = path.join('millis-test' + Date.now().toString() + Math.random().toString().slice(2))
  tmpfile = path.join(os.tmpdir(), tmpfile)

  // 550 millis past UNIX epoch
  const d = new Date(1435410243862)
  fs.writeFile(tmpfile, 'https://github.com/jprichardson/node-fs-extra/pull/141', err => {
    if (err) return callback(err)
    fs.open(tmpfile, 'r+', (err, fd) => {
      if (err) return callback(err)
      fs.futimes(fd, d, d, err => {
        if (err) return callback(err)
        fs.close(fd, err => {
          if (err) return callback(err)
          fs.stat(tmpfile, (err, stats) => {
            if (err) return callback(err)
            callback(null, stats.mtime > 1435410243000)
          })
        })
      })
    })
  })
}

function timeRemoveMillis (timestamp) {
  if (typeof timestamp === 'number') {
    return Math.floor(timestamp / 1000) * 1000
  } else if (timestamp instanceof Date) {
    return new Date(Math.floor(timestamp.getTime() / 1000) * 1000)
  } else {
    throw new Error('fs-extra: timeRemoveMillis() unknown parameter type')
  }
}

function utimesMillis (path, atime, mtime, callback) {
  // if (!HAS_MILLIS_RES) return fs.utimes(path, atime, mtime, callback)
  fs.open(path, 'r+', (err, fd) => {
    if (err) return callback(err)
    fs.futimes(fd, atime, mtime, futimesErr => {
      fs.close(fd, closeErr => {
        if (callback) callback(futimesErr || closeErr)
      })
    })
  })
}

function utimesMillisSync (path, atime, mtime) {
  const fd = fs.openSync(path, 'r+')
  fs.futimesSync(fd, atime, mtime)
  return fs.closeSync(fd)
}

module.exports = {
  hasMillisRes,
  hasMillisResSync,
  timeRemoveMillis,
  utimesMillis,
  utimesMillisSync
}


/***/ }),
/* 24 */
/***/ (function(module, exports) {

module.exports = require("os");

/***/ }),
/* 25 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

/* eslint-disable node/no-deprecated-api */
module.exports = function (size) {
  if (typeof Buffer.allocUnsafe === 'function') {
    try {
      return Buffer.allocUnsafe(size)
    } catch (e) {
      return new Buffer(size)
    }
  }
  return new Buffer(size)
}


/***/ }),
/* 26 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
module.exports = {
  copy: u(__webpack_require__(27))
}


/***/ }),
/* 27 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const mkdirp = __webpack_require__(19).mkdirs
const pathExists = __webpack_require__(28).pathExists
const utimes = __webpack_require__(23).utimesMillis

const notExist = Symbol('notExist')

function copy (src, dest, opts, cb) {
  if (typeof opts === 'function' && !cb) {
    cb = opts
    opts = {}
  } else if (typeof opts === 'function') {
    opts = {filter: opts}
  }

  cb = cb || function () {}
  opts = opts || {}

  opts.clobber = 'clobber' in opts ? !!opts.clobber : true // default to true for now
  opts.overwrite = 'overwrite' in opts ? !!opts.overwrite : opts.clobber // overwrite falls back to clobber

  // Warn about using preserveTimestamps on 32-bit node
  if (opts.preserveTimestamps && process.arch === 'ia32') {
    console.warn(`fs-extra: Using the preserveTimestamps option in 32-bit node is not recommended;\n
    see https://github.com/jprichardson/node-fs-extra/issues/269`)
  }

  checkPaths(src, dest, (err, destStat) => {
    if (err) return cb(err)
    if (opts.filter) return handleFilter(checkParentDir, destStat, src, dest, opts, cb)
    return checkParentDir(destStat, src, dest, opts, cb)
  })
}

function checkParentDir (destStat, src, dest, opts, cb) {
  const destParent = path.dirname(dest)
  pathExists(destParent, (err, dirExists) => {
    if (err) return cb(err)
    if (dirExists) return startCopy(destStat, src, dest, opts, cb)
    mkdirp(destParent, err => {
      if (err) return cb(err)
      return startCopy(destStat, src, dest, opts, cb)
    })
  })
}

function handleFilter (onInclude, destStat, src, dest, opts, cb) {
  Promise.resolve(opts.filter(src, dest)).then(include => {
    if (include) {
      if (destStat) return onInclude(destStat, src, dest, opts, cb)
      return onInclude(src, dest, opts, cb)
    }
    return cb()
  }, error => cb(error))
}

function startCopy (destStat, src, dest, opts, cb) {
  if (opts.filter) return handleFilter(getStats, destStat, src, dest, opts, cb)
  return getStats(destStat, src, dest, opts, cb)
}

function getStats (destStat, src, dest, opts, cb) {
  const stat = opts.dereference ? fs.stat : fs.lstat
  stat(src, (err, srcStat) => {
    if (err) return cb(err)

    if (srcStat.isDirectory()) return onDir(srcStat, destStat, src, dest, opts, cb)
    else if (srcStat.isFile() ||
             srcStat.isCharacterDevice() ||
             srcStat.isBlockDevice()) return onFile(srcStat, destStat, src, dest, opts, cb)
    else if (srcStat.isSymbolicLink()) return onLink(destStat, src, dest, opts, cb)
  })
}

function onFile (srcStat, destStat, src, dest, opts, cb) {
  if (destStat === notExist) return copyFile(srcStat, src, dest, opts, cb)
  return mayCopyFile(srcStat, src, dest, opts, cb)
}

function mayCopyFile (srcStat, src, dest, opts, cb) {
  if (opts.overwrite) {
    fs.unlink(dest, err => {
      if (err) return cb(err)
      return copyFile(srcStat, src, dest, opts, cb)
    })
  } else if (opts.errorOnExist) {
    return cb(new Error(`'${dest}' already exists`))
  } else return cb()
}

function copyFile (srcStat, src, dest, opts, cb) {
  if (typeof fs.copyFile === 'function') {
    return fs.copyFile(src, dest, err => {
      if (err) return cb(err)
      return setDestModeAndTimestamps(srcStat, dest, opts, cb)
    })
  }
  return copyFileFallback(srcStat, src, dest, opts, cb)
}

function copyFileFallback (srcStat, src, dest, opts, cb) {
  const rs = fs.createReadStream(src)
  rs.on('error', err => cb(err)).once('open', () => {
    const ws = fs.createWriteStream(dest, { mode: srcStat.mode })
    ws.on('error', err => cb(err))
      .on('open', () => rs.pipe(ws))
      .once('close', () => setDestModeAndTimestamps(srcStat, dest, opts, cb))
  })
}

function setDestModeAndTimestamps (srcStat, dest, opts, cb) {
  fs.chmod(dest, srcStat.mode, err => {
    if (err) return cb(err)
    if (opts.preserveTimestamps) {
      return utimes(dest, srcStat.atime, srcStat.mtime, cb)
    }
    return cb()
  })
}

function onDir (srcStat, destStat, src, dest, opts, cb) {
  if (destStat === notExist) return mkDirAndCopy(srcStat, src, dest, opts, cb)
  if (destStat && !destStat.isDirectory()) {
    return cb(new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`))
  }
  return copyDir(src, dest, opts, cb)
}

function mkDirAndCopy (srcStat, src, dest, opts, cb) {
  fs.mkdir(dest, err => {
    if (err) return cb(err)
    copyDir(src, dest, opts, err => {
      if (err) return cb(err)
      return fs.chmod(dest, srcStat.mode, cb)
    })
  })
}

function copyDir (src, dest, opts, cb) {
  fs.readdir(src, (err, items) => {
    if (err) return cb(err)
    return copyDirItems(items, src, dest, opts, cb)
  })
}

function copyDirItems (items, src, dest, opts, cb) {
  const item = items.pop()
  if (!item) return cb()
  return copyDirItem(items, item, src, dest, opts, cb)
}

function copyDirItem (items, item, src, dest, opts, cb) {
  const srcItem = path.join(src, item)
  const destItem = path.join(dest, item)
  checkPaths(srcItem, destItem, (err, destStat) => {
    if (err) return cb(err)
    startCopy(destStat, srcItem, destItem, opts, err => {
      if (err) return cb(err)
      return copyDirItems(items, src, dest, opts, cb)
    })
  })
}

function onLink (destStat, src, dest, opts, cb) {
  fs.readlink(src, (err, resolvedSrc) => {
    if (err) return cb(err)

    if (opts.dereference) {
      resolvedSrc = path.resolve(process.cwd(), resolvedSrc)
    }

    if (destStat === notExist) {
      return fs.symlink(resolvedSrc, dest, cb)
    } else {
      fs.readlink(dest, (err, resolvedDest) => {
        if (err) {
          // dest exists and is a regular file or directory,
          // Windows may throw UNKNOWN error. If dest already exists,
          // fs throws error anyway, so no need to guard against it here.
          if (err.code === 'EINVAL' || err.code === 'UNKNOWN') return fs.symlink(resolvedSrc, dest, cb)
          return cb(err)
        }
        if (opts.dereference) {
          resolvedDest = path.resolve(process.cwd(), resolvedDest)
        }
        if (isSrcSubdir(resolvedSrc, resolvedDest)) {
          return cb(new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`))
        }

        // do not copy if src is a subdir of dest since unlinking
        // dest in this case would result in removing src contents
        // and therefore a broken symlink would be created.
        if (destStat.isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) {
          return cb(new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`))
        }
        return copyLink(resolvedSrc, dest, cb)
      })
    }
  })
}

function copyLink (resolvedSrc, dest, cb) {
  fs.unlink(dest, err => {
    if (err) return cb(err)
    return fs.symlink(resolvedSrc, dest, cb)
  })
}

// return true if dest is a subdir of src, otherwise false.
function isSrcSubdir (src, dest) {
  const srcArray = path.resolve(src).split(path.sep)
  const destArray = path.resolve(dest).split(path.sep)
  return srcArray.reduce((acc, current, i) => acc && destArray[i] === current, true)
}

function checkStats (src, dest, cb) {
  fs.stat(src, (err, srcStat) => {
    if (err) return cb(err)
    fs.stat(dest, (err, destStat) => {
      if (err) {
        if (err.code === 'ENOENT') return cb(null, {srcStat, destStat: notExist})
        return cb(err)
      }
      return cb(null, {srcStat, destStat})
    })
  })
}

function checkPaths (src, dest, cb) {
  checkStats(src, dest, (err, stats) => {
    if (err) return cb(err)
    const {srcStat, destStat} = stats
    if (destStat.ino && destStat.ino === srcStat.ino) {
      return cb(new Error('Source and destination must not be the same.'))
    }
    if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
      return cb(new Error(`Cannot copy '${src}' to a subdirectory of itself, '${dest}'.`))
    }
    return cb(null, destStat)
  })
}

module.exports = copy


/***/ }),
/* 28 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const u = __webpack_require__(7).fromPromise
const fs = __webpack_require__(6)

function pathExists (path) {
  return fs.access(path).then(() => true).catch(() => false)
}

module.exports = {
  pathExists: u(pathExists),
  pathExistsSync: fs.existsSync
}


/***/ }),
/* 29 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const fs = __webpack_require__(9)
const path = __webpack_require__(18)
const mkdir = __webpack_require__(19)
const remove = __webpack_require__(30)

const emptyDir = u(function emptyDir (dir, callback) {
  callback = callback || function () {}
  fs.readdir(dir, (err, items) => {
    if (err) return mkdir.mkdirs(dir, callback)

    items = items.map(item => path.join(dir, item))

    deleteItem()

    function deleteItem () {
      const item = items.pop()
      if (!item) return callback()
      remove.remove(item, err => {
        if (err) return callback(err)
        deleteItem()
      })
    }
  })
})

function emptyDirSync (dir) {
  let items
  try {
    items = fs.readdirSync(dir)
  } catch (err) {
    return mkdir.mkdirsSync(dir)
  }

  items.forEach(item => {
    item = path.join(dir, item)
    remove.removeSync(item)
  })
}

module.exports = {
  emptyDirSync,
  emptydirSync: emptyDirSync,
  emptyDir,
  emptydir: emptyDir
}


/***/ }),
/* 30 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const rimraf = __webpack_require__(31)

module.exports = {
  remove: u(rimraf),
  removeSync: rimraf.sync
}


/***/ }),
/* 31 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const assert = __webpack_require__(15)

const isWindows = (process.platform === 'win32')

function defaults (options) {
  const methods = [
    'unlink',
    'chmod',
    'stat',
    'lstat',
    'rmdir',
    'readdir'
  ]
  methods.forEach(m => {
    options[m] = options[m] || fs[m]
    m = m + 'Sync'
    options[m] = options[m] || fs[m]
  })

  options.maxBusyTries = options.maxBusyTries || 3
}

function rimraf (p, options, cb) {
  let busyTries = 0

  if (typeof options === 'function') {
    cb = options
    options = {}
  }

  assert(p, 'rimraf: missing path')
  assert.strictEqual(typeof p, 'string', 'rimraf: path should be a string')
  assert.strictEqual(typeof cb, 'function', 'rimraf: callback function required')
  assert(options, 'rimraf: invalid options argument provided')
  assert.strictEqual(typeof options, 'object', 'rimraf: options should be object')

  defaults(options)

  rimraf_(p, options, function CB (er) {
    if (er) {
      if ((er.code === 'EBUSY' || er.code === 'ENOTEMPTY' || er.code === 'EPERM') &&
          busyTries < options.maxBusyTries) {
        busyTries++
        const time = busyTries * 100
        // try again, with the same exact callback as this one.
        return setTimeout(() => rimraf_(p, options, CB), time)
      }

      // already gone
      if (er.code === 'ENOENT') er = null
    }

    cb(er)
  })
}

// Two possible strategies.
// 1. Assume it's a file.  unlink it, then do the dir stuff on EPERM or EISDIR
// 2. Assume it's a directory.  readdir, then do the file stuff on ENOTDIR
//
// Both result in an extra syscall when you guess wrong.  However, there
// are likely far more normal files in the world than directories.  This
// is based on the assumption that a the average number of files per
// directory is >= 1.
//
// If anyone ever complains about this, then I guess the strategy could
// be made configurable somehow.  But until then, YAGNI.
function rimraf_ (p, options, cb) {
  assert(p)
  assert(options)
  assert(typeof cb === 'function')

  // sunos lets the root user unlink directories, which is... weird.
  // so we have to lstat here and make sure it's not a dir.
  options.lstat(p, (er, st) => {
    if (er && er.code === 'ENOENT') {
      return cb(null)
    }

    // Windows can EPERM on stat.  Life is suffering.
    if (er && er.code === 'EPERM' && isWindows) {
      return fixWinEPERM(p, options, er, cb)
    }

    if (st && st.isDirectory()) {
      return rmdir(p, options, er, cb)
    }

    options.unlink(p, er => {
      if (er) {
        if (er.code === 'ENOENT') {
          return cb(null)
        }
        if (er.code === 'EPERM') {
          return (isWindows)
            ? fixWinEPERM(p, options, er, cb)
            : rmdir(p, options, er, cb)
        }
        if (er.code === 'EISDIR') {
          return rmdir(p, options, er, cb)
        }
      }
      return cb(er)
    })
  })
}

function fixWinEPERM (p, options, er, cb) {
  assert(p)
  assert(options)
  assert(typeof cb === 'function')
  if (er) {
    assert(er instanceof Error)
  }

  options.chmod(p, 0o666, er2 => {
    if (er2) {
      cb(er2.code === 'ENOENT' ? null : er)
    } else {
      options.stat(p, (er3, stats) => {
        if (er3) {
          cb(er3.code === 'ENOENT' ? null : er)
        } else if (stats.isDirectory()) {
          rmdir(p, options, er, cb)
        } else {
          options.unlink(p, cb)
        }
      })
    }
  })
}

function fixWinEPERMSync (p, options, er) {
  let stats

  assert(p)
  assert(options)
  if (er) {
    assert(er instanceof Error)
  }

  try {
    options.chmodSync(p, 0o666)
  } catch (er2) {
    if (er2.code === 'ENOENT') {
      return
    } else {
      throw er
    }
  }

  try {
    stats = options.statSync(p)
  } catch (er3) {
    if (er3.code === 'ENOENT') {
      return
    } else {
      throw er
    }
  }

  if (stats.isDirectory()) {
    rmdirSync(p, options, er)
  } else {
    options.unlinkSync(p)
  }
}

function rmdir (p, options, originalEr, cb) {
  assert(p)
  assert(options)
  if (originalEr) {
    assert(originalEr instanceof Error)
  }
  assert(typeof cb === 'function')

  // try to rmdir first, and only readdir on ENOTEMPTY or EEXIST (SunOS)
  // if we guessed wrong, and it's not a directory, then
  // raise the original error.
  options.rmdir(p, er => {
    if (er && (er.code === 'ENOTEMPTY' || er.code === 'EEXIST' || er.code === 'EPERM')) {
      rmkids(p, options, cb)
    } else if (er && er.code === 'ENOTDIR') {
      cb(originalEr)
    } else {
      cb(er)
    }
  })
}

function rmkids (p, options, cb) {
  assert(p)
  assert(options)
  assert(typeof cb === 'function')

  options.readdir(p, (er, files) => {
    if (er) return cb(er)

    let n = files.length
    let errState

    if (n === 0) return options.rmdir(p, cb)

    files.forEach(f => {
      rimraf(path.join(p, f), options, er => {
        if (errState) {
          return
        }
        if (er) return cb(errState = er)
        if (--n === 0) {
          options.rmdir(p, cb)
        }
      })
    })
  })
}

// this looks simpler, and is strictly *faster*, but will
// tie up the JavaScript thread and fail on excessively
// deep directory trees.
function rimrafSync (p, options) {
  let st

  options = options || {}
  defaults(options)

  assert(p, 'rimraf: missing path')
  assert.strictEqual(typeof p, 'string', 'rimraf: path should be a string')
  assert(options, 'rimraf: missing options')
  assert.strictEqual(typeof options, 'object', 'rimraf: options should be object')

  try {
    st = options.lstatSync(p)
  } catch (er) {
    if (er.code === 'ENOENT') {
      return
    }

    // Windows can EPERM on stat.  Life is suffering.
    if (er.code === 'EPERM' && isWindows) {
      fixWinEPERMSync(p, options, er)
    }
  }

  try {
    // sunos lets the root user unlink directories, which is... weird.
    if (st && st.isDirectory()) {
      rmdirSync(p, options, null)
    } else {
      options.unlinkSync(p)
    }
  } catch (er) {
    if (er.code === 'ENOENT') {
      return
    } else if (er.code === 'EPERM') {
      return isWindows ? fixWinEPERMSync(p, options, er) : rmdirSync(p, options, er)
    } else if (er.code !== 'EISDIR') {
      throw er
    }
    rmdirSync(p, options, er)
  }
}

function rmdirSync (p, options, originalEr) {
  assert(p)
  assert(options)
  if (originalEr) {
    assert(originalEr instanceof Error)
  }

  try {
    options.rmdirSync(p)
  } catch (er) {
    if (er.code === 'ENOTDIR') {
      throw originalEr
    } else if (er.code === 'ENOTEMPTY' || er.code === 'EEXIST' || er.code === 'EPERM') {
      rmkidsSync(p, options)
    } else if (er.code !== 'ENOENT') {
      throw er
    }
  }
}

function rmkidsSync (p, options) {
  assert(p)
  assert(options)
  options.readdirSync(p).forEach(f => rimrafSync(path.join(p, f), options))

  if (isWindows) {
    // We only end up here once we got ENOTEMPTY at least once, and
    // at this point, we are guaranteed to have removed all the kids.
    // So, we know that it won't be ENOENT or ENOTDIR or anything else.
    // try really hard to delete stuff on windows, because it has a
    // PROFOUNDLY annoying habit of not closing handles promptly when
    // files are deleted, resulting in spurious ENOTEMPTY errors.
    const startTime = Date.now()
    do {
      try {
        const ret = options.rmdirSync(p, options)
        return ret
      } catch (er) { }
    } while (Date.now() - startTime < 500) // give up after 500ms
  } else {
    const ret = options.rmdirSync(p, options)
    return ret
  }
}

module.exports = rimraf
rimraf.sync = rimrafSync


/***/ }),
/* 32 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const file = __webpack_require__(33)
const link = __webpack_require__(34)
const symlink = __webpack_require__(35)

module.exports = {
  // file
  createFile: file.createFile,
  createFileSync: file.createFileSync,
  ensureFile: file.createFile,
  ensureFileSync: file.createFileSync,
  // link
  createLink: link.createLink,
  createLinkSync: link.createLinkSync,
  ensureLink: link.createLink,
  ensureLinkSync: link.createLinkSync,
  // symlink
  createSymlink: symlink.createSymlink,
  createSymlinkSync: symlink.createSymlinkSync,
  ensureSymlink: symlink.createSymlink,
  ensureSymlinkSync: symlink.createSymlinkSync
}


/***/ }),
/* 33 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const path = __webpack_require__(18)
const fs = __webpack_require__(8)
const mkdir = __webpack_require__(19)
const pathExists = __webpack_require__(28).pathExists

function createFile (file, callback) {
  function makeFile () {
    fs.writeFile(file, '', err => {
      if (err) return callback(err)
      callback()
    })
  }

  fs.stat(file, (err, stats) => { // eslint-disable-line handle-callback-err
    if (!err && stats.isFile()) return callback()
    const dir = path.dirname(file)
    pathExists(dir, (err, dirExists) => {
      if (err) return callback(err)
      if (dirExists) return makeFile()
      mkdir.mkdirs(dir, err => {
        if (err) return callback(err)
        makeFile()
      })
    })
  })
}

function createFileSync (file) {
  let stats
  try {
    stats = fs.statSync(file)
  } catch (e) {}
  if (stats && stats.isFile()) return

  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    mkdir.mkdirsSync(dir)
  }

  fs.writeFileSync(file, '')
}

module.exports = {
  createFile: u(createFile),
  createFileSync
}


/***/ }),
/* 34 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const path = __webpack_require__(18)
const fs = __webpack_require__(8)
const mkdir = __webpack_require__(19)
const pathExists = __webpack_require__(28).pathExists

function createLink (srcpath, dstpath, callback) {
  function makeLink (srcpath, dstpath) {
    fs.link(srcpath, dstpath, err => {
      if (err) return callback(err)
      callback(null)
    })
  }

  pathExists(dstpath, (err, destinationExists) => {
    if (err) return callback(err)
    if (destinationExists) return callback(null)
    fs.lstat(srcpath, (err) => {
      if (err) {
        err.message = err.message.replace('lstat', 'ensureLink')
        return callback(err)
      }

      const dir = path.dirname(dstpath)
      pathExists(dir, (err, dirExists) => {
        if (err) return callback(err)
        if (dirExists) return makeLink(srcpath, dstpath)
        mkdir.mkdirs(dir, err => {
          if (err) return callback(err)
          makeLink(srcpath, dstpath)
        })
      })
    })
  })
}

function createLinkSync (srcpath, dstpath) {
  const destinationExists = fs.existsSync(dstpath)
  if (destinationExists) return undefined

  try {
    fs.lstatSync(srcpath)
  } catch (err) {
    err.message = err.message.replace('lstat', 'ensureLink')
    throw err
  }

  const dir = path.dirname(dstpath)
  const dirExists = fs.existsSync(dir)
  if (dirExists) return fs.linkSync(srcpath, dstpath)
  mkdir.mkdirsSync(dir)

  return fs.linkSync(srcpath, dstpath)
}

module.exports = {
  createLink: u(createLink),
  createLinkSync
}


/***/ }),
/* 35 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const path = __webpack_require__(18)
const fs = __webpack_require__(8)
const _mkdirs = __webpack_require__(19)
const mkdirs = _mkdirs.mkdirs
const mkdirsSync = _mkdirs.mkdirsSync

const _symlinkPaths = __webpack_require__(36)
const symlinkPaths = _symlinkPaths.symlinkPaths
const symlinkPathsSync = _symlinkPaths.symlinkPathsSync

const _symlinkType = __webpack_require__(37)
const symlinkType = _symlinkType.symlinkType
const symlinkTypeSync = _symlinkType.symlinkTypeSync

const pathExists = __webpack_require__(28).pathExists

function createSymlink (srcpath, dstpath, type, callback) {
  callback = (typeof type === 'function') ? type : callback
  type = (typeof type === 'function') ? false : type

  pathExists(dstpath, (err, destinationExists) => {
    if (err) return callback(err)
    if (destinationExists) return callback(null)
    symlinkPaths(srcpath, dstpath, (err, relative) => {
      if (err) return callback(err)
      srcpath = relative.toDst
      symlinkType(relative.toCwd, type, (err, type) => {
        if (err) return callback(err)
        const dir = path.dirname(dstpath)
        pathExists(dir, (err, dirExists) => {
          if (err) return callback(err)
          if (dirExists) return fs.symlink(srcpath, dstpath, type, callback)
          mkdirs(dir, err => {
            if (err) return callback(err)
            fs.symlink(srcpath, dstpath, type, callback)
          })
        })
      })
    })
  })
}

function createSymlinkSync (srcpath, dstpath, type) {
  const destinationExists = fs.existsSync(dstpath)
  if (destinationExists) return undefined

  const relative = symlinkPathsSync(srcpath, dstpath)
  srcpath = relative.toDst
  type = symlinkTypeSync(relative.toCwd, type)
  const dir = path.dirname(dstpath)
  const exists = fs.existsSync(dir)
  if (exists) return fs.symlinkSync(srcpath, dstpath, type)
  mkdirsSync(dir)
  return fs.symlinkSync(srcpath, dstpath, type)
}

module.exports = {
  createSymlink: u(createSymlink),
  createSymlinkSync
}


/***/ }),
/* 36 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const path = __webpack_require__(18)
const fs = __webpack_require__(8)
const pathExists = __webpack_require__(28).pathExists

/**
 * Function that returns two types of paths, one relative to symlink, and one
 * relative to the current working directory. Checks if path is absolute or
 * relative. If the path is relative, this function checks if the path is
 * relative to symlink or relative to current working directory. This is an
 * initiative to find a smarter `srcpath` to supply when building symlinks.
 * This allows you to determine which path to use out of one of three possible
 * types of source paths. The first is an absolute path. This is detected by
 * `path.isAbsolute()`. When an absolute path is provided, it is checked to
 * see if it exists. If it does it's used, if not an error is returned
 * (callback)/ thrown (sync). The other two options for `srcpath` are a
 * relative url. By default Node's `fs.symlink` works by creating a symlink
 * using `dstpath` and expects the `srcpath` to be relative to the newly
 * created symlink. If you provide a `srcpath` that does not exist on the file
 * system it results in a broken symlink. To minimize this, the function
 * checks to see if the 'relative to symlink' source file exists, and if it
 * does it will use it. If it does not, it checks if there's a file that
 * exists that is relative to the current working directory, if does its used.
 * This preserves the expectations of the original fs.symlink spec and adds
 * the ability to pass in `relative to current working direcotry` paths.
 */

function symlinkPaths (srcpath, dstpath, callback) {
  if (path.isAbsolute(srcpath)) {
    return fs.lstat(srcpath, (err) => {
      if (err) {
        err.message = err.message.replace('lstat', 'ensureSymlink')
        return callback(err)
      }
      return callback(null, {
        'toCwd': srcpath,
        'toDst': srcpath
      })
    })
  } else {
    const dstdir = path.dirname(dstpath)
    const relativeToDst = path.join(dstdir, srcpath)
    return pathExists(relativeToDst, (err, exists) => {
      if (err) return callback(err)
      if (exists) {
        return callback(null, {
          'toCwd': relativeToDst,
          'toDst': srcpath
        })
      } else {
        return fs.lstat(srcpath, (err) => {
          if (err) {
            err.message = err.message.replace('lstat', 'ensureSymlink')
            return callback(err)
          }
          return callback(null, {
            'toCwd': srcpath,
            'toDst': path.relative(dstdir, srcpath)
          })
        })
      }
    })
  }
}

function symlinkPathsSync (srcpath, dstpath) {
  let exists
  if (path.isAbsolute(srcpath)) {
    exists = fs.existsSync(srcpath)
    if (!exists) throw new Error('absolute srcpath does not exist')
    return {
      'toCwd': srcpath,
      'toDst': srcpath
    }
  } else {
    const dstdir = path.dirname(dstpath)
    const relativeToDst = path.join(dstdir, srcpath)
    exists = fs.existsSync(relativeToDst)
    if (exists) {
      return {
        'toCwd': relativeToDst,
        'toDst': srcpath
      }
    } else {
      exists = fs.existsSync(srcpath)
      if (!exists) throw new Error('relative srcpath does not exist')
      return {
        'toCwd': srcpath,
        'toDst': path.relative(dstdir, srcpath)
      }
    }
  }
}

module.exports = {
  symlinkPaths,
  symlinkPathsSync
}


/***/ }),
/* 37 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)

function symlinkType (srcpath, type, callback) {
  callback = (typeof type === 'function') ? type : callback
  type = (typeof type === 'function') ? false : type
  if (type) return callback(null, type)
  fs.lstat(srcpath, (err, stats) => {
    if (err) return callback(null, 'file')
    type = (stats && stats.isDirectory()) ? 'dir' : 'file'
    callback(null, type)
  })
}

function symlinkTypeSync (srcpath, type) {
  let stats

  if (type) return type
  try {
    stats = fs.lstatSync(srcpath)
  } catch (e) {
    return 'file'
  }
  return (stats && stats.isDirectory()) ? 'dir' : 'file'
}

module.exports = {
  symlinkType,
  symlinkTypeSync
}


/***/ }),
/* 38 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const jsonFile = __webpack_require__(39)

jsonFile.outputJson = u(__webpack_require__(41))
jsonFile.outputJsonSync = __webpack_require__(42)
// aliases
jsonFile.outputJSON = jsonFile.outputJson
jsonFile.outputJSONSync = jsonFile.outputJsonSync
jsonFile.writeJSON = jsonFile.writeJson
jsonFile.writeJSONSync = jsonFile.writeJsonSync
jsonFile.readJSON = jsonFile.readJson
jsonFile.readJSONSync = jsonFile.readJsonSync

module.exports = jsonFile


/***/ }),
/* 39 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const jsonFile = __webpack_require__(40)

module.exports = {
  // jsonfile exports
  readJson: u(jsonFile.readFile),
  readJsonSync: jsonFile.readFileSync,
  writeJson: u(jsonFile.writeFile),
  writeJsonSync: jsonFile.writeFileSync
}


/***/ }),
/* 40 */
/***/ (function(module, exports, __webpack_require__) {

var _fs
try {
  _fs = __webpack_require__(8)
} catch (_) {
  _fs = __webpack_require__(9)
}

function readFile (file, options, callback) {
  if (callback == null) {
    callback = options
    options = {}
  }

  if (typeof options === 'string') {
    options = {encoding: options}
  }

  options = options || {}
  var fs = options.fs || _fs

  var shouldThrow = true
  if ('throws' in options) {
    shouldThrow = options.throws
  }

  fs.readFile(file, options, function (err, data) {
    if (err) return callback(err)

    data = stripBom(data)

    var obj
    try {
      obj = JSON.parse(data, options ? options.reviver : null)
    } catch (err2) {
      if (shouldThrow) {
        err2.message = file + ': ' + err2.message
        return callback(err2)
      } else {
        return callback(null, null)
      }
    }

    callback(null, obj)
  })
}

function readFileSync (file, options) {
  options = options || {}
  if (typeof options === 'string') {
    options = {encoding: options}
  }

  var fs = options.fs || _fs

  var shouldThrow = true
  if ('throws' in options) {
    shouldThrow = options.throws
  }

  try {
    var content = fs.readFileSync(file, options)
    content = stripBom(content)
    return JSON.parse(content, options.reviver)
  } catch (err) {
    if (shouldThrow) {
      err.message = file + ': ' + err.message
      throw err
    } else {
      return null
    }
  }
}

function stringify (obj, options) {
  var spaces
  var EOL = '\n'
  if (typeof options === 'object' && options !== null) {
    if (options.spaces) {
      spaces = options.spaces
    }
    if (options.EOL) {
      EOL = options.EOL
    }
  }

  var str = JSON.stringify(obj, options ? options.replacer : null, spaces)

  return str.replace(/\n/g, EOL) + EOL
}

function writeFile (file, obj, options, callback) {
  if (callback == null) {
    callback = options
    options = {}
  }
  options = options || {}
  var fs = options.fs || _fs

  var str = ''
  try {
    str = stringify(obj, options)
  } catch (err) {
    // Need to return whether a callback was passed or not
    if (callback) callback(err, null)
    return
  }

  fs.writeFile(file, str, options, callback)
}

function writeFileSync (file, obj, options) {
  options = options || {}
  var fs = options.fs || _fs

  var str = stringify(obj, options)
  // not sure if fs.writeFileSync returns anything, but just in case
  return fs.writeFileSync(file, str, options)
}

function stripBom (content) {
  // we do this because JSON.parse would convert it to a utf8 string if encoding wasn't specified
  if (Buffer.isBuffer(content)) content = content.toString('utf8')
  content = content.replace(/^\uFEFF/, '')
  return content
}

var jsonfile = {
  readFile: readFile,
  readFileSync: readFileSync,
  writeFile: writeFile,
  writeFileSync: writeFileSync
}

module.exports = jsonfile


/***/ }),
/* 41 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const path = __webpack_require__(18)
const mkdir = __webpack_require__(19)
const pathExists = __webpack_require__(28).pathExists
const jsonFile = __webpack_require__(39)

function outputJson (file, data, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }

  const dir = path.dirname(file)

  pathExists(dir, (err, itDoes) => {
    if (err) return callback(err)
    if (itDoes) return jsonFile.writeJson(file, data, options, callback)

    mkdir.mkdirs(dir, err => {
      if (err) return callback(err)
      jsonFile.writeJson(file, data, options, callback)
    })
  })
}

module.exports = outputJson


/***/ }),
/* 42 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const mkdir = __webpack_require__(19)
const jsonFile = __webpack_require__(39)

function outputJsonSync (file, data, options) {
  const dir = path.dirname(file)

  if (!fs.existsSync(dir)) {
    mkdir.mkdirsSync(dir)
  }

  jsonFile.writeJsonSync(file, data, options)
}

module.exports = outputJsonSync


/***/ }),
/* 43 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const copySync = __webpack_require__(16).copySync
const removeSync = __webpack_require__(30).removeSync
const mkdirpSync = __webpack_require__(19).mkdirsSync
const buffer = __webpack_require__(25)

function moveSync (src, dest, options) {
  options = options || {}
  const overwrite = options.overwrite || options.clobber || false

  src = path.resolve(src)
  dest = path.resolve(dest)

  if (src === dest) return fs.accessSync(src)

  if (isSrcSubdir(src, dest)) throw new Error(`Cannot move '${src}' into itself '${dest}'.`)

  mkdirpSync(path.dirname(dest))
  tryRenameSync()

  function tryRenameSync () {
    if (overwrite) {
      try {
        return fs.renameSync(src, dest)
      } catch (err) {
        if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'EPERM') {
          removeSync(dest)
          options.overwrite = false // just overwriteed it, no need to do it again
          return moveSync(src, dest, options)
        }

        if (err.code !== 'EXDEV') throw err
        return moveSyncAcrossDevice(src, dest, overwrite)
      }
    } else {
      try {
        fs.linkSync(src, dest)
        return fs.unlinkSync(src)
      } catch (err) {
        if (err.code === 'EXDEV' || err.code === 'EISDIR' || err.code === 'EPERM' || err.code === 'ENOTSUP') {
          return moveSyncAcrossDevice(src, dest, overwrite)
        }
        throw err
      }
    }
  }
}

function moveSyncAcrossDevice (src, dest, overwrite) {
  const stat = fs.statSync(src)

  if (stat.isDirectory()) {
    return moveDirSyncAcrossDevice(src, dest, overwrite)
  } else {
    return moveFileSyncAcrossDevice(src, dest, overwrite)
  }
}

function moveFileSyncAcrossDevice (src, dest, overwrite) {
  const BUF_LENGTH = 64 * 1024
  const _buff = buffer(BUF_LENGTH)

  const flags = overwrite ? 'w' : 'wx'

  const fdr = fs.openSync(src, 'r')
  const stat = fs.fstatSync(fdr)
  const fdw = fs.openSync(dest, flags, stat.mode)
  let pos = 0

  while (pos < stat.size) {
    const bytesRead = fs.readSync(fdr, _buff, 0, BUF_LENGTH, pos)
    fs.writeSync(fdw, _buff, 0, bytesRead)
    pos += bytesRead
  }

  fs.closeSync(fdr)
  fs.closeSync(fdw)
  return fs.unlinkSync(src)
}

function moveDirSyncAcrossDevice (src, dest, overwrite) {
  const options = {
    overwrite: false
  }

  if (overwrite) {
    removeSync(dest)
    tryCopySync()
  } else {
    tryCopySync()
  }

  function tryCopySync () {
    copySync(src, dest, options)
    return removeSync(src)
  }
}

// return true if dest is a subdir of src, otherwise false.
// extract dest base dir and check if that is the same as src basename
function isSrcSubdir (src, dest) {
  try {
    return fs.statSync(src).isDirectory() &&
           src !== dest &&
           dest.indexOf(src) > -1 &&
           dest.split(path.dirname(src) + path.sep)[1].split(path.sep)[0] === path.basename(src)
  } catch (e) {
    return false
  }
}

module.exports = {
  moveSync
}


/***/ }),
/* 44 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const copy = __webpack_require__(26).copy
const remove = __webpack_require__(30).remove
const mkdirp = __webpack_require__(19).mkdirp
const pathExists = __webpack_require__(28).pathExists

function move (src, dest, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }

  const overwrite = opts.overwrite || opts.clobber || false

  src = path.resolve(src)
  dest = path.resolve(dest)

  if (src === dest) return fs.access(src, cb)

  fs.stat(src, (err, st) => {
    if (err) return cb(err)

    if (st.isDirectory() && isSrcSubdir(src, dest)) {
      return cb(new Error(`Cannot move '${src}' to a subdirectory of itself, '${dest}'.`))
    }
    mkdirp(path.dirname(dest), err => {
      if (err) return cb(err)
      return doRename(src, dest, overwrite, cb)
    })
  })
}

function doRename (src, dest, overwrite, cb) {
  if (overwrite) {
    return remove(dest, err => {
      if (err) return cb(err)
      return rename(src, dest, overwrite, cb)
    })
  }
  pathExists(dest, (err, destExists) => {
    if (err) return cb(err)
    if (destExists) return cb(new Error('dest already exists.'))
    return rename(src, dest, overwrite, cb)
  })
}

function rename (src, dest, overwrite, cb) {
  fs.rename(src, dest, err => {
    if (!err) return cb()
    if (err.code !== 'EXDEV') return cb(err)
    return moveAcrossDevice(src, dest, overwrite, cb)
  })
}

function moveAcrossDevice (src, dest, overwrite, cb) {
  const opts = {
    overwrite,
    errorOnExist: true
  }

  copy(src, dest, opts, err => {
    if (err) return cb(err)
    return remove(src, cb)
  })
}

function isSrcSubdir (src, dest) {
  const srcArray = src.split(path.sep)
  const destArray = dest.split(path.sep)

  return srcArray.reduce((acc, current, i) => {
    return acc && destArray[i] === current
  }, true)
}

module.exports = {
  move: u(move)
}


/***/ }),
/* 45 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";


const u = __webpack_require__(7).fromCallback
const fs = __webpack_require__(8)
const path = __webpack_require__(18)
const mkdir = __webpack_require__(19)
const pathExists = __webpack_require__(28).pathExists

function outputFile (file, data, encoding, callback) {
  if (typeof encoding === 'function') {
    callback = encoding
    encoding = 'utf8'
  }

  const dir = path.dirname(file)
  pathExists(dir, (err, itDoes) => {
    if (err) return callback(err)
    if (itDoes) return fs.writeFile(file, data, encoding, callback)

    mkdir.mkdirs(dir, err => {
      if (err) return callback(err)

      fs.writeFile(file, data, encoding, callback)
    })
  })
}

function outputFileSync (file, ...args) {
  const dir = path.dirname(file)
  if (fs.existsSync(dir)) {
    return fs.writeFileSync(file, ...args)
  }
  mkdir.mkdirsSync(dir)
  fs.writeFileSync(file, ...args)
}

module.exports = {
  outputFile: u(outputFile),
  outputFileSync
}


/***/ }),
/* 46 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const fs = __webpack_require__(5);
const vscode_1 = __webpack_require__(2);
exports.config = vscode_1.workspace.getConfiguration("r");
function getRpath() {
    if (process.platform === "win32") {
        return exports.config.get("rterm.windows");
    }
    else if (process.platform === "darwin") {
        return exports.config.get("rterm.mac");
    }
    else if (process.platform === "linux") {
        return exports.config.get("rterm.linux");
    }
    else {
        vscode_1.window.showErrorMessage(process.platform + " can't use R");
        return "";
    }
}
exports.getRpath = getRpath;
function ToRStringLiteral(s, quote) {
    if (s === null) {
        return "NULL";
    }
    return (quote +
        s.replace(/\\/g, "\\\\")
            .replace(/"""/g, "\\" + quote)
            .replace(/\\n/g, "\\n")
            .replace(/\\r/g, "\\r")
            .replace(/\\t/g, "\\t")
            .replace(/\\b/g, "\\b")
            .replace(/\\a/g, "\\a")
            .replace(/\\f/g, "\\f")
            .replace(/\\v/g, "\\v") +
        quote);
}
exports.ToRStringLiteral = ToRStringLiteral;
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
exports.delay = delay;
function checkForSpecialCharacters(text) {
    return !/[~`!#$%\^&*+=\-\[\]\\';,/{}|\\":<>\?\s]/g.test(text);
}
exports.checkForSpecialCharacters = checkForSpecialCharacters;
function checkIfFileExists(filePath) {
    return fs.existsSync(filePath);
}
exports.checkIfFileExists = checkIfFileExists;
function assertRTerminalCreation(rTerm) {
    if (!rTerm) {
        vscode_1.window.showErrorMessage("Could not create R terminal.");
        return false;
    }
    else {
        return true;
    }
}
exports.assertRTerminalCreation = assertRTerminalCreation;


/***/ }),
/* 47 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const fs = __webpack_require__(5);
const vscode_1 = __webpack_require__(2);
const rTerminal_1 = __webpack_require__(4);
const selection_1 = __webpack_require__(48);
const util_1 = __webpack_require__(46);
async function previewEnvironment() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    if (!checkcsv()) {
        return;
    }
    const tmpDir = makeTmpDir();
    const pathToTmpCsv = tmpDir + "/environment.csv";
    const envName = "name=ls()";
    const envClass = "class=sapply(ls(), function(x) {class(get(x))})";
    const envOut = "out=sapply(ls(), function(x) {capture.output(str(get(x)), silent = T)[1]})";
    const rWriteCsvCommand = "write.csv(data.frame("
        + envName + ","
        + envClass + ","
        + envOut + "), '"
        + pathToTmpCsv + "', row.names=FALSE, quote = TRUE)";
    rTerminal_1.rTerm.sendText(rWriteCsvCommand);
    await openTmpCSV(pathToTmpCsv, tmpDir);
}
exports.previewEnvironment = previewEnvironment;
async function previewDataframe() {
    if (!rTerminal_1.rTerm) {
        const success = rTerminal_1.createRTerm(true);
        if (!success) {
            return;
        }
    }
    if (!checkcsv()) {
        return;
    }
    const selectedTextArray = selection_1.getSelection().selectedTextArray;
    const dataframeName = selectedTextArray[0];
    if (selectedTextArray.length !== 1 || !util_1.checkForSpecialCharacters(dataframeName)) {
        vscode_1.window.showInformationMessage("This does not appear to be a dataframe.");
        return false;
    }
    const tmpDir = makeTmpDir();
    // Create R write CSV command.  Turn off row names and quotes, they mess with Excel Viewer.
    const pathToTmpCsv = tmpDir + "/" + dataframeName + ".csv";
    const rWriteCsvCommand = "write.csv(" + dataframeName + ", '"
        + pathToTmpCsv
        + "', row.names = FALSE, quote = FALSE)";
    rTerminal_1.rTerm.sendText(rWriteCsvCommand);
    await openTmpCSV(pathToTmpCsv, tmpDir);
}
exports.previewDataframe = previewDataframe;
async function openTmpCSV(pathToTmpCsv, tmpDir) {
    await util_1.delay(350); // Needed since file size has not yet changed
    if (!util_1.checkIfFileExists(pathToTmpCsv)) {
        vscode_1.window.showErrorMessage("Dataframe failed to display.");
        fs.removeSync(tmpDir);
        return false;
    }
    // Async poll for R to complete writing CSV.
    const success = await waitForFileToFinish(pathToTmpCsv);
    if (!success) {
        vscode_1.window.showWarningMessage("Visual Studio Code currently limits opening files to 20 MB.");
        fs.removeSync(tmpDir);
        return false;
    }
    if (process.platform === "win32") {
        const winattr = __webpack_require__(50);
        winattr.setSync(tmpDir, { hidden: true });
    }
    // Open CSV in Excel Viewer and clean up.
    vscode_1.workspace.openTextDocument(pathToTmpCsv).then(async (file) => {
        await vscode_1.commands.executeCommand("csv.preview", file.uri);
        fs.removeSync(tmpDir);
    });
}
async function waitForFileToFinish(filePath) {
    const fileBusy = true;
    let currentSize = 0;
    let previousSize = 1;
    while (fileBusy) {
        const stats = fs.statSync(filePath);
        currentSize = stats.size;
        // UPDATE: We are now limited to 20 mb by MODEL_TOKENIZATION_LIMIT
        // https://github.com/Microsoft/vscode/blob/master/src/vs/editor/common/model/textModel.ts#L34
        if (currentSize > 2 * 10000000) { // 20 MB
            return false;
        }
        if (currentSize === previousSize) {
            return true;
        }
        else {
            previousSize = currentSize;
        }
        await util_1.delay(50);
    }
}
function makeTmpDir() {
    let tmpDir = vscode_1.workspace.rootPath;
    if (process.platform === "win32") {
        tmpDir = tmpDir.replace(/\\/g, "/");
        tmpDir += "/tmp";
    }
    else {
        tmpDir += "/.tmp";
    }
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir);
    }
    return tmpDir;
}
function checkcsv() {
    const iscsv = vscode_1.extensions.getExtension("GrapeCity.gc-excelviewer");
    if (iscsv.isActive) {
        return true;
    }
    else {
        vscode_1.window.showInformationMessage("This function need to install `GrapeCity.gc-excelviewer`");
        return false;
    }
}


/***/ }),
/* 48 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = __webpack_require__(2);
const lineCache_1 = __webpack_require__(49);
function getSelection() {
    const selection = { linesDownToMoveCursor: 0, selectedTextArray: [] };
    const { start, end } = vscode_1.window.activeTextEditor.selection;
    const currentDocument = vscode_1.window.activeTextEditor.document;
    const range = new vscode_1.Range(start, end);
    let selectedLine = currentDocument.getText(range);
    if (!selectedLine) {
        const { startLine, endLine } = extendSelection(start.line, (x) => currentDocument.lineAt(x).text, currentDocument.lineCount);
        const charactersOnLine = vscode_1.window.activeTextEditor.document.lineAt(endLine).text.length;
        const newStart = new vscode_1.Position(startLine, 0);
        const newEnd = new vscode_1.Position(endLine, charactersOnLine);
        selection.linesDownToMoveCursor = 1 + endLine - start.line;
        selectedLine = currentDocument.getText(new vscode_1.Range(newStart, newEnd));
    }
    else if (start.line === end.line) {
        selection.linesDownToMoveCursor = 0;
        selection.selectedTextArray = [currentDocument.getText(new vscode_1.Range(start, end))];
        return selection;
    }
    else {
        selectedLine = currentDocument.getText(new vscode_1.Range(start, end));
    }
    const selectedTextArray = selectedLine.split("\n");
    selection.selectedTextArray = removeCommentedLines(selectedTextArray);
    return selection;
}
exports.getSelection = getSelection;
function removeCommentedLines(selection) {
    const selectionWithoutComments = [];
    selection.forEach((line) => {
        if (!checkForComment(line)) {
            selectionWithoutComments.push(line);
        }
    });
    return selectionWithoutComments;
}
function checkForComment(line) {
    let index = 0;
    while (index < line.length) {
        if (!(line[index] === " ")) {
            break;
        }
        index++;
    }
    return line[index] === "#";
}
exports.checkForComment = checkForComment;
/**
 * Like vscode's Position class, but allows negative values.
 */
class PositionNeg {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}
function doBracketsMatch(a, b) {
    const matches = { "(": ")", "[": "]", "{": "}", ")": "(", "]": "[", "}": "{" };
    return matches[a] === b;
}
function isBracket(c, lookingForward) {
    if (lookingForward) {
        return ((c === "(") || (c === "[") || (c === "{"));
    }
    else {
        return ((c === ")") || (c === "]") || (c === "}"));
    }
}
/**
 * From a given position, return the 'next' character, its position in the document,
 * whether it is start/end of a code line (possibly broken over multiple text lines), and whether it is the
 * start/end of the file. Considers the start and end of each line to be special distinct characters.
 * @param p The starting position.
 * @param lookingForward true if the 'next' character is toward the end of the document, false if toward the start.
 * @param getLine A function that returns the string at the given line of the document.
 * @param getEndsInOperator A function that returns whether the given line ends in an operator.
 * @param lineCount The number of lines in the document.
 */
function getNextChar(p, lookingForward, getLine, getEndsInOperator, lineCount) {
    const s = getLine(p.line);
    let nextPos = null;
    let isEndOfCodeLine = false;
    let isEndOfFile = false;
    if (lookingForward) {
        if (p.character !== s.length) {
            nextPos = new PositionNeg(p.line, p.character + 1);
        }
        else if (p.line < (lineCount - 1)) {
            nextPos = new PositionNeg(p.line + 1, -1);
        }
        else {
            // At end of document. Return same character.
            isEndOfFile = true;
            nextPos = new PositionNeg(p.line, p.character);
        }
        const nextLine = getLine(nextPos.line);
        if (nextPos.character === nextLine.length) {
            if ((nextPos.line === (lineCount - 1)) || !getEndsInOperator(nextPos.line)) {
                isEndOfCodeLine = true;
            }
        }
    }
    else {
        if (p.character !== -1) {
            nextPos = new PositionNeg(p.line, p.character - 1);
        }
        else if (p.line > 0) {
            nextPos = new PositionNeg(p.line - 1, getLine(p.line - 1).length - 1);
        }
        else {
            // At start of document. Return same character.
            isEndOfFile = true;
            nextPos = new PositionNeg(p.line, p.character);
        }
        if (nextPos.character === -1) {
            if ((nextPos.line <= 0) || !getEndsInOperator(nextPos.line - 1)) {
                isEndOfCodeLine = true;
            }
        }
    }
    const nextChar = getLine(nextPos.line)[nextPos.character];
    return ({ nextChar, nextPos, isEndOfCodeLine, isEndOfFile });
}
/**
 * Given a line number, gets the text of that line and determines the first and last lines of the
 * file required to make a complete line of code, by matching brackets and extending over
 * broken lines (single lines of code split into multiple text lines, joined by operators).
 *
 * The algorithm:
 * From the start of the given line, proceed forward looking for the end of the code line.
 * If a bracket is encountered, look for the match of that bracket (possibly changing direction to do so),
 * from the farthest point reached in that direction.
 * Once the bracket is found, proceed in the same direction looking for the completion of the code line.
 * Once the end of the code line has been matched, proceed in the other direction.
 * Repeat until all encountered brackets are matched, and the completions of the code lines have been reached in
 * both directions. The lines of the completions are the lines returned.
 *
 * Example:
 * Let's say we have the following R code file:
 *
 *     library(magrittr) # For %>%    Line 1
 *     list(x = 1,       #            Line 2
 *          y = 2) %>%   #            Line 3
 *         print()       #            Line 4
 *
 * Let's say the cursor is on Line 3. We proceed forward until we hit the ')'. We look for the match, which
 * means looking backwards from the end of Line 2. We find the match, '(', on Line 2. We continue along
 * Line 2 until we reach the start of the line. The previous line, Line 1, does not end in an operator,
 * so we have reached the completion of the code line. Now, we proceed forward again from the farthest point reached
 * in the other direction: the ')' on Line 3. We encounter the end of the TEXT line, but it ends in an operator '%>%',
 * so it is not the end of the CODE line. Therefore, we continue onto Line 4. We encounter a '(' on Line 4, and continue
 * forward to find its match, which is the next character. Then we're at the end of Line 4, which doesn't
 * end in an operator. Now we've found the completions in both directions, so we're finished. The farthest lines
 * reached were Line 2 and Line 4, so those are the values returned.
 * @param line The line of the document at which to start.
 * @param getLine A function that returns the string at the given line of the document.
 * @param lineCount The number of lines in the document.
 */
function extendSelection(line, getLine, lineCount) {
    const lc = new lineCache_1.LineCache(getLine, lineCount);
    const getLineFromCache = (x) => lc.getLineFromCache(x);
    const getEndsInOperatorFromCache = (x) => lc.getEndsInOperatorFromCache(x);
    let lookingForward = true;
    // poss[1] is the farthest point reached looking forward from line,
    // and poss[0] is the farthest point reached looking backward from line.
    const poss = { 0: new PositionNeg(line, 0), 1: new PositionNeg(line, -1) };
    const flagsFinish = { 0: false, 1: false }; // 1 represents looking forward, 0 represents looking back.
    let flagAbort = false;
    const unmatched = { 0: [], 1: [] };
    while (!flagAbort && !(flagsFinish[0] && flagsFinish[1])) {
        const { nextChar, nextPos, isEndOfCodeLine, isEndOfFile } = getNextChar(poss[lookingForward ? 1 : 0], lookingForward, getLineFromCache, getEndsInOperatorFromCache, lineCount);
        poss[lookingForward ? 1 : 0] = nextPos;
        if (isBracket(nextChar, lookingForward)) {
            unmatched[lookingForward ? 1 : 0].push(nextChar);
        }
        else if (isBracket(nextChar, !lookingForward)) {
            if (unmatched[lookingForward ? 1 : 0].length === 0) {
                lookingForward = !lookingForward;
                unmatched[lookingForward ? 1 : 0].push(nextChar);
                flagsFinish[lookingForward ? 1 : 0] = false;
            }
            else {
                const needsToMatch = unmatched[lookingForward ? 1 : 0].pop();
                if (!doBracketsMatch(nextChar, needsToMatch)) {
                    flagAbort = true;
                }
            }
        }
        else if (isEndOfCodeLine) {
            if (unmatched[lookingForward ? 1 : 0].length === 0) {
                // We have found everything we need to in this direction. Continue looking in the other direction.
                flagsFinish[lookingForward ? 1 : 0] = true;
                lookingForward = !lookingForward;
            }
            else if (isEndOfFile) {
                // Have hit the start or end of the file without finding the matching bracket.
                flagAbort = true;
            }
        }
    }
    if (flagAbort) {
        return ({ startLine: line, endLine: line });
    }
    else {
        return ({ startLine: poss[0].line, endLine: poss[1].line });
    }
}
exports.extendSelection = extendSelection;


/***/ }),
/* 49 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Class to hold lines that have been fetched from the document after they have been preprocessed.
 */
class LineCache {
    constructor(getLine, lineCount) {
        this.getLine = getLine;
        this.lineCount = lineCount;
        this.lineCache = new Map();
        this.endsInOperatorCache = new Map();
    }
    getLineFromCache(line) {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.lineCache.get(line);
        return (s);
    }
    getEndsInOperatorFromCache(line) {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.endsInOperatorCache.get(line);
        return (s);
    }
    addLineToCache(line) {
        const cleaned = cleanLine(this.getLine(line));
        const endsInOperator = doesLineEndInOperator(cleaned);
        this.lineCache.set(line, cleaned);
        this.endsInOperatorCache.set(line, endsInOperator);
    }
}
exports.LineCache = LineCache;
function cleanLine(text) {
    const cleaned = text.replace(/\s*\#.*/, ""); // Remove comments and preceeding spaces
    return (cleaned);
}
function doesLineEndInOperator(text) {
    const endingOperatorIndex = text.search(/(,|\+|!|\$|\^|&|\*|-|=|:|\'|~|\||\/|\?|%.*%)(\s*|\s*\#.*)$/);
    const spacesOnlyIndex = text.search(/^\s*$/); // Space-only lines also counted.
    return ((0 <= endingOperatorIndex) || (0 <= spacesOnlyIndex));
}


/***/ }),
/* 50 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const checkWindows = __webpack_require__(51);
const resolvePath = __webpack_require__(18).resolve;
const whichLib = __webpack_require__(52);



function get(path, callback)
{
	if (checkWindows.async(callback) === true)
	{
		return whichLib.run( function()
		{
			return whichLib.current().get( resolvePath(path), callback );
		});
	}
}



function getSync(path)
{
	if (checkWindows.sync() === true)
	{
		return whichLib.run( function()
		{
			return whichLib.current().getSync( resolvePath(path) );
		});
	}
}



function set(path, attrs, callback)
{
	if (checkWindows.async(callback) === true)
	{
		return whichLib.run( function()
		{
			return whichLib.current().set( resolvePath(path), attrs, callback );
		});
	}
}



function setSync(path, attrs)
{
	if (checkWindows.sync() === true)
	{
		return whichLib.run( function()
		{
			return whichLib.current().setSync( resolvePath(path), attrs );
		});
	}
}



whichLib.change("auto");



module.exports =
{
	get:     get,
	getSync: getSync,
	set:     set,
	setSync: setSync,
	
	// Undocumented -- used for testing
	change: whichLib.change
};


/***/ }),
/* 51 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const errorMessage = "Not a Windows platform";
const isWindows = process.platform.indexOf("win") === 0;



function async(callback)
{
	if (isWindows === false)
	{
		if (typeof callback === "function")
		{
			callback( new Error(errorMessage) );
		}
	}
	
	return isWindows;
}



function sync()
{
	if (isWindows === false)
	{
		throw new Error(errorMessage);
	}
	
	return isWindows;
}



module.exports = 
{
	async: async,
	sync:  sync
};


/***/ }),
/* 52 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const checkWindows = __webpack_require__(51);

const lib = {
	mode: null,
	binding: null,
	shell: null
};



function change(mode, strict)
{
	if (checkWindows.async()===false) return;
	
	switch (mode)
	{
		case "auto":
		case "binding":
		{
			if (lib.binding === null)
			{
				try
				{
					lib.binding = __webpack_require__(53);
					lib.mode = "binding";
				}
				catch (error)
				{
					if (strict !== true)
					{
						lib.binding = null;
						change("shell");
					}
					else
					{
						// For tests to know which installations could not load the binding
						throw error;
					}
				}
			}
			else
			{
				lib.mode = "binding";
			}
			
			break;
		}
		case "shell":
		{
			if (lib.shell===null) lib.shell = __webpack_require__(81);
			
			lib.mode = "shell";
			break;
		}
	}
}



function current()
{
	return lib[lib.mode];
}



function run(callback)
{
	var result;
	
	try
	{
		result = callback();
	}
	catch (error)
	{
		// If binding error
		if (lib.mode==="binding" && error.message==="The specified procedure could not be found.")
		{
			change("shell");
			result = callback();
		}
		// If other error
		else
		{
			throw error;
		}
	}
	
	return result;
}



module.exports = 
{
	change: change,
	current: current,
	run: run
};


/***/ }),
/* 53 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const fswin = __webpack_require__(54);

const convertAttrs = __webpack_require__(80);



function get(path, callback)
{
	fswin.getAttributes(path, function(result)
	{
		if (result === undefined)
		{
			// fswin does not return an error -- problem could be ENOENT,EPERM,etc
			callback( new Error("unknown error") );
			return;
		}
		
		let attrs = {};
		
		for (let i in result)
		{
			if (i.indexOf("IS_") === 0)
			{
				attrs[i] = result[i];
			}
		}
		
		callback( null, convertAttrs.from(attrs) );
	});
}



function getSync(path)
{
	const result = fswin.getAttributesSync(path);
	
	if (result === undefined)
	{
		// fswin does not return an error -- problem could be ENOENT,EPERM,etc
		throw new Error("unknown erorr");
	}
	
	return convertAttrs.from(result);
}



function set(path, attrs, callback)
{
	fswin.setAttributes(path, convertAttrs.to(attrs), function(success)
	{
		// fswin does not return an error -- problem could be ENOENT,EPERM,etc
		callback( success===true ? null : new Error("unknown error") );
	});
}



function setSync(path, attrs)
{
	const success = fswin.setAttributesSync( path, convertAttrs.to(attrs) );
	
	if (success === false)
	{
		// fswin does not return an error -- problem could be ENOENT,EPERM,etc
		throw new Error("unknown erorr");
	}
}



module.exports =
{
	get:     get,
	getSync: getSync,
	set:     set,
	setSync: setSync
};


/***/ }),
/* 54 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var v, isElectron = process.versions && process.versions.electron;
if (process.platform === 'win32') {
    v = (isElectron ? process.versions.electron : process.version).match(/(\d+\.)(\d+)\./);
    if (isElectron || v[1] === '0.') {
		v[2] = parseInt(v[2]);
		if (!isElectron && v[2] % 2) {
			v[2]++;
		}
	} else {
		v[2] = 'x';
	}
	module.exports = __webpack_require__(55)((isElectron ? './electron/' : './node/') + v[1] + v[2] + '.x' + '/' + process.arch + "/fswin.node");
} else {
	throw 'this module only works on windows';
}

/***/ }),
/* 55 */
/***/ (function(module, exports, __webpack_require__) {

var map = {
	"./electron/1.3.x/ia32/fswin.node": 56,
	"./electron/1.3.x/x64/fswin.node": 57,
	"./electron/1.4.x/ia32/fswin.node": 58,
	"./electron/1.4.x/x64/fswin.node": 59,
	"./electron/1.6.x/ia32/fswin.node": 60,
	"./electron/1.6.x/x64/fswin.node": 61,
	"./node/0.10.x/ia32/fswin.node": 62,
	"./node/0.10.x/x64/fswin.node": 63,
	"./node/0.12.x/ia32/fswin.node": 64,
	"./node/0.12.x/x64/fswin.node": 65,
	"./node/0.6.x/ia32/fswin.node": 66,
	"./node/0.6.x/x64/fswin.node": 67,
	"./node/0.8.x/ia32/fswin.node": 68,
	"./node/0.8.x/x64/fswin.node": 69,
	"./node/4.x.x/ia32/fswin.node": 70,
	"./node/4.x.x/x64/fswin.node": 71,
	"./node/5.x.x/ia32/fswin.node": 72,
	"./node/5.x.x/x64/fswin.node": 73,
	"./node/6.x.x/ia32/fswin.node": 74,
	"./node/6.x.x/x64/fswin.node": 75,
	"./node/7.x.x/ia32/fswin.node": 76,
	"./node/7.x.x/x64/fswin.node": 77,
	"./node/8.x.x/ia32/fswin.node": 78,
	"./node/8.x.x/x64/fswin.node": 79
};


function webpackContext(req) {
	var id = webpackContextResolve(req);
	return __webpack_require__(id);
}
function webpackContextResolve(req) {
	if(!__webpack_require__.o(map, req)) {
		var e = new Error("Cannot find module '" + req + "'");
		e.code = 'MODULE_NOT_FOUND';
		throw e;
	}
	return map[req];
}
webpackContext.keys = function webpackContextKeys() {
	return Object.keys(map);
};
webpackContext.resolve = webpackContextResolve;
module.exports = webpackContext;
webpackContext.id = 55;

/***/ }),
/* 56 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 57 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 58 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 59 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 60 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 61 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 62 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 63 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 64 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 65 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 66 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 67 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 68 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 69 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 70 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 71 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 72 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 73 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 74 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 75 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 76 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 77 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 78 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 79 */
/***/ (function(module, exports) {

throw new Error("Module parse failed: Unexpected character '�' (1:2)\nYou may need an appropriate loader to handle this file type.\n(Source code omitted for this binary file)");

/***/ }),
/* 80 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

const defs =
{
	archive:  "IS_ARCHIVED",
	hidden:   "IS_HIDDEN",
	readonly: "IS_READ_ONLY",
	system:   "IS_SYSTEM"
};



function convert(attrs, from)
{
	const output = {};
	
	eachAttribute(attrs, function(attrValue, attrName)
	{
		eachDefinition( function(defValue, defName)
		{
			if (from === true)
			{
				if (defValue === attrName)
				{
					output[defName] = attrValue;
					return false;
				}
			}
			// to
			else
			{
				if (defName === attrName)
				{
					output[defValue] = attrValue;
					return false;
				}
			}
		});
	});
	
	return output;
}



function convertFrom(attrs)
{
	return convert(attrs, true);
}



function convertTo(attrs)
{
	return convert(attrs, false);
}



function eachAttribute(attrs, callback)
{
	for (let i in attrs)
	{
		if (attrs.hasOwnProperty(i) === true)
		{
			let stop = callback( attrs[i], i, attrs );
			
			if (stop===false) break;
		}
	}
}



function eachDefinition(callback)
{
	for (let i in defs)
	{
		if (defs.hasOwnProperty(i) === true)
		{
			let stop = callback( defs[i], i, defs );
			
			if (stop===false) break;
		}
	}
}



module.exports =
{
	from: convertFrom,
	to:   convertTo
};


/***/ }),
/* 81 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";
/* WEBPACK VAR INJECTION */(function(__dirname) {
const child_process = __webpack_require__(82);

// For attrib command
const params =
{
	archive:  "a",
	hidden:   "h",
	readonly: "r",
	system:   "s"
};



function get_args(path)
{
	return [
		__dirname+"/hostscript.js",
		path,
		"//nologo",
		"//E:jscript"
	];
}



function get_parseResult(result)
{
	var json;
	var error = null;
	
	result.stdout = result.stdout.trim();
	
	if (result.stdout.length <= 0)
	{
		error = new Error("unknown error");
	}
	else
	{
		json = JSON.parse(result.stdout);
		
		if (json.error !== undefined)
		{
			error = new Error(json.error);
			json = undefined;
		}
	}
	
	return { error:error, attrs:json };
}



function set_args(path, attrs)
{
	const args = [];
	
	for (let i in attrs)
	{
		if (attrs.hasOwnProperty(i)===true && params.hasOwnProperty(i)===true)
		{
			args.push( (attrs[i]===true ? "+" : "-") + params[i] );
		}
	}
	
	args.push(path);
	
	return args;
}



function set_parseResult(result)
{
	// `result.stdout` is empty when successful
	if (result.stdout.length <= 0)
	{
		return null;
	}
	else
	{
		return new Error(result.stdout);
	}
}



function shell(command, args, callback)
{
	var instance = child_process.spawn(command, args);
	
	var stderr = "";
	var stdout = "";
	
	instance.stderr.on("data", function(data)
	{
		stderr += data.toString();
	});
	
	instance.stdout.on("data", function(data)
	{
		stdout += data.toString();
	});
	
	instance.on("exit", function(status)
	{
		this.removeAllListeners();
		
		// Pass an Object so that it's similar to spawnSync()
		callback({ status:status, stdout:stdout, stderr:stderr });
	});
}



function shellSync(command, args)
{
	var result = child_process.spawnSync(command, args, {encoding:"utf8"});
	
	// Consistent with shell()
	if (result.stderr===null) result.stderr = "";
	if (result.stdout===null) result.stdout = "";
	
	return result;
}



//::: PUBLIC FUNCTIONS



function get(path, callback)
{
	shell("cscript", get_args(path), function(result)
	{
		result = get_parseResult(result);
		
		callback(result.error, result.attrs);
	});
}



function getSync(path)
{
	var result = shellSync( "cscript", get_args(path) );
	result = get_parseResult(result);
	
	if (result.error !== null)
	{
		throw result.error;
	}
	
	return result.attrs;
}



function set(path, attrs, callback)
{
	shell("attrib", set_args(path,attrs), function(result)
	{
		callback( set_parseResult(result) );
	});
}



function setSync(path, attrs, callback)
{
	var result = shellSync( "attrib", set_args(path,attrs) );
	result = set_parseResult(result);
	
	if (result !== null)
	{
		throw result;
	}
}



module.exports = 
{
	get:     get,
	getSync: getSync,
	set:     set,
	setSync: setSync
};

/* WEBPACK VAR INJECTION */}.call(this, "/"))

/***/ }),
/* 82 */
/***/ (function(module, exports) {

module.exports = require("child_process");

/***/ }),
/* 83 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const fs = __webpack_require__(5);
const path = __webpack_require__(18);
const vscode_1 = __webpack_require__(2);
const ignorePath = path.join(vscode_1.workspace.rootPath, ".gitignore");
// From "https://github.com/github/gitignore/raw/master/R.gitignore"
const ignoreFiles = [".Rhistory",
    ".Rapp.history",
    ".RData",
    "*-Ex.R",
    "/*.tar.gz",
    "/*.Rcheck/",
    ".Rproj.user/",
    "vignettes/*.html",
    "vignettes/*.pdf",
    ".httr-oauth",
    "/*_cache/",
    "/cache/",
    "*.utf8.md",
    "*.knit.md",
    "rsconnect/"].join("\n");
function createGitignore() {
    if (!vscode_1.workspace.rootPath) {
        vscode_1.window.showWarningMessage("Please open workspace to create .gitignore");
        return;
    }
    fs.writeFile(ignorePath, ignoreFiles, (err) => {
        try {
            if (err) {
                vscode_1.window.showErrorMessage(err.name);
            }
        }
        catch (e) {
            vscode_1.window.showErrorMessage(e.message);
        }
    });
}
exports.createGitignore = createGitignore;


/***/ })
/******/ ]);
//# sourceMappingURL=extension.js.map