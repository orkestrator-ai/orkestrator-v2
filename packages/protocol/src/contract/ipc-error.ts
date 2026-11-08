/**
 * Coded errors in an error's message, the form that crosses Electron IPC
 * (plan item 1005, docs/reports/unified-federation.md §11.2;
 * docs/architecture/version-compatibility.md, "Typed errors").
 *
 * Electron passes only an error's message from main to the preload, and the
 * context bridge drops an error's custom properties on the way to the
 * renderer, so the code and the bounded details travel in the message. This
 * extends 2007's `[code] text` refusal convention (`node-ipc.ts`) with
 * `key=value` details inside the brackets:
 *
 *     [unsupported-version domain=git range=1-3 command=get_x] Domain git …
 *     [native-agent-provider-session-missing] Native agent provider session …
 *
 * Only a code in {@link REGISTERED_ERROR_CODES} is written or read in this
 * form, and only the detail keys registered for that code, each of a bounded
 * kind: `text` (at most 64 characters, `encodeURIComponent`-encoded, so a
 * value never holds a space or a `]`), `range` (`min-max`, four digits each)
 * or `count` (a non-negative integer). A detail is never an argument value.
 * The text after the brackets is the thrower's own message, unchanged, so an
 * older reader that matches its words still finds them.
 *
 * {@link errorCode} reads the code from any thrown or received value, whatever
 * transport it came over; `incompatibility()` (`./errors.ts`) reads the three
 * incompatibility codes with their details. The preload also copies the code
 * and details to `error.code` and `error.details` for code in its own world.
 *
 * No Effect import: the sandboxed preload bundle uses this module. The Effect
 * `Data.TaggedError` classes for these codes live in `./errors.ts` and next to
 * their throwers in the backend.
 */

/** The code form every transport carries: lowercase words joined by hyphens, at most 64 characters. */
export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** How one detail value is bounded. */
export type ErrorDetailKind = "text" | "range" | "count";

/**
 * Every code the shared codec carries, with the detail keys it may name.
 *
 * Adding a code is additive on the wire (an older reader leaves it in the
 * message, where its words still match); removing or renaming one is not. A
 * code's thrower keeps its message text, and a reader that must work against
 * an older peer still falls back to that text when no code is present.
 *
 * Not yet migrated, and still read from their own message markers (follow-ups
 * that can register here): `ContainerLifecycleError:<code>:`,
 * `McpManagementError:<code>:`, `Pane layout revision conflict:`,
 * `Design revision conflict:`, `Prompt queue message conflict:`, and the node
 * refusal codes of `node-ipc.ts`.
 */
export const REGISTERED_ERROR_CODES = {
  /** The peer does not have the command (`UnknownCommandError`). */
  "unknown-command": { domain: "text", command: "text" },
  /** The call's domain version is outside the peer's range (`UnsupportedVersionError`). */
  "unsupported-version": { domain: "text", range: "range", command: "text" },
  /** The call named a critical field the peer does not know (`UnsupportedFieldError`). */
  "unsupported-field": { domain: "text", field: "text", command: "text" },
  /** A Kanban ticket, comment or image `requestId` was reused with different arguments. */
  "kanban-request-id-conflict": { record: "text" },
  /** A native job queue holds as many receipts as it may; the job was refused, not evicted. */
  "native-job-receipt-capacity": { limit: "count" },
  /** An authoritative provider probe proved that a native agent session no longer exists. */
  "native-agent-provider-session-missing": {},
} as const satisfies Record<string, Readonly<Record<string, ErrorDetailKind>>>;

export type RegisteredErrorCode = keyof typeof REGISTERED_ERROR_CODES;

/** The registered codes, in registry order. */
export const REGISTERED_ERROR_CODE_LIST = Object.keys(
  REGISTERED_ERROR_CODES,
) as readonly RegisteredErrorCode[];

/** One bounded detail value. */
export type ErrorDetailValue = string | number | { readonly min: number; readonly max: number };

/** A coded error's bounded details: only the keys registered for its code. */
export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

/** A coded error read from a value or a message. */
export interface CodedErrorParts {
  readonly code: RegisteredErrorCode;
  readonly details: ErrorDetails;
  /** The message without the code prefix. */
  readonly message: string;
}

/** The longest `text` detail value this form carries (the same bound as `details.field`). */
export const MAX_ERROR_DETAIL_TEXT_LENGTH = 64;

