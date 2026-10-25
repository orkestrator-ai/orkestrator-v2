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
  /**
   * A probe that must fail passed although the model substituted another
   * server's tool, because the session's own MCP inventory, read after the
   * turn, lists the substitute and not the probed name. Proof of absence then
   * comes from the runtime, not from the model's choice.
   */
  absenceProvenBy?: "inventory";
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
  /** Dispatch failures, provider errors and timeouts are never reachability evidence. */
  turnError?: string;
  /**
   * Server names the session's live MCP inventory reported after the turn;
   * absent when the session reports none. Used only to judge a substituted
   * call on a probe that must fail.
   */
  inventory?: readonly string[];
}): ProbeVerdict {
  const call = input.events.find((event) => event.event === "call" && event.nonce === input.nonce);
  const reached = call !== undefined;
  const answeredBy = call ? { label: call.label, tag: call.tag, pid: call.pid } : undefined;
  const replyUnavailable = input.reply.trim() === PROBE_UNAVAILABLE;
  const replyHasResult =
    call !== undefined && input.reply.includes(probeResult(call.label, call.tag, input.nonce));
  const named = probeServersInToolRows(input.toolRows ?? []);
  const substitutedBy = named.length > 0 && !named.includes(input.server) ? named[0] : undefined;
  // A model asked for a server that is gone may call the one it was renamed
  // to (OpenCode, 2026-10-21). That proves nothing about the old name by
  // itself, but the runtime's own inventory does: the substitute loaded, the
  // probed name did not.
  const absenceProvenBy =
    substitutedBy !== undefined &&
    !input.expect.reach &&
    input.turnError === undefined &&
    input.inventory !== undefined &&
    input.inventory.includes(substitutedBy) &&
    !input.inventory.includes(input.server)
      ? ("inventory" as const)
      : undefined;
  let reason: string | undefined;
  if (input.turnError !== undefined) reason = `probe turn failed: ${input.turnError}`;
  else if (absenceProvenBy) reason = undefined;
  else if (substitutedBy) {
    reason = `the model called "${substitutedBy}" instead${
      !input.expect.reach && input.inventory === undefined
        ? " (the session reported no MCP inventory to prove the old name absent)"
        : !input.expect.reach && input.inventory?.includes(input.server)
          ? ` and the session still lists "${input.server}"`
          : ""
    }`;
  } else if (!input.expect.reach) {
    if (call) reason = `the removed server "${call.label}" (${call.tag}) still answered the call`;
    else if (!replyUnavailable)
      reason = "the settled turn did not report the tool unavailable or refused";
  } else if (!call) reason = "no server logged a call with this nonce";
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
    ...(absenceProvenBy ? { absenceProvenBy } : {}),
    passed: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}

/** A pending foreground sleep with this run's unique marker, never an earlier tool row. */
export function hasRunningSleep(messages: readonly { parts?: unknown }[], marker: string): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.parts) &&
      message.parts.some((part: Record<string, unknown>) => {
        const name = String(part.toolName ?? part.tool ?? part.name ?? "");
        const state = part.toolState ?? part.state ?? part.status;
        const args = JSON.stringify(part.toolArgs ?? part.input ?? part.args ?? {});
        return (
          /^(bash|shell|exec_command|run_shell_command|execute|terminal)$/i.test(name) &&
          ["pending", "running", "in-progress"].includes(String(state)) &&
          args.includes(marker) &&
          /sleep 45/.test(args) &&
          !/run_in_background["\s:]+true/.test(args)
        );
      }),
  );
}

/** Retry ambiguous transport failures with the same request key; only a rejection permits a new key. */
export async function dispatchProbeTurn(
  dispatch: (requestId: string) => Promise<{ outcome: string; error?: string }>,
  newId: () => string,
  pause: () => Promise<void>,
): Promise<{ outcome: string; error?: string }> {
  let requestId = newId();
  let result: { outcome: string; error?: string } = { outcome: "rejected" };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      result = await dispatch(requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 2 || !/timeout|timed out|unavailable/i.test(message)) throw error;
      await pause();
      continue;
    }
    if (result.outcome !== "rejected") return result;
    requestId = newId();
    await pause();
  }
  return result;
}

/**
 * A request error without Playwright's call log, which echoes the request
 * headers and so the gateway's auth cookie into the summary and the report.
 */
export function requestErrorMessage(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const head = message.split(/\r?\n\s*Call log:/)[0]!.trim();
  return `${command}: ${head.replace(/orkestrator_gateway_auth=[^\s;]+/g, "orkestrator_gateway_auth=<redacted>")}`;
}

/**
 * Invoke one backend command. A read (`get_…`/`list_…`) is retried when the
 * connection resets before a response: it changes nothing, so a reused socket
 * the gateway already closed must not end a run that is many billed turns in.
 * A mutation is never retried here.
 */
export async function invokeCommand<T>(
  command: string,
  send: () => Promise<T>,
  pause: () => Promise<void>,
  attempts = 3,
): Promise<T> {
  const readOnly = /^(get|list)_/.test(command);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reset = /ECONNRESET|socket hang up|EPIPE/.test(message);
      if (!readOnly || !reset || attempt >= attempts) {
        throw new Error(requestErrorMessage(command, error));
      }
      await pause();
    }
  }
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
