/**
 * Shell output that is waiting for a person.
 *
 * A command that prints a sign-in link, a device code, "Press ENTER", a
 * password prompt or an SSH host-key question is blocked on the user, and the
 * user is usually looking at a different tab. These helpers recognise those
 * prompts in raw terminal output so the tab and its coordinator can show one
 * actionable item: the link to open, the code to enter, what to answer.
 *
 * Detection is deliberately conservative. A link counts only when its host is
 * a known sign-in host or the text around it says to sign in or authenticate,
 * so an ordinary URL in build output is never a prompt. A question (password,
 * host key, ENTER) counts only on the last, unterminated line or with an
 * explicit wording that only interactive prompts use.
 *
 * Browser-safe: no Node imports. Output may contain secrets, so callers must
 * not log what these return (see AGENTS.md, invariant 12).
 */

export type HumanPromptKind = "sign-in" | "device-code" | "press-enter" | "secret" | "host-key";

export interface HumanPrompt {
  /** Strongest kind found: host-key > secret > sign-in/device-code > press-enter. */
  kind: HumanPromptKind;
  /** The sign-in or verification link to open, when there is one. */
  url?: string;
  /** A one-time or device code the user must enter on that page. */
  code?: string;
  /** Wants a keypress (ENTER) on the command itself. */
  wantsEnter: boolean;
  /** One short line for the notification: the prompt text, trimmed and bounded. */
  text: string;
  /** Stable identity of this prompt, so the same prompt is announced once. */
  key: string;
}

export const HUMAN_PROMPT_SCAN_BYTES = 16 * 1024;
const MAX_TEXT = 200;

/** Hosts (and optional path prefixes) whose links are sign-in or device flows. */
const SIGN_IN_LINKS: ReadonlyArray<{ host: RegExp; path?: RegExp }> = [
  { host: /^(www\.)?npmjs\.com$/i, path: /^\/(login|auth)\b/i },
  { host: /^github\.com$/i, path: /^\/login\/(device|oauth)\b/i },
  { host: /^login\.tailscale\.com$/i },
  { host: /^(appleid|idmsa|account)\.apple\.com$/i },
  { host: /^accounts\.google\.com$/i },
  {
    host: /^(login\.microsoftonline\.com|microsoft\.com|www\.microsoft\.com)$/i,
    path: /^\/(devicelogin|common|organizations|[\w-]+\/oauth2)\b/i,
  },
  { host: /^device\.sso\.[\w-]+\.amazonaws\.com$/i },
  { host: /^[\w-]+\.awsapps\.com$/i, path: /^\/start\b/i },
  { host: /^(www\.)?vercel\.com$/i, path: /^\/(oauth\/device|login|api\/registration)\b/i },
  { host: /^(claude\.ai|console\.anthropic\.com)$/i, path: /^\/oauth\b/i },
  { host: /^auth\.openai\.com$/i },
  { host: /^(gitlab\.com)$/i, path: /^\/oauth\b/i },
  { host: /^(www\.)?docker\.com$/i, path: /^\/(activate|login)\b/i },
  { host: /^login\.docker\.com$/i },
  { host: /^(www\.)?fly\.io$/i, path: /^\/app\/auth\b/i },
  { host: /^dash\.cloudflare\.com$/i, path: /^\/oauth2\b/i },
];

/** Words on the link's line (or the line before it) that make any link a sign-in link. */
const SIGN_IN_CONTEXT =
  /\b(log ?in at|login at|sign[ -]?in|authenticate|authorize|authori[sz]ation|to (log ?in|verify|continue),? (visit|open|go to)|verification (url|uri|link)|device (login|code))\b/i;

/** "Press ENTER" (any case) waiting on the command. */
const PRESS_ENTER = /\bpress\s+(\[?enter\]?|return)\b/i;

/** A one-time or device code, e.g. "one-time code: 1A2B-3C4D". */
const CODE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:one-time|device|user|verification|pairing)\s+code(?:\s+is)?\s*[:=]?\s*([A-Z0-9]{4,10}(?:-[A-Z0-9]{3,10}){0,2})\b/i,
  /\benter\s+(?:the\s+|this\s+)?code\s*[:=]?\s*([A-Z0-9]{4,10}(?:-[A-Z0-9]{3,10}){0,2})\b/i,
  /\bcode\s*[:=]\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
];

/** Password, passphrase, PIN and token prompts, as interactive tools word them. */
const SECRET_PROMPT =
  /^(?:\[sudo\]\s+)?(?:enter\s+)?(?:(?:the\s+)?(?:new\s+)?(?:password|passphrase|passcode|pin|one-time password|otp|2fa code|authentication code)\b[^:\n]{0,120}|(?:password|username) for (?:'[^'\n]{1,160}'|[^:\n]{1,120})|[^\s@]{1,64}@[^\s']{1,120}'s password|enter (?:passphrase|pin) for [^:\n]{1,160}):\s*$/i;

const HOST_KEY =
  /are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\??\s*$|the authenticity of host .{1,200} can't be established/i;

/** Remove ANSI/OSC escapes and resolve carriage-return overwrites line by line. */
export function normalizeTerminalText(raw: string): string {
  const withoutEscapes = raw
    // OSC (e.g. hyperlinks, titles) terminated by BEL or ST.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // CSI and other two-byte escapes.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
  return withoutEscapes
    .split("\n")
    .map((line) => {
      const trimmedEnd = line.replace(/\r+$/, "");
      const segments = trimmedEnd.split("\r");
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}

const URL_PATTERN = /\bhttps:\/\/[^\s"'<>`)\]}]+/g;

function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/, "");
}

function isSignInLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return SIGN_IN_LINKS.some(
    (entry) =>
      entry.host.test(parsed.hostname) && (!entry.path || entry.path.test(parsed.pathname)),
  );
}

