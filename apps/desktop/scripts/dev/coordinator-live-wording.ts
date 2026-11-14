import type { CoordinatorLiveCheck } from "./coordinator-live.js";
import type { RoutingToolCall } from "./coordinator-live-routing.js";

/**
 * Whether a real coordinator follows the tool-surface wording that coordinator
 * report C4 added (to-do 4920 task 3): the launch-defaults rule
 * (`COORDINATOR_LAUNCH_DEFAULTS_RULE`), the request-id rule
 * (`COORDINATOR_REQUEST_ID_RULE`) and the advice not to poll `list_agents`.
 *
 * Judged on the `routing` scenario, whose requests name no agent, model or
 * effort, so any of those fields on a launch is the coordinator's own choice.
 * The verdicts read only tool names and argument fields; no argument value is
 * recorded in a check's detail.
 *
 * Nothing here may use Bun APIs.
 */

/** Launch tools whose agent fields the defaults rule says to omit. */
const LAUNCH_TOOLS = ["launch_environment", "launch_job"] as const;

/** The launch fields the defaults rule says to omit unless the user asked. */
export const LAUNCH_DEFAULT_FIELDS = ["agent", "modelId", "reasoningId"] as const;

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail } : {}) };
}

/**
 * Launches leave `agent`, `modelId` and `reasoningId` out when the user named
 * none. A case with no launch passes: whether it delegated at all is the
 * case's own check.
 */
export function evaluateLaunchDefaultsOmitted(
  prefix: string,
  calls: readonly RoutingToolCall[],
): CoordinatorLiveCheck {
  const launches = calls.filter((call) => (LAUNCH_TOOLS as readonly string[]).includes(call.tool));
  if (launches.length === 0) return check(`${prefix}-launch-defaults-omitted`, true, "no launches");
  // A failed call may come back with no arguments; only a launch that ran is judged unreadable.
  const unreadable = launches.filter(
    (call) => call.args === undefined && call.state === "success",
  ).length;
  const chosen = new Set(
    launches.flatMap((call) =>
      LAUNCH_DEFAULT_FIELDS.filter((field) => call.args?.[field] !== undefined),
    ),
  );
  return check(
    `${prefix}-launch-defaults-omitted`,
    unreadable === 0 && chosen.size === 0,
    unreadable > 0
      ? `${unreadable} of ${launches.length} launches had unreadable arguments`
      : chosen.size > 0
        ? `${launches.length} launches; set ${[...chosen].join(", ")} though the user named none`
        : `${launches.length} launches, none set ${LAUNCH_DEFAULT_FIELDS.join(", ")}`,
  );
}

/** Keys sorted at every depth, so two spellings of one payload compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A call's intent: its tool and every argument but the request id. */
function intent(call: RoutingToolCall): string {
  const rest: Record<string, unknown> = { ...call.args };
  delete rest.requestId;
  return `${call.tool} ${stableJson(rest)}`;
}

export interface RequestIdUsage {
  /** Calls that carried a request id. */
  withRequestId: number;
  /** Distinct request ids among them. */
  distinct: number;
  /** Calls that repeated an earlier call exactly, the one allowed reuse. */
  retries: number;
  /** Request ids that named two different calls. */
  reused: number;
}

/** How a scenario's calls used request ids. Counts only; no id is returned. */
export function requestIdUsage(calls: readonly RoutingToolCall[]): RequestIdUsage {
  const byId = new Map<string, string[]>();
  for (const call of calls) {
    const id = call.args?.requestId;
    if (typeof id !== "string" || id.length === 0) continue;
    const intents = byId.get(id) ?? [];
    intents.push(intent(call));
    byId.set(id, intents);
  }
  let withRequestId = 0;
  let retries = 0;
  let reused = 0;
  for (const intents of byId.values()) {
    withRequestId += intents.length;
    const kinds = new Set(intents);
    retries += intents.length - kinds.size;
    if (kinds.size > 1) reused += 1;
  }
  return { withRequestId, distinct: byId.size, retries, reused };
}

/**
 * Each new action gets a new request id. Sending the same call again under
 * its id (a retry after an ambiguous answer) is allowed; one id naming two
 * different calls is not.
 */
export function evaluateRequestIdsFresh(calls: readonly RoutingToolCall[]): CoordinatorLiveCheck {
  const usage = requestIdUsage(calls);
  return check(
    "request-ids-fresh",
    usage.withRequestId > 0 && usage.reused === 0,
    usage.withRequestId === 0
      ? "no call carried a request id"
      : `${usage.withRequestId} calls with ${usage.distinct} request ids, ${usage.retries} exact retries, ${usage.reused} ids reused for another call`,
  );
}

/**
 * The coordinator does not poll `list_agents`: at most one read per case. It
 * is woken when a worker has something to say.
 */
export function evaluateListAgentsNotPolled(
  prefix: string,
  calls: readonly RoutingToolCall[],
): CoordinatorLiveCheck {
  const reads = calls.filter((call) => call.tool === "list_agents").length;
  return check(`${prefix}-list-agents-not-polled`, reads <= 1, `${reads} list_agents calls`);
}
