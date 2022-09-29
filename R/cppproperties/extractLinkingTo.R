
deps <- unname(read.dcf("DESCRIPTION", "LinkingTo")[1, ]) # Read 'LinkingTo' field from description
deps <- gsub("\\s|\\n|(\\([^\\)]*\\))", "", deps) # Remove all whitespace and line breaks
deps <- strsplit(deps, ",")[[1]] # Split package names
deps <- vapply(deps, function(pkg) {
    system.file("include", package = pkg)
}, character(1)) # Lookup include dir
cat(paste(deps, collapse = "////")) # Collapse for returning