/** The most details one coded error carries. */
export const MAX_ERROR_DETAILS = 8;

const MAX_RANGE_BOUND = 9_999;
const MAX_COUNT = 2 ** 31 - 1;

const IPC_PREFIX = /^\[([a-z][a-z0-9-]{0,63})((?: [a-z][A-Za-z]{0,15}=[^\s\]]{0,256}){0,8})\] /;

/** Whether `code` is one of {@link REGISTERED_ERROR_CODES}. */
export function isRegisteredErrorCode(code: unknown): code is RegisteredErrorCode {
  return typeof code === "string" && Object.hasOwn(REGISTERED_ERROR_CODES, code);
}

function detailKinds(code: RegisteredErrorCode): Readonly<Record<string, ErrorDetailKind>> {
  return REGISTERED_ERROR_CODES[code];
}

function boundValue(kind: ErrorDetailKind, value: unknown): ErrorDetailValue | undefined {
  switch (kind) {
    case "text":
      return typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_ERROR_DETAIL_TEXT_LENGTH
        ? value
        : undefined;
    case "count":
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_COUNT
        ? value
        : undefined;
    case "range": {
      if (typeof value !== "object" || value === null) return undefined;
      const { min, max } = value as { min?: unknown; max?: unknown };
      const bound = (n: unknown): n is number =>
        typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_RANGE_BOUND;
      return bound(min) && bound(max) && min <= max ? { min, max } : undefined;
    }
  }
}

/**
 * The details `code` may carry, read from an untrusted object: unregistered
 * keys, values of the wrong kind and oversized text are dropped one by one,
 * so an error still says what it is without them.
 */
export function boundErrorDetails(code: RegisteredErrorCode, raw: unknown): ErrorDetails {
  const details: Record<string, ErrorDetailValue> = {};
  if (typeof raw !== "object" || raw === null) return details;
  for (const [key, kind] of Object.entries(detailKinds(code))) {
    const value = boundValue(kind, (raw as Record<string, unknown>)[key]);
    if (value !== undefined) details[key] = value;
  }
  return details;
}

function encodeValue(kind: ErrorDetailKind, value: ErrorDetailValue): string | undefined {
  switch (kind) {
    case "text":
      return typeof value === "string" && value.length > 0
        ? encodeURIComponent(value.slice(0, MAX_ERROR_DETAIL_TEXT_LENGTH))
        : undefined;
    case "count":
      return typeof value === "number" && boundValue("count", value) !== undefined
        ? String(value)
        : undefined;
    case "range": {
      const range = boundValue("range", value);
      return typeof range === "object" ? `${range.min}-${range.max}` : undefined;
    }
  }
}

function decodeValue(kind: ErrorDetailKind, raw: string): ErrorDetailValue | undefined {
  switch (kind) {
    case "text":
      try {
        return boundValue("text", decodeURIComponent(raw));
      } catch {
        return undefined;
      }
    case "count":
      return /^\d{1,10}$/.test(raw) ? boundValue("count", Number(raw)) : undefined;
    case "range": {
      const range = /^(\d{1,4})-(\d{1,4})$/.exec(raw);
      return range
        ? boundValue("range", { min: Number(range[1]), max: Number(range[2]) })
        : undefined;
    }
  }
}

/**
 * `message` led by `[code key=value …] `. A message that already has a
 * registered prefix keeps only its own text, so a relayed error is not
 * prefixed twice. Text details longer than 64 characters are cut to 64;
 * unregistered keys and malformed values are left out.
 */
export function formatIpcError(
  code: RegisteredErrorCode,
  details: Readonly<Record<string, unknown>>,
  message: string,
): string {
  const parts: string[] = [code];
  for (const [key, kind] of Object.entries(detailKinds(code))) {
    if (parts.length > MAX_ERROR_DETAILS) break;
    const value = details[key];
    if (value === undefined) continue;
    const encoded = encodeValue(kind, value as ErrorDetailValue);
    if (encoded !== undefined) parts.push(`${key}=${encoded}`);
  }
  const text = parseIpcError(message)?.message ?? message;
  return `[${parts.join(" ")}] ${text}`;
}

