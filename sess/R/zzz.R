.sess_env <- new.env(parent = emptyenv())
# Unique for this R process and retained if the IPC connection is re-established.
.sess_env$session_pid <- Sys.getpid()
.sess_env$session_id <- basename(tempfile("sess-session-"))

# Namespace state is inherited across fork(), so refresh the identity if a child
# process reaches the attach handshake with its parent's cached state.
.session_id <- function() {
  pid <- Sys.getpid()
  if (is.null(.sess_env$session_id) ||
        !identical(.sess_env$session_pid, pid)) {
    .sess_env$session_pid <- pid
    .sess_env$session_id <- basename(tempfile("sess-session-"))
  }
  .sess_env$session_id
}
