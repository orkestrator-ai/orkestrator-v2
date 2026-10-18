/**
 * Pure helpers for the live MCP apply probes (`mcp-apply-live.spec.ts`): the
 * probe server's log, the prompt and the verdict on one probe call. Kept
 * apart from the spec so the verdict rules have unit tests that run without a
 * profile or a provider.
 */

/** One line of `mcp-probe-server.mjs`'s log. */
export interface ProbeLogEvent {
  event: "start" | "call" | "exit";
  label: string;
  tag: string;
  pid: number;
  at: string;
  nonce?: string;
  transport?: string;
  reason?: string;
}

export function parseProbeLog(text: string): ProbeLogEvent[] {
  const events: ProbeLogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<ProbeLogEvent>;
      if (
        (value.event === "start" || value.event === "call" || value.event === "exit") &&
        typeof value.label === "string" &&
        typeof value.tag === "string" &&
        typeof value.pid === "number"
      ) {
        events.push(value as ProbeLogEvent);
      }
    } catch {
      // A line torn by a concurrent append is not evidence either way.
    }
  }
  return events;
}

/** The result line the probe tool answers with. */
export function probeResult(label: string, tag: string, nonce: string): string {
  return `MCPQ-RESULT ${label} ${tag} ${nonce}`;
}

export const PROBE_UNAVAILABLE = "MCPQ-UNAVAILABLE";

/**
 * The same prompt asks for an available and for a removed server, so a model
 * is never told which answer is expected. Whether the call happened is read
 * from the server's log, not from this reply.
 */
export function probePrompt(server: string, nonce: string): string {
  return [
    `Call the MCP tool named "probe" that belongs to the MCP server named "${server}", exactly once, with the argument nonce set to "${nonce}".`,
    // Code-mode Codex models reach MCP tools only from a code cell, and a
    // model offered a way out takes it without looking (codex 0.162.1).
    "Look for it in your complete tool list first, including tools reachable only through tool search or from code (such as ALL_TOOLS and tools.* in a code cell).",
    "Then reply with only the exact text that tool returned.",
    `If no such tool exists, or the call fails or is refused, reply with exactly ${PROBE_UNAVAILABLE}.`,
    "Do not call any other MCP tool, and do not call a probe tool of any other server.",
  ].join(" ");
}

/**
 * `label` is the server's own `--label`, which a rename does not change, so a
 * renamed entry is expected to answer with its original label.
 */
export type ProbeExpectation = { reach: true; tag: string; label?: string } | { reach: false };

export interface ProbeVerdict {
  /** The server process logged a call carrying this nonce. */
  reached: boolean;
  /** Which server label and tag answered, when it was reached. */
  answeredBy?: { label: string; tag: string; pid: number };
  /** The reply carried the exact result line for this nonce. */
  replyHasResult: boolean;
  replyUnavailable: boolean;
  /**
   * The turn's tool rows named only a different probe server: the model
   * called that one instead (a renamed entry's process keeps its old label,
   * so only the tool name tells the two apart).
   */
  substitutedBy?: string;
  passed: boolean;
  reason?: string;
}

/** Probe server names that tool rows mention (`mcp__x__probe`, `x_probe`, …). */
export function probeServersInToolRows(rows: readonly string[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    for (const match of row.matchAll(/mq[ulpxs]\d*_[a-z]+/g)) names.add(match[0]);
  }
  return [...names];
}

/**
 * Judge one probe call. Reaching the server is decided only by its log; the
 * reply must also carry the result for a call that should succeed, so a tool
 * that ran but whose answer never reached the model is not a pass either.
 */
export function judgeProbe(input: {
  events: readonly ProbeLogEvent[];
  server: string;
  nonce: string;
  reply: string;
  expect: ProbeExpectation;
  /** Tool rows of the turn, as `type:name:state`; names only. */
  toolRows?: readonly string[];
}): ProbeVerdict {
  const call = input.events.find((event) => event.event === "call" && event.nonce === input.nonce);
  const reached = call !== undefined;
  const answeredBy = call ? { label: call.label, tag: call.tag, pid: call.pid } : undefined;
  const replyUnavailable = input.reply.includes(PROBE_UNAVAILABLE);
  const replyHasResult =
    call !== undefined && input.reply.includes(probeResult(call.label, call.tag, input.nonce));
  const named = probeServersInToolRows(input.toolRows ?? []);
  const substitutedBy = named.length > 0 && !named.includes(input.server) ? named[0] : undefined;
  if (!input.expect.reach) {
    // A call the model made through another server's tool does not show the
    // removed name was still offered; the tool rows say which tool ran.
    const removedAnswered = reached && !substitutedBy;
    return {
      reached,
      ...(answeredBy ? { answeredBy } : {}),
      replyHasResult,
      replyUnavailable,
      ...(substitutedBy ? { substitutedBy } : {}),
      passed: !removedAnswered,
      ...(removedAnswered
        ? { reason: `the removed server "${call!.label}" (${call!.tag}) still answered the call` }
        : {}),
    };
  }
  let reason: string | undefined;
  if (!call) reason = "no server logged a call with this nonce";
  else if (substitutedBy) reason = `the model called "${substitutedBy}" instead`;
  else if (call.label !== (input.expect.label ?? input.server))
    reason = `server "${call.label}" answered instead of "${input.expect.label ?? input.server}"`;
  else if (call.tag !== input.expect.tag)
    reason = `the server ran configuration ${call.tag}, not ${input.expect.tag}`;
  else if (!replyHasResult) reason = "the server ran the call but the reply lacks its result";
  return {
    reached,
    ...(answeredBy ? { answeredBy } : {}),
    replyHasResult,
    replyUnavailable,
    ...(substitutedBy ? { substitutedBy } : {}),
    passed: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}

/** Apply states that are still moving; anything else is an outcome. */
export const TRANSIENT_APPLY_STATES: ReadonlySet<string> = new Set([
  "queued",
  "applying",
  "reconciling",
]);

/** Names this probe creates, so a run can clear what an interrupted one left. */
export const PROBE_SERVER_NAME = /^mq[ulpxs]\d*_[a-z]+$/;

/** A short server-name prefix per writable scope, so scopes never collide. */
export function scopePrefix(scope: string, index: number): string {
  const short =
    scope === "backend-user"
      ? "u"
      : scope === "claude-local"
        ? "l"
        : scope === "project"
          ? "p"
          : "x";
  return `mq${short}${index}`;
}
