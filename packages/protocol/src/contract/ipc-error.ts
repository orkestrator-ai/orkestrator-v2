/**
 * The message form of a typed incompatibility error across Electron IPC (plan
 * item 1005, docs/reports/unified-federation.md §11.2).
 *
 * Electron passes only an error's message from main to the preload, and the
 * context bridge drops an error's custom properties on the way to the
 * renderer, so the code and the bounded details travel in the message. This
 * extends 2007's `[code] text` refusal convention (`node-ipc.ts`) with
 * `key=value` details inside the brackets:
 *
 *     [unsupported-version domain=git range=1-3 command=get_x] Domain git …
 *
 * Values are `encodeURIComponent`-encoded, so a value never holds a space or
 * a `]`. The keys are `domain`, `range` (`min-max`), `field` and `command`,
 * the same bounded members as the JSON body's `details`; never an argument
 * value. `incompatibility()` (`./errors.ts`) reads this form, so the renderer
 * needs no rebuild step; the preload also copies it to `error.code` and
 * `error.details` for code in its own world.
 *
 * No Effect import: the sandboxed preload bundle uses this module.
 */
import type { IncompatibilityCode, IncompatibilityDetails } from "./errors.js";

const CODES: ReadonlySet<string> = new Set([
  "unknown-command",
  "unsupported-version",
  "unsupported-field",
]);

const IPC_PREFIX =
  /^\[(unknown-command|unsupported-version|unsupported-field)((?: [a-z]{1,16}=[^\s\]]{0,256}){0,8})\] /;

/** The longest detail value this form carries (the same bound as `details.field`). */
const MAX_VALUE_LENGTH = 64;

/** The details as an IPC message carries them: still untrusted, to be bounded by the reader. */
export interface IpcIncompatibility {
  readonly code: IncompatibilityCode;
  readonly details: {
    domain?: string;
    range?: { min: number; max: number };
    field?: string;
    command?: string;
  };
  /** The message without the prefix. */
  readonly message: string;
}

function encode(value: string): string {
  return encodeURIComponent(value.slice(0, MAX_VALUE_LENGTH));
}

/**
 * `message` led by `[code key=value …] `. A message that already has the
 * prefix keeps only its own text, so a relayed error is not prefixed twice.
 */
export function formatIpcIncompatibility(
  code: IncompatibilityCode,
  details: IncompatibilityDetails & { readonly command?: string },
  message: string,
): string {
  const parts: string[] = [code];
  if (details.domain !== undefined) parts.push(`domain=${encode(details.domain)}`);
  if (details.range !== undefined) parts.push(`range=${details.range.min}-${details.range.max}`);
  if (details.field !== undefined) parts.push(`field=${encode(details.field)}`);
  if (details.command !== undefined) parts.push(`command=${encode(details.command)}`);
  const text = parseIpcIncompatibility(message)?.message ?? message;
  return `[${parts.join(" ")}] ${text}`;
}

function decode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= MAX_VALUE_LENGTH ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the prefix form, or `null` when `message` does not start with it. */
export function parseIpcIncompatibility(message: string): IpcIncompatibility | null {
  const match = IPC_PREFIX.exec(message);
  if (!match) return null;
  const code = match[1]!;
  if (!CODES.has(code)) return null;
  const details: IpcIncompatibility["details"] = {};
  for (const pair of (match[2] ?? "").trim().split(" ")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    if (key === "range") {
      const range = /^(\d{1,4})-(\d{1,4})$/.exec(raw);
      if (range) details.range = { min: Number(range[1]), max: Number(range[2]) };
      continue;
    }
    if (key !== "domain" && key !== "field" && key !== "command") continue;
    const value = decode(raw);
    if (value !== undefined) details[key] = value;
  }
  return {
    code: code as IncompatibilityCode,
    details,
    message: message.slice(match[0].length),
  };
}