function bounded(line: string): string {
  const text = line.trim().replace(/\s+/g, " ");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/**
 * The prompt the output's tail is waiting on, or `null`.
 *
 * Only the last `HUMAN_PROMPT_SCAN_BYTES` are read. `final` says the command
 * has exited: nothing is waiting any more, so this returns `null`.
 */
export function detectHumanPrompt(
  raw: string,
  options: { final?: boolean } = {},
): HumanPrompt | null {
  if (options.final) return null;
  const tail = raw.length > HUMAN_PROMPT_SCAN_BYTES ? raw.slice(-HUMAN_PROMPT_SCAN_BYTES) : raw;
  const text = normalizeTerminalText(tail);
  const lines = text.split("\n");
  // The line the cursor is on: the prompt a command is blocked reading on.
  const unterminated = text.endsWith("\n") ? "" : (lines[lines.length - 1] ?? "");

  let url: string | undefined;
  let urlLine = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const match of line.matchAll(URL_PATTERN)) {
      const candidate = cleanUrl(match[0]);
      const context = `${lines[index - 1] ?? ""}\n${line}`;
      if (isSignInLink(candidate) || SIGN_IN_CONTEXT.test(context)) {
        // The latest link wins: a retried login prints a new one.
        url = candidate;
        urlLine =
          SIGN_IN_CONTEXT.test(line) || !lines[index - 1]?.trim()
            ? line
            : `${lines[index - 1]} ${line}`;
      }
    }
  }

  let code: string | undefined;
  for (const line of lines) {
    for (const pattern of CODE_PATTERNS) {
      const match = pattern.exec(line);
      // A code is digits and letters, never a plain word like "below".
      if (match?.[1] && /\d/.test(match[1])) code = match[1].toUpperCase();
    }
  }

  const hostKeyLine = lines.findLast((line) => HOST_KEY.test(line));
  const hostKey =
    hostKeyLine !== undefined &&
    /are you sure you want to continue connecting/i.test(unterminated || hostKeyLine)
      ? unterminated || hostKeyLine
      : undefined;
  const secret = SECRET_PROMPT.test(unterminated.trim()) ? unterminated : undefined;
  const enterLine = lines.findLast((line) => PRESS_ENTER.test(line));
  const wantsEnter = enterLine !== undefined;

  let kind: HumanPromptKind;
  let line: string;
  if (hostKey) {
    kind = "host-key";
    line = hostKey;
  } else if (secret) {
    kind = "secret";
    line = secret;
  } else if (url) {
    kind = code ? "device-code" : "sign-in";
    line = urlLine;
  } else if (code && wantsEnter) {
    kind = "device-code";
    line = enterLine!;
  } else if (wantsEnter && PRESS_ENTER.test(unterminated)) {
    // A bare "Press ENTER" only counts while the command sits on it.
    kind = "press-enter";
    line = unterminated;
  } else {
    return null;
  }
  const summary = bounded(line);
  return {
    kind,
    ...(url ? { url } : {}),
    ...(code ? { code } : {}),
    wantsEnter,
    text: summary,
    key: [
      kind,
      url ?? "",
      code ?? "",
      kind === "secret" || kind === "host-key" ? summary : "",
    ].join("\u0000"),
  };
}

/**
 * Incremental detection over a live output stream.
 *
 * Keeps a bounded tail and reports a prompt only when it differs from the last
 * one reported, so a command that redraws its prompt is announced once. A
 * prompt that disappears (the user answered, the command moved on) reports
 * `cleared` once.
 */
export class HumanPromptScanner {
  private tail = "";
  private current: HumanPrompt | null = null;

  /** Feed output; returns what changed, or `null` when nothing did. */
  push(chunk: string): { prompt: HumanPrompt } | { cleared: true } | null {
    this.tail = (this.tail + chunk).slice(-HUMAN_PROMPT_SCAN_BYTES);
    return this.update(detectHumanPrompt(this.tail));
  }

  /** Replace the observed output wholesale (a tool part re-rendered in full). */
  replace(output: string): { prompt: HumanPrompt } | { cleared: true } | null {
    this.tail = output.slice(-HUMAN_PROMPT_SCAN_BYTES);
    return this.update(detectHumanPrompt(this.tail));
  }

  /** The command exited; whatever was waiting is gone. */
  finish(): { cleared: true } | null {
    this.tail = "";
    const change = this.update(null);
    return change && "cleared" in change ? change : null;
  }

  get prompt(): HumanPrompt | null {
    return this.current;
  }

  private update(next: HumanPrompt | null): { prompt: HumanPrompt } | { cleared: true } | null {
    if (next && next.key === this.current?.key) return null;
    if (!next) {
      if (!this.current) return null;
      // A sign-in link stays relevant after its "Press ENTER" scrolls away;
      // only a newer prompt or the command's exit replaces it.
      if (this.current.url && this.tail) return null;
      this.current = null;
      return { cleared: true };
    }
    this.current = next;
    return { prompt: next };
  }
}

/** Where a waiting prompt was seen. */
export type HumanPromptSource = "user-command" | "agent-tool" | "agent-background-task";

/**
 * One prompt waiting on the user, as the backend tracks it: the tab and the
 * command it belongs to. Cleared when that command exits or moves on.
 */
export interface HumanPromptEntry {
  /** Stable for one source: the user command, tool call or task id. */
  id: string;
  environmentId: string;
  tabId: string;
  source: HumanPromptSource;
  /** The user command id, when `source` is `user-command` (input can be sent). */
  userCommandId?: string;
  /** The command line, when known: shown so the user knows what is asking. */
  command?: string;
  prompt: HumanPrompt;
  since: string;
}

export interface HumanPromptList {
  prompts: HumanPromptEntry[];
}
