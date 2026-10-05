# Shared by ordinary sess installation and the private Interactive runtime.
# Source builds preserve the bundled development version. If that fails, only
# compiler-free repository packages are considered; never fall back to compiling
# another source archive behind the user's back.
sess_binary_repositories <- function(sysname = Sys.info()[["sysname"]],
                                     arch = R.version$arch,
                                     type = .Platform$pkgType,
                                     release = if (file.exists("/etc/os-release")) {
                                         readLines("/etc/os-release", warn = FALSE)
                                     } else {
                                         character()
                                     }) {
    owners <- c("reditorsupport", "cran")
    roots <- sprintf("https://%s.r-universe.dev", owners)
    result <- list()
    if (sysname %in% c("Darwin", "Windows") && type != "source") {
        result <- list(list(urls = utils::contrib.url(roots, type), type = type))
    }
    if (identical(sysname, "Linux")) {
        field <- function(name) {
            value <- sub(paste0("^", name, "="), "", release[startsWith(release, paste0(name, "="))])
            if (length(value)) gsub('^["\']|["\']$', "", value[[1L]]) else ""
        }
        distro <- field("VERSION_CODENAME")
        if (field("ID") == "ubuntu" && grepl("^[a-z]+$", distro) &&
                arch %in% c("x86_64", "aarch64")) {
            r_version <- paste(R.version$major, strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L], sep = ".")
            result <- list(list(urls = sprintf("%s/bin/linux/%s-%s/contrib/%s", roots, distro, arch, r_version),
                                type = "source"))
        }
    }
    # Pure-R releases are portable even where no Linux binary target exists.
    # The NeedsCompilation gate below also applies to their dependencies.
    c(result, list(list(urls = utils::contrib.url(roots, "source"), type = "source", pure = TRUE)))
}

sess_package_compatible <- function(description, required, interactive) {
    get <- function(field) if (field %in% colnames(description)) description[1L, field] else ""
    if (get("Package") != "sess" || !nzchar(get("Version")) ||
            utils::compareVersion(get("Version"), required) < 0L) {
        stop("The repository sess package is older than the version required by this extension.")
    }
    # Version alone cannot distinguish the released sess from this development
    # branch, which initially shares its version but adds the Interactive API.
    if (interactive && get("Config/vscode-R/Interactive") != "2") {
        stop("The published sess package does not support this Interactive runtime yet.")
    }
    invisible(TRUE)
}

sess_install_command <- function(package, library) {
    status <- system2(file.path(R.home("bin"), "R"),
                      c("CMD", "INSTALL", "--clean", shQuote(paste0("--library=", library)), shQuote(package)))
    identical(as.integer(status), 0L)
}

sess_verify_package <- function(library, required, interactive) {
    # Verification must not accidentally use an older namespace already loaded
    # in the terminal from which Attach was invoked.
    code <- paste(
        "a <- commandArgs(TRUE); ns <- loadNamespace('sess', lib.loc=a[1]);",
        "stopifnot(normalizePath(getNamespaceInfo(ns,'path')) == normalizePath(file.path(a[1],'sess')));",
        "stopifnot(utils::compareVersion(as.character(utils::packageVersion('sess',lib.loc=a[1])),a[2]) >= 0);",
        "stopifnot(all(c('connect','notify_client','register_hooks','request_client') %in% getNamespaceExports(ns)));",
        "if (a[3] == 'TRUE') {",
        "stopifnot(all(c('interactive_stop','display') %in% getNamespaceExports(ns)));",
        "stopifnot(all(vapply(c('interactive_start','interactive_execute'),",
        "function(n) exists(n, ns, mode='function', inherits=FALSE), FALSE)));",
        "stopifnot(packageDescription('sess',lib.loc=a[1],fields='Config/vscode-R/Interactive') == '2');",
        "stopifnot(packageDescription('sess',lib.loc=a[1],fields='NeedsCompilation') == 'no'); }"
    )
    status <- system2(file.path(R.home("bin"), "R"),
                      c("--vanilla", "--slave", "-e", shQuote(code), "--args",
                        shQuote(library), shQuote(required), as.character(interactive)))
    if (!identical(as.integer(status), 0L)) stop("The installed sess package failed its compatibility/load check.")
}

