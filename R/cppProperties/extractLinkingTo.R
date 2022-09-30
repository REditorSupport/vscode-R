deps <- read.dcf("DESCRIPTION", "LinkingTo")
if (length(deps) == 0) { # Empty file
    deps <- ""
} else {
    deps <- unname(deps[1, ]) # Read 'LinkingTo' field from description
    deps <- gsub("\\s|\\n|(\\([^\\)]*\\))", "", deps) # Remove all whitespace, line breaks and version constraints
    deps <- strsplit(deps, ",")[[1]] # Split package names
    deps <- vapply(deps, function(pkg) {
        system.file("include", package = pkg)
    }, character(1)) # Lookup include dir
    deps <- utils::URLencode(deps)
}
writeLines(deps)
