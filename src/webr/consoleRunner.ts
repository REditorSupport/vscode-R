// The console host reads the typed outcome and all subsequent output through the
// next top-level prompt. R can print deferred warnings after the outcome.
export const consoleRunner = String.raw`
base::local({
    # Emscripten emits complete tty lines. Preserve an unterminated fragment
    # before another channel writes or R asks for input. File sinks have their
    # own streams and retain the regular R connection semantics.
    webr::eval_js("(() => {
        const runtime = globalThis.Module;
        const streams = [runtime.FS.getStream(1), runtime.FS.getStream(2)];
        const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
        const flush = (index) => {
            const bytes = streams[index].tty?.output;
            if (!bytes?.length) return;
            const text = decoder.decode(Uint8Array.from(bytes));
            bytes.length = 0;
            runtime.webr.channel.write({ type: 'vscode-r-stream-fragment',
                data: { channel: index === 0 ? 'stdout' : 'stderr', text } });
        };
        for (const [index, stream] of streams.entries()) {
            const ops = stream.stream_ops;
            stream.stream_ops = { ...ops, write(...args) {
                flush(1 - index);
                return ops.write(...args);
            } };
        }
        const setPrompt = runtime.webr.setPrompt;
        runtime.webr.setPrompt = (prompt) => {
            flush(0);
            flush(1);
            return setPrompt(prompt);
        };
        return null;
    })()")

    default_device <- getOption("device")
    notify <- function(id, state) {
        webr::eval_js(sprintf(
            "(globalThis.Module.webr.channel.write({type:'vscode-r-execution',data:{id:%.0f,state:'%s'}}),null)",
            id, state
        ))
        invisible(NULL)
    }

    execute <- function(directory, id) suspendInterrupts({
        cancel <- file.path(directory, "cancel")
        devices <- character()
        sequence <- 0L
        capture_device <- function(width = 8, height = 6, pointsize = 12, bg = "white") {
            sequence <<- sequence + 1L
            filename <- file.path(directory, sprintf("plot-%06d-%%06d.png", sequence))
            grDevices::png(filename, width = width, height = height, units = "in",
                res = 96, pointsize = pointsize, bg = bg)
            devices[as.character(as.integer(grDevices::dev.cur()))] <<- filename
        }
        close_devices <- function() {
            if (identical(getOption("device"), capture_device)) options(device = default_device)
            for (number in names(devices)) {
                slot <- as.integer(number)
                # A user can close a capture device and reuse its number for
                # their own file. The graphics engine records each PNG's path.
                if (length(.Devices) >= slot &&
                        identical(attr(.Devices[[slot]], "filepath", exact = TRUE), devices[[number]])) {
                    grDevices::dev.off(slot)
                }
            }
        }
        run <- function() {
            if (file.exists(cancel)) return("interrupted")
            if (identical(getOption("device"), default_device)) options(device = capture_device)
            expressions <- parse(file = file.path(directory, "cell.R"),
                keep.source = TRUE, encoding = "UTF-8")
            for (expression in expressions) {
                value <- withVisible(eval(expression, envir = .GlobalEnv))
                if (file.exists(cancel)) {
                    # Returning an empty console input releases a blocked
                    # readline(). Give R a chance to consume its interrupt.
                    Sys.sleep(0)
                    return("interrupted")
                }
                if (value$visible) print(value$value)
            }
            "success"
        }
        failed <- function(error) {
            message("Error: ", conditionMessage(error))
            "error"
        }
        state <- tryCatch({
            notify(id, "started")
            allowInterrupts(run())
        }, interrupt = function(e) "interrupted", error = failed)
        tryCatch(close_devices(), error = function(e) { state <<- failed(e) })
        notify(id, state)
    })
    # webR can leave the worker alive after R exits its main loop. Notify the
    # owner when q() runs so it can settle the submission and release the worker.
    reg.finalizer(.GlobalEnv, function(e) {
        webr::eval_js("(globalThis.Module.webr.channel.write({type:'vscode-r-exit'}),null)")
    }, onexit = TRUE)
    options(vscodeR.webR.execute = execute)
}, envir = base::new.env(parent = base::baseenv()))
`;
