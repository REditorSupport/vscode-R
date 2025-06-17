dir_init <- getwd()


# cleanup previous version
removeTaskCallback("vscode-R")
options(vscodeR = NULL)
.vsc.name <- "tools:vscode"
if (.vsc.name %in% search()) {
    detach(.vsc.name, character.only = TRUE)
}

# Source vsc utils in new environmeent
.vsc <- new.env()
source(file.path(dir_init, "vsc.R"), local = .vsc)

# attach functions that are meant to be called by the user/vscode
exports <- local({
    .vsc <- .vsc
    .vsc.attach <- .vsc$attach
    .vsc.detach <- .vsc$detach
    .vsc.view <- .vsc$show_dataview
    .vsc.browser <- .vsc$show_browser
    .vsc.viewer <- .vsc$show_viewer
    .vsc.page_viewer <- .vsc$show_page_viewer
    environment()
})
attach(exports, name = .vsc.name, warn.conflicts = FALSE)

# overwrite S3 bindings from other packages
suppressWarnings({
    if (!identical(getOption("vsc.helpPanel", "Two"), FALSE)) {
        # Overwrite print function for results of `?`
        .vsc$.S3method(
            "print",
            "help_files_with_topic",
            .vsc$print.help_files_with_topic
        )
        # Overwrite print function for results of `??`
        .vsc$.S3method(
            "print",
            "hsearch",
            .vsc$print.hsearch
        )
    }
    # Further S3 overwrites can go here
    # ...
})
