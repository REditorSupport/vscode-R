# R-universe runs this from the package directory after normalizing DESCRIPTION.
# Use the original Git snapshot, not the build service's generated metadata.
local({
  field <- "Config/vscode-R/source-revision"
  description <- readLines("DESCRIPTION", warn = FALSE)
  source_field <- startsWith(description, paste0(field, ":"))
  if (sum(source_field) != 1L) {
    stop("DESCRIPTION must contain exactly one source revision field")
  }
  description[source_field] <- paste0(field, ": @VSCODE_R_SESS_SOURCE_REVISION@")
  write_description <- function(lines) {
    # A binary write keeps generated DESCRIPTION at LF on Windows as well.
    writeBin(charToRaw(paste0(paste(lines, collapse = "\n"), "\n")), "DESCRIPTION")
  }
  # R-universe ignores bootstrap's exit status. Remove a stale stamp first so a
  # failed bootstrap cannot leave behind an apparently valid source identity.
  write_description(description)
  git <- function(args) {
    output <- system2("git", args, stdout = TRUE)
    if (!is.null(attr(output, "status")) || length(output) > 1L) {
      stop("Cannot determine sess source revision from Git")
    }
    trimws(paste(output, collapse = ""))
  }
  prefix <- git(c("rev-parse", "--show-prefix"))
  # Bootstrap identifies committed R-universe sources. Refuse local source edits;
  # VSIX development builds fingerprint the working tree via prepare-sess.js.
  status <- system2("git", c("diff", "--quiet", "HEAD", "--", ".",
                           shQuote(":(exclude)DESCRIPTION")))
  untracked <- system2("git", c("ls-files", "--others", "--exclude-standard", "."),
                       stdout = TRUE)
  if (status != 0L || length(untracked)) {
    stop("bootstrap.R requires committed sess sources")
  }
  original <- system2("git", c("show", shQuote(paste0("HEAD:", prefix, "DESCRIPTION"))),
                      stdout = TRUE)
  original_con <- textConnection(original)
  on.exit(close(original_con))
  original_desc <- read.dcf(original_con)
  current_desc <- read.dcf("DESCRIPTION")
  normalize <- function(desc) {
    values <- desc[1, !colnames(desc) %in% c(field, "Config/pak/sysreqs")]
    gsub("\\s+", " ", values[order(names(values))])
  }
  if (!identical(normalize(original_desc), normalize(current_desc))) {
    stop("bootstrap.R requires the original DESCRIPTION (apart from build metadata/formatting)")
  }
  reference <- if (nzchar(prefix)) paste0("HEAD:", sub("/$", "", prefix)) else "HEAD^{tree}"
  tree <- git(c("rev-parse", shQuote(reference)))
  revision <- paste0("git-tree:", tree)
  if (!grepl("^git-tree:([a-f0-9]{40}|[a-f0-9]{64})$", revision)) {
    stop("Invalid sess source revision")
  }
  description[source_field] <- paste0(field, ": ", revision)
  write_description(description)
})
