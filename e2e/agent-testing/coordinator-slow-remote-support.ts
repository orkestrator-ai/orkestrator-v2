/**
 * Pure helpers for `coordinator-slow-remote-live.spec.ts` (to-do 4720) and its
 * fake model: the delayed SSH shim each fixture checkout fetches through, the
 * shim's invocation record, the backend log lines the run checks, and which
 * model requests the fake parks. Nothing here runs at import time.
 */

export const FAKE_MODEL_ID = "slow-remote-1";
export const FAKE_REPLY = "Noted.";
/** A user message carrying this keeps its turn running until the spec releases it. */
export const HOLD_MARKER = "[slow-remote:hold]";

/** One single-quoted shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The executable `core.sshCommand` for one fixture checkout. It serves only
 * its own bare repository, records one line per invocation (the start time
 * in milliseconds, never its arguments or anything it transfers) and, while
 * the delay marker exists, sleeps first. Git runs it with `ssh.variant
 * simple`, so its arguments are the host and the remote command.
 */
export function slowSshShimScript(options: {
  bareRepository: string;
  invocations: string;
  delayMarker: string;
  delaySeconds: number;
}): string {
  if (!Number.isInteger(options.delaySeconds) || options.delaySeconds <= 0) {
    throw new Error("delaySeconds must be a positive integer");
  }
  return [
    "#!/bin/sh",
    // Milliseconds where date supports %3N (GNU); whole seconds elsewhere.
    `started=$(date +%s%3N); case "$started" in *N) started="$(date +%s)000";; esac`,
    `printf '%s\\n' "$started" >> ${shellQuote(options.invocations)}`,
    `if [ -e ${shellQuote(options.delayMarker)} ]; then sleep ${options.delaySeconds}; fi`,
    `exec git-upload-pack ${shellQuote(options.bareRepository)}`,
    "",
  ].join("\n");
}

/** The start times (ms since the epoch) the shim recorded, oldest first. */
export function parseShimInvocations(text: string): number[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{13}$/.test(line))
    .map(Number);
}

/** One backend log entry: its area, event and scalar fields. */
export interface LogEntry {
  area: string;
  event: string;
  fields: Record<string, string>;
}

/**
 * The entries for `area`/`event` in backend log text. Reads both formats the
 * backend writes: text (`[area] event key=value key="quoted value"`) and JSON
 * lines (`{"orklog":1,"area":…,"event":…,"fields":{…}}`).
 */
export function findLogEntries(text: string, area: string, event: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as {
          area?: unknown;
          event?: unknown;
          fields?: Record<string, unknown>;
        };
        if (parsed.area === area && parsed.event === event) {
          entries.push({
            area,
            event,
            fields: Object.fromEntries(
              Object.entries(parsed.fields ?? {}).map(([key, value]) => [key, String(value)]),
            ),
          });
        }
      } catch {
        // Not a log entry.
      }
      continue;
    }
    const prefix = `[${area}] ${event}`;
    const at = trimmed.indexOf(prefix);
    if (at < 0) continue;
    const rest = trimmed.slice(at + prefix.length);
    if (rest !== "" && !rest.startsWith(" ")) continue;
    const fields: Record<string, string> = {};
    for (const match of rest.matchAll(/([A-Za-z0-9_.]+)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
      const raw = match[2]!;
      fields[match[1]!] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
    }
    entries.push({ area, event, fields });
  }
  return entries;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

function latestUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | null;
    if (message?.role === "user") return messageText(message.content);
  }
  return undefined;
}

/** Whether the fake parks this request: its latest user message carries the hold marker. */
export function shouldHold(messages: unknown): boolean {
  return latestUserText(messages)?.includes(HOLD_MARKER) ?? false;
}

/** The mail a worker is asked to send: who to and from, as Orkestrator mailbox addresses. */
export interface MailInstruction {
  toEnvironmentId: string;
  toTabId: string;
  fromTabId: string;
}

const ADDRESS = "[A-Za-z0-9:._-]{1,200}";
const MAIL_MARKER = new RegExp(
  `\\[slow-remote:mail to=(${ADDRESS}) tab=(${ADDRESS}) from=(${ADDRESS})\\]`,
);

/** The marker a worker prompt carries to make the fake send one mail. */
export function mailMarker(instruction: MailInstruction): string {
  const marker = `[slow-remote:mail to=${instruction.toEnvironmentId} tab=${instruction.toTabId} from=${instruction.fromTabId}]`;
  if (!MAIL_MARKER.test(marker)) throw new Error("mailbox address is not markable");
  return marker;
}

export function parseMailInstruction(text: string): MailInstruction | undefined {
  const match = MAIL_MARKER.exec(text);
  return match
    ? { toEnvironmentId: match[1]!, toTabId: match[2]!, fromTabId: match[3]! }
    : undefined;
}

export const MAIL_TOOL = "send_message";
export const MAIL_BODY = "Two commits landed upstream; please take a look.";

export type FakeStep =
  { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

function offersTool(tools: unknown, name: string): boolean {
  return (
    Array.isArray(tools) &&
    tools.some(
      (tool) =>
        (tool as { function?: { name?: unknown } } | null)?.function?.name === name ||
        (tool as { name?: unknown } | null)?.name === name,
    )
  );
}

/**
 * What the fake answers. A worker prompt with a mail marker sends that mail
 * once through Orkestrator's `send_message` tool; everything else, including
 * the request after the tool's result, is a short text reply.
 */
export function scriptedStep(input: { messages: unknown; tools: unknown }): FakeStep {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const last = messages[messages.length - 1] as { role?: unknown } | undefined;
  const instruction = parseMailInstruction(latestUserText(messages) ?? "");
  if (instruction && last?.role === "user" && offersTool(input.tools, MAIL_TOOL)) {
    return {
      kind: "tool",
      name: MAIL_TOOL,
      input: {
        requestId: `slow-remote-${instruction.fromTabId}`,
        fromTabId: instruction.fromTabId,
        toEnvironmentId: instruction.toEnvironmentId,
        toTabId: instruction.toTabId,
        body: MAIL_BODY,
      },
    };
  }
  return { kind: "text", text: FAKE_REPLY };
}
