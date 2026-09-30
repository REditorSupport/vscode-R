/* Console callbacks run on R's main thread. They only perform I/O here: calling
 * back into R from WriteConsole would recursively enter the evaluator. */
#define R_INTERFACE_PTRS 1
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#ifndef _WIN32
#include <Rinterface.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <errno.h>

static int bridge_fd = -1;
static int mirror_output = 0;
static int input_counter = 0;
static char execution_id[101] = "";
static void (*previous_write)(const char *, int) = NULL;
static void (*previous_write_ex)(const char *, int, int) = NULL;
static int (*previous_read)(const char *, unsigned char *, int, int) = NULL;
static FILE *previous_output_file = NULL;
static FILE *previous_console_file = NULL;

static int write_all(const char *data, size_t length) {
    while (length && bridge_fd >= 0) {
#ifdef MSG_NOSIGNAL
        ssize_t n = send(bridge_fd, data, length, MSG_NOSIGNAL);
#else
        ssize_t n = write(bridge_fd, data, length);
#endif
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { close(bridge_fd); bridge_fd = -1; return 0; }
        data += n;
        length -= (size_t) n;
    }
    return bridge_fd >= 0;
}

static char *escape_json(const char *text, size_t length) {
    char *out = (char *) malloc(length * 6 + 1);
    if (!out) return NULL;
    char *p = out;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char) text[i];
        if (c == '"' || c == '\\') { *p++ = '\\'; *p++ = (char)c; }
        else if (c < 32) { snprintf(p, 7, "\\u%04x", c); p += 6; }
        else *p++ = (char)c;
    }
    *p = '\0';
    return out;
}

static void console_write(const char *buffer, int length, int type) {
    char header[256];
    if (bridge_fd >= 0 && length > 0) {
        /* Base64 preserves byte boundaries even when R splits a UTF-8 character
         * across callbacks. Bound every frame before JSON encoding. */
        static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int offset = 0; offset < length; offset += 12288) {
            int count = length - offset;
            if (count > 12288) count = 12288;
            char encoded[16385];
            int out = 0;
            for (int i = 0; i < count; i += 3) {
                unsigned a = (unsigned char)buffer[offset + i];
                unsigned b = i + 1 < count ? (unsigned char)buffer[offset + i + 1] : 0;
                unsigned c = i + 2 < count ? (unsigned char)buffer[offset + i + 2] : 0;
                encoded[out++] = alphabet[a >> 2];
                encoded[out++] = alphabet[((a & 3) << 4) | (b >> 4)];
                encoded[out++] = i + 1 < count ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
                encoded[out++] = i + 2 < count ? alphabet[c & 63] : '=';
            }
            snprintf(header, sizeof(header),
                "{\"type\":\"stream\",\"executionId\":\"%s\",\"channel\":\"%s\",\"bytes\":\"",
                execution_id, type ? "stderr" : "stdout");
            write_all(header, strlen(header));
            write_all(encoded, (size_t)out);
            write_all("\"}\n", 3);
        }
    }
    if (mirror_output || bridge_fd < 0) {
        if (previous_write_ex) previous_write_ex(buffer, length, type);
        else if (previous_write) previous_write(buffer, length);
    }
}

static int console_read(const char *prompt, unsigned char *buffer, int length, int history) {
    if (!execution_id[0] && mirror_output && previous_read) {
        return previous_read(prompt, buffer, length, history);
    }
    if (bridge_fd < 0 || length < 2) return 0;
    char *escaped = escape_json(prompt, strlen(prompt));
    if (!escaped) return 0;
    char header[256];
    snprintf(header, sizeof(header),
        "{\"type\":\"input\",\"executionId\":\"%s\",\"inputId\":%d,\"maxLength\":%d,\"prompt\":\"",
        execution_id, ++input_counter, length - 2);
    write_all(header, strlen(header));
    write_all(escaped, strlen(escaped));
    write_all("\"}\n", 3);
    free(escaped);
    int i = 0;
    while (i < length - 1) {
        ssize_t n = read(bridge_fd, buffer + i, 1);
        if (n < 0 && errno == EINTR) { R_CheckUserInterrupt(); continue; }
        if (n <= 0) return 0;
        if (buffer[i++] == '\n') break;
    }
    buffer[i] = '\0';
    return 1;
}
#endif

