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
/** `container-bridge-listener.ts`'s refusal reasons. */
const BRIDGE_LISTENER_REASONS = new Set([
  "different-socket",
  "several-sockets",
  "pending",
  "scan-incomplete",
  "no-listener",
  "launch-exited",
]);
/** The Agent SDK's result subtypes (`SDKResultMessage`). */
const CLAUDE_RESULT_SUBTYPES = new Set([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
/** The Agent SDK's API error codes (`SDKAssistantMessageError`). */
const CLAUDE_API_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
  "cloud_credential_error",
]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE = new RegExp(`^(?:claude|codex|opencode|cursor|grok|acp|pi):${UUID}$`, "i");
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/;
/** `storage-slow-operations.ts`: which file, the statement kind and a code-written table or pragma name. */
const STORAGE_DATABASES = new Set(["main", "ledger", "other"]);
const STORAGE_OPERATIONS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "pragma",
  "schema",
  "vacuum",
  "transaction",
  "other",
]);
const TRANSACTION_MODES = new Set(["deferred", "immediate", "exclusive"]);
/**
 * The tables and pragmas the backend's statements name: the store schema
 * (`storage-database.ts`), the pragmas it runs, and the change-tracking
 * ledger's tables, which all start `change_`.
 */
const STORAGE_TABLES = new Set([
  "stores",
  "store_rows",
  "storage_meta",
  "leases",
  "store_rows_owner",
  "store_rows_position",
  "sqlite_master",
  "sqlite_schema",
  "dbstat",
  "analysis_limit",
  "auto_vacuum",
  "busy_timeout",
  "foreign_keys",
  "freelist_count",
  "incremental_vacuum",
  "integrity_check",
  "journal_mode",
  "journal_size_limit",
  "optimize",
  "page_count",
  "page_size",
  "quick_check",
  "secure_delete",
  "synchronous",
  "user_version",
  "wal_checkpoint",
]);
const LEDGER_TABLE = /^change_[a-z]{1,32}(?:_[a-z]{1,32}){0,4}$/;
const isStorageTable = (value: string) => STORAGE_TABLES.has(value) || LEDGER_TABLE.test(value);
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
  if (area === "local-server" && event === "bridge.orphans-reaped" && field === "result")
    return value === "stopped" || value === "survived";
  if (area === "docker" && field === "reason") {
    if (event === "writer-lease.lost") return ["reclaimed", "unreadable"].includes(value);
    if (event === "writer-lease.not-acquired")
      return ["busy", "schema-incompatible"].includes(value);
  }
  if (area === "docker" && event === "bridge.launched" && field === "provider")
    return PROVIDERS.has(value);
  if (
    area === "docker" &&
    (event === "bridge.listener-refused" || event === "bridge.listener-unrecorded")
  ) {
    if (field === "provider") return PROVIDERS.has(value);
    if (field === "reason") return BRIDGE_LISTENER_REASONS.has(value);
  }
  if (area === "bridge.claude" && event === "query.failed") {
    if (field === "subtype") return CLAUDE_RESULT_SUBTYPES.has(value);
    if (field === "reason") return CLAUDE_API_ERRORS.has(value);
  }
  if (area === "logging" && field === "owner") return value === "desktop" || value === "backend";
  if (area === "logging" && event === "entries.dropped" && field === "reason")
    return ["queue-full", "write-failed", "rate-limited"].includes(value);
  if (area === "process" && field === "origin")
    return value === "uncaughtException" || value === "unhandledRejection";
  if (area === "storage" && event === "operation.slow") {
    if (field === "database") return STORAGE_DATABASES.has(value);
    if (field === "op") return STORAGE_OPERATIONS.has(value);
    if (field === "table") return isStorageTable(value);
    if (field === "mode") return TRANSACTION_MODES.has(value);
  }
  if (area === "event-loop" && event === "stalled") {
    if (field === "storageDatabase") return STORAGE_DATABASES.has(value);
    if (field === "storageOp") return STORAGE_OPERATIONS.has(value);
    if (field === "storageTable") return isStorageTable(value);
  }
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