/** Reads the prefix form of a registered code, or `null` when `message` does not start with one. */
export function parseIpcError(message: string): CodedErrorParts | null {
  const match = IPC_PREFIX.exec(message);
  if (!match) return null;
  const code = match[1]!;
  if (!isRegisteredErrorCode(code)) return null;
  const kinds = detailKinds(code);
  const details: Record<string, ErrorDetailValue> = {};
  for (const pair of (match[2] ?? "").trim().split(" ")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at);
    const kind = Object.hasOwn(kinds, key) ? kinds[key] : undefined;
    if (kind === undefined) continue;
    const value = decodeValue(kind, pair.slice(at + 1));
    if (value !== undefined) details[key] = value;
  }
  return { code, details, message: message.slice(match[0].length) };
}

/** `message` without a registered code prefix: the thrower's own text, for display. */
export function ipcErrorText(message: string): string {
  return parseIpcError(message)?.message ?? message;
}

function messageOf(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return null;
}

/**
 * The registered code and bounded details `error` carries: its own `code`
 * property (with its `details` object, or else its own properties named like
 * the code's detail keys), or a message led by the prefix form. `null` for
 * anything else.
 */
export function codedErrorParts(error: unknown): CodedErrorParts | null {
  const message = messageOf(error);
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (isRegisteredErrorCode(code)) {
      const carried = (error as { details?: unknown }).details;
      return {
        code,
        details: boundErrorDetails(
          code,
          typeof carried === "object" && carried !== null ? carried : error,
        ),
        message: message === null ? "" : ipcErrorText(message),
      };
    }
  }
  return message === null ? null : parseIpcError(message);
}

/**
 * The error code `error` carries, from any transport, or `undefined`.
 *
 * - An own `code` property in the code form (a coded error class, a gateway
 *   body's `code` kept by `GatewayHttpError` or `NodeLink`, the preload's
 *   copy) is returned as is, registered or not.
 * - Otherwise a message led by a *registered* code's prefix (what a desktop
 *   renderer receives over IPC) gives that code. An unregistered `[word]`
 *   prefix is someone's text, not a code.
 *
 * A Node system error's `ENOENT`-style code is not in the code form and reads
 * as `undefined`. Callers that must work against an older peer fall back to
 * the message text only when this returns `undefined`.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) return code;
  }
  const message = messageOf(error);
  return message === null ? undefined : parseIpcError(message)?.code;
}

/**
 * The message `error` crosses Electron IPC with when it carries a registered
 * code (`[code key=value …] text`), or `null` when it carries none. Desktop
 * main throws this message in place of the error, because only the message
 * crosses.
 */
export function ipcErrorMessage(error: unknown): string | null {
  const coded = codedErrorParts(error);
  return coded ? formatIpcError(coded.code, coded.details, coded.message) : null;
}

// ---------------------------------------------------------------------------
// The incompatibility form (plan item 1005): the three codes above, under
// their original names.
// ---------------------------------------------------------------------------

/** The three incompatibility codes (`./errors.ts` `INCOMPATIBILITY_CODES`). */
type IpcIncompatibilityCode = "unknown-command" | "unsupported-version" | "unsupported-field";

/** The details as an IPC message carries them: still untrusted, to be bounded by the reader. */
export interface IpcIncompatibility {
  readonly code: IpcIncompatibilityCode;
  readonly details: {
    domain?: string;
    range?: { min: number; max: number };
    field?: string;
    command?: string;
  };
  /** The message without the prefix. */
  readonly message: string;
}

function isIncompatibilityCode(code: string): code is IpcIncompatibilityCode {
  return (
    code === "unknown-command" || code === "unsupported-version" || code === "unsupported-field"
  );
}

/** {@link formatIpcError} for an incompatibility code. */
export function formatIpcIncompatibility(
  code: IpcIncompatibilityCode,
  details: {
    readonly domain?: string;
    readonly range?: { readonly min: number; readonly max: number };
    readonly field?: string;
    readonly command?: string;
  },
  message: string,
): string {
  return formatIpcError(code, details, message);
}

/** {@link parseIpcError} restricted to the incompatibility codes. */
export function parseIpcIncompatibility(message: string): IpcIncompatibility | null {
  const parsed = parseIpcError(message);
  if (!parsed || !isIncompatibilityCode(parsed.code)) return null;
  return {
    code: parsed.code,
    details: parsed.details as IpcIncompatibility["details"],
    message: parsed.message,
  };
}
