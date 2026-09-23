.sess_env <- new.env(parent = emptyenv())
# Unique for this R process and retained if the IPC connection is re-established.
.sess_env$session_id <- basename(tempfile("sess-session-"))