sess_install_binary <- function(library, required, interactive) {
    errors <- character()
    for (repository in sess_binary_repositories()) {
        error <- tryCatch({
            available <- utils::available.packages(contriburl = repository$urls, type = repository$type,
                                                   fields = c("NeedsCompilation", "Built"))
            if (isTRUE(repository$pure)) {
                available <- available[!is.na(available[, "NeedsCompilation"]) &
                                           available[, "NeedsCompilation"] == "no", , drop = FALSE]
            } else if (repository$type == "source") {
                # Linux uses R's source-repository layout for binary tarballs.
                # Exclude entries without Built, including dependency entries.
                available <- available[!is.na(available[, "Built"]) &
                                           nzchar(available[, "Built"]), , drop = FALSE]
            }
            if (!"sess" %in% rownames(available)) stop("No compiler-free sess package for this R/platform.")
            if (utils::compareVersion(available["sess", "Version"], required) < 0L) {
                stop("The available sess package is too old.")
            }
            downloads <- tempfile("sess-download-")
            dir.create(downloads)
            on.exit(unlink(downloads, recursive = TRUE), add = TRUE)
            downloaded <- utils::download.packages("sess", downloads, available = available,
                                                   contriburl = repository$urls, type = repository$type)
            if (!nrow(downloaded)) stop("Could not download sess from R-universe.")
            archive <- downloaded[1L, 2L]
            # Read metadata before touching an existing installation.
            metadata <- file.path(downloads, "metadata")
            dir.create(metadata)
            if (repository$type == "win.binary") {
                utils::unzip(archive, files = "sess/DESCRIPTION", exdir = metadata)
            } else {
                utils::untar(archive, files = "sess/DESCRIPTION", exdir = metadata)
            }
            description <- read.dcf(file.path(metadata, "sess", "DESCRIPTION"))
            sess_package_compatible(description, required, interactive)
            if (!isTRUE(repository$pure) && !"Built" %in% colnames(description)) {
                stop("The repository returned source instead of a pre-built sess package.")
            }
            if (isTRUE(repository$pure) &&
                    (!"NeedsCompilation" %in% colnames(description) || description[1L, "NeedsCompilation"] != "no")) {
                stop("The repository sess package requires compilation.")
            }
            dependencies <- tools::package_dependencies("sess", available, recursive = TRUE)[[1L]]
            installed <- utils::installed.packages(lib.loc = unique(c(library, .libPaths())))
            missing <- setdiff(dependencies, rownames(installed))
            if (length(missing)) {
                if (any(!missing %in% rownames(available))) stop("Some dependencies have no compatible binary.")
                utils::install.packages(missing, lib = library, repos = NULL,
                                        contriburl = repository$urls, available = available, type = repository$type)
            }
            message("Installing compiler-free sess from R-universe: ", archive)
            # macOS/Windows use R's binary installer. Linux binary tarballs have a
            # Built field and R CMD INSTALL unpacks them without invoking make.
            if (repository$type != "source") {
                utils::install.packages(archive, lib = library, repos = NULL, type = repository$type)
            } else if (!sess_install_command(archive, library)) {
                stop("Could not install the repository sess package.")
            }
            sess_verify_package(library, required, interactive)
            NULL
        }, error = function(e) conditionMessage(e))
        if (is.null(error)) return(invisible(TRUE))
        errors <- c(errors, paste(repository$urls[[1L]], error, sep = ": "))
    }
    stop(paste(c("Bundled sess could not be built, and no compatible compiler-free fallback was usable.",
                 errors, "Check the installation log, library permissions, and availability of sess dependencies."),
               collapse = "\n"), call. = FALSE)
}

sess_install <- function(pkg_path, library, repos, interactive = FALSE) {
    required <- read.dcf(file.path(pkg_path, "DESCRIPTION"))[1L, "Version"]
    # Pass the caller's library search path to installation/verification children,
    # including project libraries, without sourcing the caller's startup profile.
    keys <- c("R_LIBS", "R_PROFILE_USER", "R_ENVIRON_USER")
    previous <- Sys.getenv(keys, unset = NA_character_, names = TRUE)
    on.exit({
        Sys.unsetenv(keys[is.na(previous)])
        if (any(!is.na(previous))) do.call(Sys.setenv, as.list(previous[!is.na(previous)]))
    }, add = TRUE)
    Sys.setenv(R_LIBS = paste(unique(c(library, .libPaths())), collapse = .Platform$path.sep),
               R_PROFILE_USER = "", R_ENVIRON_USER = "")
    description <- read.dcf(file.path(pkg_path, "DESCRIPTION"))
    deps <- if ("Imports" %in% colnames(description)) description[1L, "Imports"] else ""
    deps <- trimws(gsub("\\s*\\(.*\\)", "", unlist(strsplit(deps, ","))))
    installed <- utils::installed.packages(lib.loc = unique(c(library, .libPaths())))
    missing <- setdiff(deps[nzchar(deps)], rownames(installed))
    if (length(missing)) {
        tryCatch(utils::install.packages(missing, lib = library, repos = repos),
                 error = function(e) message("Dependency installation failed: ", conditionMessage(e)))
    }
    message("Installing bundled sess from: ", pkg_path)
    if (sess_install_command(pkg_path, library)) {
        sess_verify_package(library, required, interactive)
    } else {
        message("Bundled sess installation failed; checking R-universe for a compiler-free fallback.")
        sess_install_binary(library, required, interactive)
    }
    invisible(TRUE)
}
