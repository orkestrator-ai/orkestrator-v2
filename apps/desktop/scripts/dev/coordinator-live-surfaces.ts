import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { normalizeTerminalText } from "@orkestrator/protocol/human-prompts";
import {
  escapedInteractionFailures,
  type CoordinatorLiveCheck,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import {
  orkestratorToolCalls,
  type DelegationMailMessage,
  type DelegationObservation,
} from "./coordinator-live-delegation.js";

/**
 * The `surfaces` scenario (to-do 0395 task 4): a main coordinator calls the
 * worker-surface tools once each on a worker of its own node, and the user's
 * approval copies an uncommitted checkout file into that worker.
 *
 * The harness makes the worker itself (no agent turn in it) and writes one
 * untracked file into the checkout. One coordinator turn then calls, in order:
 * `launch_terminal` (a plain tab running one `echo`), `open_worker_browser`
 * (a loopback address), `list_tabs`, `edit_worker_tab` to focus the terminal
 * tab, `edit_worker_tab` to close the browser tab, and `request_root_changes`
 * naming the untracked file. The harness approves the request the way the
 * user does, in the approval dialog, and the coordinator must be woken once
 * with the outcome.
 *
 * Passing means: every call returned without error; `list_tabs` listed both
 * tabs the turn opened; the terminal tab's output shows the line its `echo`
 * printed (so the command ran, not only the tab opened); afterwards the
 * worker's layout holds the terminal tab, selected, and no longer the browser tab; the request was approved and ran;
 * the file landed in the worker byte for byte; the checkout is unchanged; one
 * wake followed the approval; nothing escaped the coordinator policy.
 *
 * Left out on purpose: `move` (a fresh worker has one pane, so there is
 * nowhere to move a tab), and the Multi Review and feature-plan surfaces,
 * which need a finished review panel or a planning agent's own turns. The
 * manual checklist's 0142 item covers those on real providers.
 *
 * This module holds the prompts and the verdict; the spec and its
 * orchestration (`coordinator-live-surfaces-orchestration.ts`) share it.
 * Nothing here may use Bun APIs.
 */

export interface SurfacesProbe {
  platform: AgentPlatform;
  /** Random hex; the worker's name, the checkout file and the terminal command carry it. */
  token: string;
  workerEnvironmentId: string;
}

/**
 * Whether the scenario runs on `platform`. Claude only (to-do 0395 task 4):
 * the tools are Control MCP calls, so the provider matters little, and one
 * run covers every tool without a billed turn per platform. Other platforms
 * record a skip.
 */
export function surfacesApplies(platform: AgentPlatform): boolean {
  return platform === "claude";
}

/** The tools the turn calls, in order; `edit_worker_tab` twice. */
export const SURFACES_TOOLS = [
  "launch_terminal",
  "open_worker_browser",
  "list_tabs",
  "edit_worker_tab",
  "request_root_changes",
] as const;

/** A loopback address no worker serves; the tab opens whether or not it loads. */
export const SURFACES_BROWSER_URL = "http://localhost:4799/";

export function surfacesWorkerName(token: string): string {
  return `surfaces-${token}`;
}

/** The untracked checkout file the root-changes request copies. */
export function surfacesRootFile(token: string): { path: string; content: string } {
  return {
    path: `coordinator-surfaces-${token}.txt`,
    content: `coordinator surfaces root change ${token}\n`,
  };
}

export function surfacesTerminalTitle(token: string): string {
  return `surfaces-terminal-${token}`;
}

/** The line the terminal's `echo` prints; the command line itself also carries `echo`. */
export function surfacesTerminalMarker(token: string): string {
  return `surfaces-${token}`;
}

/**
 * The terminal session of a tab in the surfaces worker, which is always local
 * (`surfacesWorkerInput`); the same id `terminalSessionId` gives the backend.
 */
export function surfacesTerminalSessionId(workerEnvironmentId: string, tabId: string): string {
  return `local-${workerEnvironmentId}:${tabId}`;
}

/**
 * Whether raw terminal output shows `token`'s marker as a whole line of what a
 * person would see. A whole line, so the echoed command (`$ echo surfaces-…`)
 * does not count: only the line the command printed does.
 */
export function terminalShowsMarker(output: string, token: string): boolean {
  const marker = surfacesTerminalMarker(token);
  return normalizeTerminalText(output)
    .split("\n")
    .some((line) => line.trim() === marker);
}

/** `create_environment` arguments for the worker: ordinary, local, no agent. */
export function surfacesWorkerInput(input: {
  projectId: string;
  token: string;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    name: surfacesWorkerName(input.token),
    environmentType: "local",
    networkAccessMode: "restricted",
  };
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's worker surfaces conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";

export function surfacesPrompt(probe: SurfacesProbe): string {
  const worker = `environmentId "${probe.workerEnvironmentId}"`;
  const file = surfacesRootFile(probe.token).path;
  return [
    HARNESS_PREAMBLE,
    "",
    "Call these Orkestrator tools once each, in this order, and nothing else. Use a fresh requestId wherever a tool takes one.",
    `1. launch_terminal with ${worker}, tabType "plain", title "${surfacesTerminalTitle(probe.token)}" and command "echo ${surfacesTerminalMarker(probe.token)}". Note the tabId it returns.`,
    `2. open_worker_browser with ${worker} and url "${SURFACES_BROWSER_URL}". Nothing serves that address; the tab opens anyway.`,
    `3. list_tabs with ${worker}. Note the id of the browser tab step 2 opened.`,
    `4. edit_worker_tab with ${worker}, the terminal tab's tabId from step 1 and operation "focus".`,
    `5. edit_worker_tab with ${worker}, the browser tab's id from step 3 and operation "close".`,
    `6. request_root_changes with ${worker}, files ["${file}"] and reason "The surfaces check copies one uncommitted file into its worker."`,
    "7. Then finish this turn at once with a one-line summary. Do not wait, sleep, read messages or check message status.",
    "",
    "When you are woken with the outcome of the root changes request, reply with one short line and end that turn without calling any tools.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool output and layout

/** The tab one `launch_terminal` result names, or null. */
export function launchedTabId(output: string): string | null {
  return /"tabId"\s*:\s*"([^"]{1,200})"/.exec(output)?.[1] ?? null;
}

/** The approval request one `request_root_changes` result names, or null. */
export function rootChangesRequestId(output: string): string | null {
  return /"approvalRequestId"\s*:\s*"([^"]{1,300})"/.exec(output)?.[1] ?? null;
}

