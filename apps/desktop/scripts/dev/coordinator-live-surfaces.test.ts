import { describe, expect, test } from "bun:test";
import type { ReadOnlyToolCall } from "./coordinator-live.js";
import type {
  DelegationMailMessage,
  DelegationObservation,
} from "./coordinator-live-delegation.js";
import {
  coordinatorBrowserTabIds,
  evaluateSurfacesScenario,
  launchedTabId,
  layoutTabs,
  rootChangesRequestId,
  surfacesApplies,
  surfacesPrompt,
  surfacesRootFile,
  surfacesWorkerInput,
  toolOutputFailed,
  type SurfacesInput,
} from "./coordinator-live-surfaces.js";

const APPROVED_AT = 1_000_000;
const terminalTab = "terminal-coordinator-abc";
const browserTab = "browser-coordinator-0123456789abcdef01234567";
const file = surfacesRootFile("t0k3n");

const call = (name: string, state: ReadOnlyToolCall["state"] = "succeeded"): ReadOnlyToolCall => ({
  name: `mcp__orkestrator__${name}`,
  args: "{}",
  state,
});

const observation = (
  at: number,
  coordinatorPhase: string,
  coordinatorTurnIds: string[],
): DelegationObservation => ({
  at,
  coordinatorPhase,
  coordinatorTurnIds,
  queueLength: 0,
  delegations: [],
  mail: [],
});

const outcomeMail: DelegationMailMessage = {
  id: "outcome",
  createdAt: new Date(APPROVED_AT + 500).toISOString(),
  from: { kind: "system" },
  toEnvironmentId: "coordinator",
  toTabId: "coord-tab",
  placement: "injected",
};

/** What a passing run hands the verdict. */
function passing(): SurfacesInput {
  return {
    coordinatorEnvironmentId: "coordinator",
    calls: [
      call("launch_terminal"),
      call("open_worker_browser"),
      call("list_tabs"),
      call("edit_worker_tab"),
      call("edit_worker_tab"),
      call("request_root_changes"),
    ],
    outputs: {
      launch_terminal: [JSON.stringify({ environmentId: "worker", tabId: terminalTab })],
      open_worker_browser: [JSON.stringify({ tabId: browserTab })],
      list_tabs: [JSON.stringify({ tabs: [{ id: terminalTab }, { id: browserTab }] })],
      edit_worker_tab: ['{"ok":true}', '{"ok":true}'],
      request_root_changes: [JSON.stringify({ approvalRequestId: "request-1" })],
    },
    layoutAfter: {
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: terminalTab,
        tabs: [
          { id: "startup-agent", type: "agent-native" },
          { id: terminalTab, type: "plain" },
        ],
      },
    },
    request: { state: "executed", kind: "apply-root-changes" },
    approved: true,
    workerFile: file.content,
    expectedFile: file.content,
    checkoutBefore: "digest",
    checkoutAfter: "digest",
    approvedAt: APPROVED_AT,
    observations: [
      observation(APPROVED_AT - 10, "idle", ["t1"]),
      observation(APPROVED_AT + 100, "working", ["t1"]),
      observation(APPROVED_AT + 200, "idle", ["t1", "t2"]),
      observation(APPROVED_AT + 300, "idle", ["t1", "t2"]),
    ],
    mail: [outcomeMail],
    escapedInteractions: [],
  };
}

const failed = (input: SurfacesInput) =>
  evaluateSurfacesScenario(input)
    .filter((check) => !check.passed)
    .map((check) => check.name);

