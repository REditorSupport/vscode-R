
text <- Sys.getenv('VSCODE_EVAL_CODE')

status <- 1
try({
    eval(parse(text=text))
    status <- 0
})

quit(save='no', status=status)