SEXP sess_bridge_start(SEXP endpoint, SEXP token, SEXP mirror) {
#ifdef _WIN32
    Rf_error("Native Interactive console callbacks are currently supported on Unix R frontends");
#else
    if (bridge_fd >= 0) Rf_error("This R process already has an Interactive console bridge");
    const char *socket_path = CHAR(STRING_ELT(endpoint, 0));
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof(address.sun_path)) Rf_error("Interactive socket path too long");
    strcpy(address.sun_path, socket_path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) Rf_error("Cannot create Interactive console socket");
#ifdef SO_NOSIGPIPE
    int enabled = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
#endif
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        close(fd);
        Rf_error("Cannot connect Interactive console socket");
    }
    bridge_fd = fd;
    mirror_output = Rf_asLogical(mirror) == TRUE;
    char *escaped = escape_json(CHAR(STRING_ELT(token, 0)), strlen(CHAR(STRING_ELT(token, 0))));
    if (!escaped) { close(fd); bridge_fd = -1; Rf_error("Out of memory"); }
    write_all("{\"type\":\"hello\",\"token\":\"", 25);
    write_all(escaped, strlen(escaped));
    write_all("\"}\n", 3);
    free(escaped);
    previous_write = ptr_R_WriteConsole;
    previous_write_ex = ptr_R_WriteConsoleEx;
    previous_read = ptr_R_ReadConsole;
    previous_output_file = R_Outputfile;
    previous_console_file = R_Consolefile;
    R_Outputfile = NULL;
    R_Consolefile = NULL;
    ptr_R_WriteConsole = NULL;
    ptr_R_WriteConsoleEx = console_write;
    ptr_R_ReadConsole = console_read;
#endif
    return R_NilValue;
}

SEXP sess_bridge_send(SEXP message) {
#ifndef _WIN32
    const char *json = CHAR(STRING_ELT(message, 0));
    if (!write_all(json, strlen(json)) || !write_all("\n", 1)) {
        Rf_error("Interactive agent disconnected");
    }
#endif
    return R_NilValue;
}

SEXP sess_bridge_context(SEXP id) {
#ifndef _WIN32
    const char *value = CHAR(STRING_ELT(id, 0));
    if (strlen(value) > 100 || strspn(value, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != strlen(value)) {
        Rf_error("Invalid execution identity");
    }
    strcpy(execution_id, value);
#endif
    return R_NilValue;
}

SEXP sess_bridge_stop(void) {
#ifndef _WIN32
    if (ptr_R_WriteConsoleEx == console_write) {
        ptr_R_WriteConsole = previous_write;
        ptr_R_WriteConsoleEx = previous_write_ex;
        R_Outputfile = previous_output_file;
        R_Consolefile = previous_console_file;
    }
    if (ptr_R_ReadConsole == console_read) ptr_R_ReadConsole = previous_read;
    if (bridge_fd >= 0) close(bridge_fd);
    bridge_fd = -1;
    execution_id[0] = '\0';
#endif
    return R_NilValue;
}

static const R_CallMethodDef call_methods[] = {
    {"sess_bridge_start", (DL_FUNC) &sess_bridge_start, 3},
    {"sess_bridge_send", (DL_FUNC) &sess_bridge_send, 1},
    {"sess_bridge_context", (DL_FUNC) &sess_bridge_context, 1},
    {"sess_bridge_stop", (DL_FUNC) &sess_bridge_stop, 0},
    {NULL, NULL, 0}
};

void R_init_sess(DllInfo *dll) {
    R_registerRoutines(dll, NULL, call_methods, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
}