describe("evaluateSurfacesScenario", () => {
  test("a run that does every step once, with one wake after the approval, passes", () => {
    expect(evaluateSurfacesScenario(passing()).filter((check) => !check.passed)).toEqual([]);
  });

  test("a tool left out, or `edit_worker_tab` called once, fails", () => {
    const input = passing();
    expect(
      failed({ ...input, calls: input.calls.filter((item) => !item.name.endsWith("list_tabs")) }),
    ).toContain("each-tool-called");
    const once = input.calls.filter((_item, index) => index !== 4);
    const checks = evaluateSurfacesScenario({ ...input, calls: once });
    expect(checks.find((item) => item.name === "each-tool-called")).toMatchObject({
      passed: false,
      detail: expect.stringContaining("edit_worker_tab 1/2"),
    });
  });

  test("a refused call or an error result fails", () => {
    const input = passing();
    expect(
      failed({ ...input, calls: [...input.calls, call("open_worker_browser", "refused")] }),
    ).toEqual(["no-tool-error"]);
    expect(
      failed({
        ...input,
        outputs: { ...input.outputs, edit_worker_tab: ['{"isError": true}', '{"ok":true}'] },
      }),
    ).toEqual(["no-tool-error"]);
  });

  test("`list_tabs` that misses a tab the turn opened fails", () => {
    const input = passing();
    expect(
      failed({
        ...input,
        outputs: { ...input.outputs, list_tabs: [JSON.stringify({ tabs: [{ id: terminalTab }] })] },
      }),
    ).toEqual(expect.arrayContaining(["list-tabs-shows-opened", "browser-closed"]));
  });

  test("a browser tab still open, or a terminal tab not selected, fails", () => {
    const input = passing();
    const leaf = (input.layoutAfter as { root: Record<string, unknown> }).root;
    expect(
      failed({
        ...input,
        layoutAfter: {
          root: { ...leaf, tabs: [...(leaf.tabs as unknown[]), { id: browserTab }] },
        },
      }),
    ).toEqual(["browser-closed"]);
    expect(
      failed({ ...input, layoutAfter: { root: { ...leaf, activeTabId: "startup-agent" } } }),
    ).toEqual(["terminal-kept-and-focused"]);
  });

  test("a request not approved in the dialog, or not executed, fails", () => {
    const input = passing();
    expect(failed({ ...input, approved: false })).toContain("root-changes-approved-in-dialog");
    expect(failed({ ...input, request: { state: "failed" } })).toEqual([
      "root-changes-approved-in-dialog",
    ]);
    expect(
      failed({ ...input, outputs: { ...input.outputs, request_root_changes: ["{}"] } }),
    ).toContain("root-changes-requested");
  });

  test("a file missing from the worker or with other bytes fails", () => {
    const input = passing();
    expect(failed({ ...input, workerFile: null })).toEqual(["root-changes-landed"]);
    expect(failed({ ...input, workerFile: "other\n" })).toEqual(["root-changes-landed"]);
  });

  test("a changed checkout fails and names what changed", () => {
    const checks = evaluateSurfacesScenario({
      ...passing(),
      checkoutAfter: "other",
      checkoutChanges: ["README.md"],
    });
    expect(checks.find((item) => item.name === "checkout-unchanged")).toEqual({
      name: "checkout-unchanged",
      passed: false,
      detail: "README.md",
    });
  });

  test("no outcome mail, no wake, or a second wake fails", () => {
    const input = passing();
    expect(failed({ ...input, mail: [] })).toEqual(["one-outcome-wake"]);
    expect(
      failed({
        ...input,
        observations: [observation(APPROVED_AT - 10, "idle", ["t1"])],
      }),
    ).toEqual(["one-outcome-wake"]);
    expect(
      failed({
        ...input,
        observations: [
          ...input.observations,
          observation(APPROVED_AT + 400, "working", ["t1", "t2"]),
          observation(APPROVED_AT + 500, "idle", ["t1", "t2", "t3"]),
        ],
      }),
    ).toEqual(["one-outcome-wake"]);
    // Mail older than the approval is not its outcome.
    expect(
      failed({
        ...input,
        mail: [{ ...outcomeMail, createdAt: new Date(APPROVED_AT - 5_000).toISOString() }],
      }),
    ).toEqual(["one-outcome-wake"]);
  });

  test("an interaction that escaped the coordinator policy fails", () => {
    expect(failed({ ...passing(), escapedInteractions: ["command-approval"] })).toEqual([
      "no-escaped-interactions",
    ]);
  });
});

describe("surfaces helpers", () => {
  test("only Claude runs it", () => {
    expect(surfacesApplies("claude")).toBe(true);
    expect(surfacesApplies("codex")).toBe(false);
  });

  test("the prompt names the worker, the file and every tool in order", () => {
    const prompt = surfacesPrompt({
      platform: "claude",
      token: "t0k3n",
      workerEnvironmentId: "worker-1",
    });
    expect(prompt).toContain('environmentId "worker-1"');
    expect(prompt).toContain(`["${file.path}"]`);
    const order = [
      "launch_terminal",
      "open_worker_browser",
      "list_tabs",
      'operation "focus"',
      'operation "close"',
      "request_root_changes",
    ].map((step) => prompt.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the worker is an ordinary local environment named for the run", () => {
    expect(surfacesWorkerInput({ projectId: "p", token: "t0k3n" })).toEqual({
      projectId: "p",
      name: "surfaces-t0k3n",
      environmentType: "local",
      networkAccessMode: "restricted",
    });
  });

  test("tool results are read without assuming their wrapping", () => {
    expect(launchedTabId(`{"tabId": "${terminalTab}"}`)).toBe(terminalTab);
    expect(rootChangesRequestId('{"approvalRequestId":"r-1","delivery":"async"}')).toBe("r-1");
    expect(rootChangesRequestId("{}")).toBeNull();
    expect(toolOutputFailed('{"isError" : true}')).toBe(true);
    expect(toolOutputFailed('{"isError":false}')).toBe(false);
    expect(coordinatorBrowserTabIds(`${browserTab} and again ${browserTab}`)).toEqual([browserTab]);
  });

  test("layout tabs are found in nested splits, with their pane and selection", () => {
    expect(
      layoutTabs({
        root: {
          kind: "split",
          children: [
            { kind: "leaf", id: "a", activeTabId: "x", tabs: [{ id: "x", type: "plain" }] },
            { kind: "leaf", id: "b", activeTabId: "z", tabs: [{ id: "y" }, { nope: 1 }] },
          ],
        },
      }),
    ).toEqual([
      { id: "x", type: "plain", paneId: "a", selected: true },
      { id: "y", paneId: "b", selected: false },
    ]);
    expect(layoutTabs(null)).toEqual([]);
  });
});
