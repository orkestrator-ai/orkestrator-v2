import { LOG_VOCABULARY, type LogAreaSpec } from "./log-vocabulary/index.js";
import {
  isRendererErrorBoundary,
  isRendererErrorClass,
  isRendererErrorFingerprint,
  isRendererErrorRoute,
} from "./renderer-errors.js";

// This is a persistence allowlist, not a string grammar. Unknown error names,
// codes and classifications are omitted even when they look like identifiers.
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "SystemError",
]);
const ERROR_CODES = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENETUNREACH",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOSYS",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "EROFS",
  "ETIMEDOUT",
  "EXDEV",
  "SQLITE_BUSY",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
  "ERR_CANCELED",
  "ERR_STREAM_DESTROYED",
]);
const SYSCALLS = new Set([
  "open",
  "read",
  "write",
  "stat",
  "lstat",
  "mkdir",
  "rmdir",
  "readdir",
  "rename",
  "unlink",
  "fsync",
  "fdatasync",
  "close",
  "access",
  "chmod",
  "copyfile",
  "connect",
  "listen",
  "bind",
  "spawn",
  "kill",
  "getaddrinfo",
]);
const SIGNALS = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTOP",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUSR1",
  "SIGUSR2",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
]);
const PROVIDERS = new Set(["claude", "codex", "opencode", "cursor", "grok", "acp", "pi"]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE = new RegExp(`^(?:claude|codex|opencode|cursor|grok|acp|pi):${UUID}$`, "i");
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/;
const vocabulary = LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>;

export function isEssentialLabel(
  area: string,
  event: string,
  field: string,
  value: string,
): boolean {
  const leaf = field.split(".").at(-1);
  if (leaf === "name" || leaf === "kind") {
    return (
      ERROR_NAMES.has(value) ||
      (leaf === "kind" &&
        [
          "string",
          "number",
          "boolean",
          "object",
          "undefined",
          "symbol",
          "bigint",
          "function",
        ].includes(value))
    );
  }
  if (leaf === "code") return ERROR_CODES.has(value);
  if (leaf === "syscall") return SYSCALLS.has(value);
  if (leaf === "signal") return SIGNALS.has(value);
  if (field === "site") return Object.hasOwn(vocabulary[area]?.events ?? {}, value);
  if (field === "source" || (area === "local-server" && field === "key")) return SOURCE.test(value);
  if (area === "backend" && event === "starting" && field === "version") return VERSION.test(value);
  if (area === "backend" && event === "previous-run" && field === "outcome")
    return value === "clean" || value === "crashed";
  if (area === "docker" && field === "reason") {
    if (event === "writer-lease.lost") return ["reclaimed", "unreadable"].includes(value);
    if (event === "writer-lease.not-acquired")
      return ["busy", "schema-incompatible"].includes(value);
  }
  if (area === "docker" && event === "bridge.launched" && field === "provider")
    return PROVIDERS.has(value);
  if (area === "logging" && field === "owner") return value === "desktop" || value === "backend";
  if (area === "logging" && event === "entries.dropped" && field === "reason")
    return ["queue-full", "write-failed", "rate-limited"].includes(value);
  if (area === "process" && field === "origin")
    return value === "uncaughtException" || value === "unhandledRejection";
  if (area === "storage" && event === "snapshot.failed" && field === "retryAt")
    return TIMESTAMP.test(value);
  if (area === "storage" && event === "migration.failed" && field === "step")
    return ["snapshot", "migrate"].includes(value);
  if (area === "renderer-errors" && event === "error.recorded") {
    if (field === "errorClass") return isRendererErrorClass(value);
    if (field === "boundary") return isRendererErrorBoundary(value);
    if (field === "route") return isRendererErrorRoute(value);
    if (field === "fingerprint") return isRendererErrorFingerprint(value);
  }
  if (area === "desktop" && event === "startup.failed" && field === "step")
    return value === "gateway";
  return false;
}
