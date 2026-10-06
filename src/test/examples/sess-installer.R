local({
    # Offline installer regressions: pure R source works with the compiler disabled.
    root <- normalizePath(commandArgs(TRUE)[[1L]])
    installer <- new.env(parent = baseenv())
    sys.source(file.path(root, "R", "sess-package-install.R"), installer)
    fail <- function(code, pattern) {
        error <- tryCatch({
            force(code)
            NULL
        }, error = conditionMessage)
        stopifnot(is.character(error), grepl(pattern, error))
    }
    repos <- installer$sess_binary_repositories("Linux", "x86_64", "source",
                                                c('ID="ubuntu"', 'VERSION_CODENAME="resolute"'))
    stopifnot(grepl("/resolute-x86_64/", repos[[1L]]$urls[[1L]]), isTRUE(repos[[2L]]$pure))
    stopifnot(length(installer$sess_binary_repositories("Linux", "x86_64", "source",
                                                        c("ID=debian", "VERSION_CODENAME=bookworm"))) == 1L)
    stopifnot(length(installer$sess_binary_repositories("Linux", "unknown", "source",
                                                        c("ID=ubuntu", "VERSION_CODENAME=resolute"))) == 1L)
    stopifnot(installer$sess_binary_repositories("Windows", "x86_64", "win.binary")[[1L]]$type == "win.binary")
    description <- matrix(c("sess", "3.0.1", "1", "no"), nrow = 1L,
                           dimnames = list(NULL, c("Package", "Version", "Config/vscode-R/Interactive", "NeedsCompilation")))
    stopifnot(installer$sess_package_compatible(description, "3.0.1", TRUE))
    fail(installer$sess_package_compatible(description, "3.1.0", FALSE), "older")
    legacy <- description[, c("Package", "Version"), drop = FALSE]
    stopifnot(installer$sess_package_compatible(legacy, "3.0.1", FALSE))
    fail(installer$sess_package_compatible(legacy, "3.0.1", TRUE), "does not support")
    native <- description
    native[1L, "NeedsCompilation"] <- "yes"
    fail(installer$sess_package_compatible(native, "3.0.1", TRUE), "does not support")
    stopifnot(installer$sess_package_compatible(native, "3.0.1", FALSE))

    temporary <- tempfile("sess installer ")
    dir.create(temporary)
    previous_directory <- setwd(temporary)
    on.exit({
        setwd(previous_directory)
        unlink(temporary, recursive = TRUE)
    }, add = TRUE)
    library <- file.path(temporary, "build library")
    dir.create(library)
    stopifnot(file.copy(file.path(root, "sess"), temporary, recursive = TRUE))
    package <- file.path(temporary, "sess")
    version <- read.dcf(file.path(package, "DESCRIPTION"))[1L, "Version"]
    repository_url <- function(path) {
        paste0("file://", if (.Platform$OS.type == "windows") "/" else "", normalizePath(path, winslash = "/"))
    }
    status <- system2(file.path(R.home("bin"), "R"),
                      c("CMD", "INSTALL", "--build", "--clean", shQuote(paste0("--library=", library)), shQuote(package)))
    stopifnot(status == 0L)
    archive <- list.files(temporary, "^sess_.*\\.(tgz|tar\\.gz|zip)$", full.names = TRUE)
    stopifnot(length(archive) == 1L)
    repository <- file.path(temporary, "repository")
    dir.create(repository)
    type <- if (.Platform$OS.type == "windows") "win.binary" else if (Sys.info()[["sysname"]] == "Darwin") {
        .Platform$pkgType
    } else "source"
    # R CMD INSTALL --build adds a platform suffix on Linux, but source-layout
    # repositories (including R-universe's Linux binaries) use the standard name.
    repository_archive <- if (type == "source") paste0("sess_", version, ".tar.gz") else basename(archive)
    stopifnot(file.copy(archive, file.path(repository, repository_archive)))
    tools::write_PACKAGES(repository, type = if (startsWith(type, "mac.binary")) "mac.binary" else type,
                           fields = "Built", latestOnly = FALSE)
    installer$sess_binary_repositories <- function() list(list(urls = repository_url(repository), type = type))
    makevars <- file.path(temporary, "No compiler")
    writeLines(c("CC=compiler-is-not-installed", "CXX=compiler-is-not-installed"), makevars)
    Sys.setenv(R_MAKEVARS_USER = makevars)
    target <- file.path(temporary, "target library")
    dir.create(target)
    environment_before <- Sys.getenv(c("R_LIBS", "R_PROFILE_USER", "R_ENVIRON_USER"), unset = NA_character_)
    installer$sess_install(package, target, "https://unused.invalid", interactive = TRUE)
    stopifnot(identical(environment_before,
                        Sys.getenv(c("R_LIBS", "R_PROFILE_USER", "R_ENVIRON_USER"), unset = NA_character_)))
    stopifnot(file.exists(file.path(target, "sess", "DESCRIPTION")))
    cat("Pure R source installation and Interactive API verification passed.\n")

    installer$sess_install_binary(target, version, TRUE)
    cat("Compiler-free repository installation passed.\n")

    if (.Platform$OS.type != "windows") {
        linux_layout <- file.path(temporary, "linux-layout")
        dir.create(linux_layout)
        stopifnot(file.copy(archive, file.path(linux_layout, paste0("sess_", version, ".tar.gz"))))
        tools::write_PACKAGES(linux_layout, type = "source", fields = "Built")
        installer$sess_binary_repositories <- function() {
            list(list(urls = repository_url(linux_layout), type = "source"))
        }
        linux_target <- file.path(temporary, "linux target")
        dir.create(linux_target)
        installer$sess_install_binary(linux_target, version, TRUE)
        cat("Linux binary repository layout installs without invoking the compiler.\n")
    }

    # A published package with the same version but no Interactive contract must not
    # replace the working installation. Use a separate repo to avoid R's index cache.
    bad_repository <- file.path(temporary, "legacy-repository")
    dir.create(bad_repository)
    metadata <- file.path(library, "sess", "DESCRIPTION")
    desc <- read.dcf(metadata)
    desc <- desc[, colnames(desc) != "Config/vscode-R/Interactive", drop = FALSE]
    write.dcf(desc, metadata)
    setwd(library)
    bad_archive <- file.path(bad_repository, repository_archive)
    if (type == "win.binary") {
        utils::zip(bad_archive, "sess", flags = "-r9X")
    } else {
        utils::tar(bad_archive, "sess", compression = "gzip", tar = "internal")
    }
    tools::write_PACKAGES(bad_repository, type = if (startsWith(type, "mac.binary")) "mac.binary" else type,
                           fields = "Built")
    installer$sess_binary_repositories <- function() list(list(urls = repository_url(bad_repository), type = type))
    before <- tools::md5sum(file.path(target, "sess", "DESCRIPTION"))
    fail(installer$sess_install_binary(target, version, TRUE), "does not support")
    stopifnot(identical(before, tools::md5sum(file.path(target, "sess", "DESCRIPTION"))))
    cat("Incompatible published build rejected without replacing installed sess.\n")
    setwd(previous_directory)
    unlink(temporary, recursive = TRUE)
})