/** Whether a tool result reports an error, without assuming how it is wrapped. */
export function toolOutputFailed(output: string): boolean {
  return /"isError"\s*:\s*true/.test(output);
}

/** Browser tabs a coordinator opened carry this prefix (`openWorkerBrowser`). */
const COORDINATOR_BROWSER_TAB = /browser-coordinator-[A-Za-z0-9_-]{1,64}/g;

export function coordinatorBrowserTabIds(text: string): string[] {
  return [...new Set(text.match(COORDINATOR_BROWSER_TAB) ?? [])];
}

export interface LayoutTab {
  id: string;
  type?: string;
  paneId: string;
  /** The tab its pane shows. */
  selected: boolean;
}

/** Every tab of a `get_pane_layout` answer, with its pane; tolerant of any shape. */
export function layoutTabs(layout: unknown): LayoutTab[] {
  const tabs: LayoutTab[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 32 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === "leaf" && typeof record.id === "string" && Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (!tab || typeof tab !== "object") continue;
        const { id, type } = tab as { id?: unknown; type?: unknown };
        if (typeof id !== "string") continue;
        tabs.push({
          id,
          ...(typeof type === "string" ? { type } : {}),
          paneId: record.id,
          selected: record.activeTabId === id,
        });
      }
      return;
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  };
  visit(layout, 0);
  return tabs;
}

// ---------------------------------------------------------------------------
// Verdict

export interface SurfacesInput {
  coordinatorEnvironmentId: string;
  /** Every tool call of the surfaces turn. */
  calls: readonly ReadOnlyToolCall[];
  /** Each tool's results in the surfaces turn, fetched behind their detail references. */
  outputs: Partial<Record<(typeof SURFACES_TOOLS)[number], string[]>>;
  /** The run's token, which the terminal's echoed marker carries. */
  token: string;
  /**
   * The terminal tab's raw output, read after the turn until the marker showed
   * or the wait ended; null when no read answered. Never logged or reported.
   */
  terminalOutput: string | null;
  /** The worker's layout once the surfaces turn ended. */
  layoutAfter: unknown;
  /** The approval request as the backend reads it once settled. */
  request?: { state: string; kind?: string };
  /** Whether the harness found and approved the request in the dialog. */
  approved: boolean;
  /** The file's bytes in the worker afterwards, or null when absent. */
  workerFile: string | null;
  expectedFile: string;
  /** The checkout's digests before the turn and after the wake. */
  checkoutBefore: string;
  checkoutAfter: string;
  checkoutChanges?: readonly string[];
  /** When the harness approved, and every observation from then on. */
  approvedAt?: number;
  observations: readonly DelegationObservation[];
  mail: readonly DelegationMailMessage[];
  escapedInteractions: readonly AgentInteractionKind[];
}

const check = (name: string, passed: boolean, detail?: string): CoordinatorLiveCheck => ({
  name,
  passed,
  ...(detail ? { detail } : {}),
});

/** Coordinator turns that began after `from`, from durable turn ids and phase edges. */
function turnsAfter(observations: readonly DelegationObservation[], from: number): number {
  const before = observations.filter((observation) => observation.at < from);
  const after = observations.filter((observation) => observation.at >= from);
  const known = new Set(before.at(-1)?.coordinatorTurnIds ?? []);
  const fresh = new Set<string>();
  for (const observation of after) {
    for (const id of observation.coordinatorTurnIds ?? []) if (!known.has(id)) fresh.add(id);
  }
  let edges = 0;
  let previous = before.at(-1)?.coordinatorPhase ?? "idle";
  for (const observation of after) {
    if (previous === "idle" && observation.coordinatorPhase !== "idle") edges += 1;
    previous = observation.coordinatorPhase;
  }
  return Math.max(fresh.size, edges);
}

