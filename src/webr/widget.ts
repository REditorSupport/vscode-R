import { maxHtmlBytes, maxHtmlFiles } from '../interactive/htmlBundle';

// Evaluated inside the webR worker. Reading through its own FS while R is
// paused preserves the channel position without queueing an RPC behind R or
// a nested readline(). FS.readFile returns private buffers we can transfer.
const installWidgetTransport = String.raw`(() => {
    const runtime = globalThis.Module;
    const fs = runtime.FS;
    let cell, bytes = 0, count = 0;
    runtime.vscodeRWidget = (directory, id) => {
        try {
            if (cell !== id) { cell = id; bytes = 0; count = 0; }
            const root = fs.lookupPath(directory, {follow: false, follow_mount: false}).node;
            if (root.mounted || !fs.isDir(root.mode) || root.mount.type !== fs.filesystems.MEMFS ||
                fs.getPath(root) !== directory) throw Error('Invalid widget directory');
            const entries = [];
            const dirs = [[root, '']];
            let size = 0, visited = 0;
            while (dirs.length) {
                const [dir, prefix] = dirs.pop();
                for (const [name, node] of Object.entries(dir.contents)) {
                    if (++visited > ${2 * maxHtmlFiles}) throw Error('HTML widget has too many entries');
                    if (name === '.' || name === '..' || name.includes('/')) throw Error('Invalid widget file name');
                    if (node.mounted || node.mount !== root.mount) throw Error('HTML widgets cannot include mounts');
                    const path = prefix + name;
                    if (fs.isDir(node.mode)) {
                        dirs.push([node, path + '/']);
                    } else if (fs.isFile(node.mode)) {
                        size += fs.lstat(directory + '/' + path).size;
                        entries.push(path);
                        if (!Number.isSafeInteger(size) || bytes + size > ${maxHtmlBytes} ||
                            count + entries.length > ${maxHtmlFiles}) {
                            throw Error('HTML widgets exceed the 64 MiB / 5000 file limit for this cell');
                        }
                    } else throw Error('HTML widgets cannot include symlinks or special files');
                }
            }
            if (!entries.includes('index.html')) throw Error('HTML widget has no index.html');
            const files = Object.create(null);
            const transfer = [];
            for (const path of entries) {
                files[path] = fs.readFile(directory + '/' + path);
                transfer.push(files[path].buffer);
            }
            runtime.webr.channel.write({type: 'vscode-r-widget', data: {id, files}}, transfer);
            bytes += size;
            count += entries.length;
            return "";
        } catch (error) {
            return error.message || String(error);
        }
    };
    return null;
})()`;

/** Included in the private R console environment. Errors return through the usual R cell outcome. */
export const widgetRunner = String.raw`
    webr::eval_js(${JSON.stringify(installWidgetTransport)})
    send_widget <- function(directory, id) {
        error <- webr::eval_js(paste0("globalThis.Module.vscodeRWidget(",
            jsonlite::toJSON(directory, auto_unbox = TRUE), ",", sprintf("%.0f", id), ")"))
        if (nzchar(error)) stop(error, call. = FALSE)
        invisible(TRUE)
    }
    display_widget <- function(value, directory, id) {
        if (!inherits(value, "htmlwidget")) return(FALSE)
        stage <- tempfile("widget-", tmpdir = directory)
        if (!dir.create(stage)) stop("Could not create the HTML widget directory")
        on.exit(unlink(stage, recursive = TRUE))
        htmlwidgets::saveWidget(value, file.path(stage, "index.html"), selfcontained = FALSE)
        send_widget(stage, id)
    }
`;
