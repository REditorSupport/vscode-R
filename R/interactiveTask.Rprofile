
text <- Sys.getenv('VSCODE_EVAL_CODE')

ret <- try(eval(parse(text=text)))

status <- 0
if(inherits(ret, 'try-error')){
    status <- 1
}

quit(save='no', status=status)