export function evaluateSurfacesScenario(input: SurfacesInput): CoordinatorLiveCheck[] {
  const checks: CoordinatorLiveCheck[] = [];
  const outputs = (tool: (typeof SURFACES_TOOLS)[number]) => input.outputs[tool] ?? [];

  const expected: Record<(typeof SURFACES_TOOLS)[number], number> = {
    launch_terminal: 1,
    open_worker_browser: 1,
    list_tabs: 1,
    edit_worker_tab: 2,
    request_root_changes: 1,
  };
  const counts = SURFACES_TOOLS.map(
    (tool) => [tool, orkestratorToolCalls(input.calls, tool)] as const,
  );
  const missing = counts.filter(([tool, calls]) => calls.length < expected[tool]);
  checks.push(
    check(
      "each-tool-called",
      missing.length === 0,
      counts.map(([tool, calls]) => `${tool} ${calls.length}/${expected[tool]}`).join(", "),
    ),
  );
  const failed = counts.flatMap(([tool, calls]) => [
    ...calls.filter((call) => call.state === "refused").map(() => tool),
    ...outputs(tool)
      .filter(toolOutputFailed)
      .map(() => tool),
  ]);
  checks.push(
    check(
      "no-tool-error",
      failed.length === 0,
      failed.length ? `errors from ${[...new Set(failed)].join(", ")}` : undefined,
    ),
  );

  const terminalTab = outputs("launch_terminal").map(launchedTabId).find(Boolean) ?? null;
  const listed = outputs("list_tabs").join("\n");
  const listedBrowser = coordinatorBrowserTabIds(listed);
  checks.push(
    check(
      "list-tabs-shows-opened",
      terminalTab !== null && listed.includes(`"${terminalTab}"`) && listedBrowser.length > 0,
      `terminal ${terminalTab ? (listed.includes(`"${terminalTab}"`) ? "listed" : "not listed") : "unknown"}, ${listedBrowser.length} coordinator browser tabs listed`,
    ),
  );

  const ranCommand =
    input.terminalOutput !== null && terminalShowsMarker(input.terminalOutput, input.token);
  checks.push(
    check(
      "terminal-ran-command",
      ranCommand,
      input.terminalOutput === null
        ? "no terminal output could be read"
        : ranCommand
          ? undefined
          : "the echoed marker never appeared",
    ),
  );

  const after = layoutTabs(input.layoutAfter);
  const terminal = terminalTab ? after.find((tab) => tab.id === terminalTab) : undefined;
  checks.push(
    check(
      "terminal-kept-and-focused",
      terminal?.selected === true,
      terminal ? (terminal.selected ? undefined : "not selected") : "not in the layout",
    ),
  );
  const leftBrowser = after.filter((tab) => coordinatorBrowserTabIds(tab.id).length > 0);
  checks.push(
    check(
      "browser-closed",
      listedBrowser.length > 0 && leftBrowser.length === 0,
      `${leftBrowser.length} coordinator browser tabs left`,
    ),
  );

  const requestId = outputs("request_root_changes").map(rootChangesRequestId).find(Boolean);
  checks.push(check("root-changes-requested", Boolean(requestId)));
  checks.push(
    check(
      "root-changes-approved-in-dialog",
      input.approved && input.request?.state === "executed",
      `${input.approved ? "approved" : "not approved"}, request ${input.request?.state ?? "not found"}`,
    ),
  );
  checks.push(
    check(
      "root-changes-landed",
      input.workerFile === input.expectedFile,
      input.workerFile === null
        ? "absent from the worker"
        : input.workerFile === input.expectedFile
          ? undefined
          : "different bytes",
    ),
  );
  checks.push(
    check(
      "checkout-unchanged",
      input.checkoutBefore === input.checkoutAfter,
      input.checkoutChanges?.length ? input.checkoutChanges.slice(0, 20).join(", ") : undefined,
    ),
  );

  const outcomeMail =
    input.approvedAt === undefined
      ? []
      : input.mail.filter(
          (message) =>
            message.toEnvironmentId === input.coordinatorEnvironmentId &&
            message.from.kind === "system" &&
            Date.parse(message.createdAt) >= input.approvedAt! - 1_000,
        );
  const wakes =
    input.approvedAt === undefined ? 0 : turnsAfter(input.observations, input.approvedAt);
  checks.push(
    check(
      "one-outcome-wake",
      outcomeMail.length >= 1 && wakes === 1,
      `${outcomeMail.length} system messages after the approval, ${wakes} coordinator turns`,
    ),
  );

  const escaped = escapedInteractionFailures(input.escapedInteractions);
  checks.push(check("no-escaped-interactions", escaped.length === 0, escaped.join("; ")));
  return checks;
}
