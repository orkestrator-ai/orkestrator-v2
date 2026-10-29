import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act as reactAct, useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts/TerminalContext";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import type { GraphRunRewindBackend } from "@/lib/backend/graph-runs";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { useGraphRunStore } from "@/stores/graphRunStore";
import { GraphRunTab } from "./GraphRunTab";
import { POLICY, act, agentSession, runOf } from "./graph-run.test-fixtures";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

let stored: GraphRun;
let handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

function install() {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (handler) return handler(args);
    if (command === "graph_run_get") {
      if (!stored) throw new Error("The graph run does not exist");
      return args.knownRevision === stored.revision
        ? { status: "unchanged", revision: stored.revision }
        : { status: "changed", run: stored };
    }
    // Model catalogues and the like: nothing to say.
    return undefined;
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function calls(command: string) {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>);
}

function graph(): HTMLElement {
  return screen.getByRole("tablist", { name: "Graph run" });
}

function faceOf(title: string): HTMLElement {
  return within(graph()).getByRole("tab", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(,|$)`),
  });
}

function inspector(): HTMLElement {
  return screen.getByTestId("graph-run-inspector");
}

function fakeRewind(): GraphRunRewindBackend & {
  restart: ReturnType<typeof mock>;
  previewCodeRewind: ReturnType<typeof mock>;
  rewindCode: ReturnType<typeof mock>;
} {
  return {
    restart: mock(async () => ({ ...stored, revision: stored.revision + 1 })),
    previewCodeRewind: mock(async () => ({
      targetCommit: "a".repeat(40),
      head: "b".repeat(40),
      commitCount: 1,
      commits: [{ sha: "b".repeat(40), subject: "Add the feature" }],
    })),
    rewindCode: mock(async () => ({ ...stored, revision: stored.revision + 1 })),
  } as never;
}

let createTabMock: ReturnType<typeof mock>;

function RegisterCreateTab() {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab((type: CreatableTabType, options?: CreateTabOptions) => {
      createTabMock(type, options);
      return true;
    });
    return () => setCreateTab(null);
  }, [setCreateTab]);
  return null;
}

function renderTab(props: { isActive?: boolean; rewindBackend?: GraphRunRewindBackend } = {}) {
  return render(
    <TerminalProvider>
      <RegisterCreateTab />
      <div style={{ width: 1400, height: 900, position: "relative" }}>
        <GraphRunTab
          environmentId="env-1"
          data={{ runId: "run-1", title: "Multi Review" }}
          isActive={props.isActive ?? true}
          layout="graph"
          {...(props.rewindBackend ? { rewindBackend: props.rewindBackend } : {})}
        />
      </div>
    </TerminalProvider>,
  );
}

function reviewRun(activations: NodeActivation[], overrides: Partial<GraphRun> = {}): GraphRun {
  return runOf("multi-review", { activations, ...overrides });
}

beforeEach(() => {
  handlers = {};
  createTabMock = mock(() => true);
  useGraphRunStore.setState({
    runs: new Map(),
    lists: new Map(),
    transcripts: new Map(),
    artifacts: new Map(),
  });
  useFlowGraphViewStore.setState({
    views: new Map(),
    collapsed: new Set(),
    expandedAttempts: new Set(),
  });
  install();
});

afterEach(() => {
  cleanup();
  resetResourceSync();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("GraphRunTab faces", () => {
  test("draws the run from its snapshot: status, mock label, branches and faded positions", async () => {
    stored = reviewRun(
      [
        act({ nodeId: "plan" }),
        act({ nodeId: "package" }),
        act({ nodeId: "review", branchKey: "panel.1" }, { state: "running" }),
        act({ nodeId: "review", branchKey: "panel.2" }),
      ],
      { mock: true },
    );
    renderTab();
    await screen.findByTestId("graph-run-title");
    expect(screen.getByTestId("graph-run-title").textContent).toBe("Multi Review");
    expect(screen.getByTestId("graph-run-mock").textContent).toContain("Mock run");
    expect(screen.getByTestId("graph-run-status").textContent).toBe("Running");
    expect(faceOf("review · Panel 1").getAttribute("data-flow-state")).toBe("running");
    expect(faceOf("review · Panel 2").getAttribute("data-flow-state")).toBe("complete");
    // Not reached yet: drawn faded, ahead of the work.
    const consolidate = faceOf("consolidate");
    expect(consolidate.hasAttribute("data-flow-placeholder")).toBe(true);
    expect(consolidate.textContent).toContain("ahead");
    expect(calls("graph_run_get")[0]).toEqual({ runId: "run-1" });
  });

  test("skipped, waiting-for-you and gate outlets read on the faces", async () => {
    stored = reviewRun(
      [
        act({ nodeId: "plan" }),
        act({ nodeId: "package" }),
        act({ nodeId: "review", branchKey: "panel.1" }),
        act({ nodeId: "review", branchKey: "panel.2" }),
        act({ nodeId: "consolidate" }),
        act({ nodeId: "has-findings" }, { outlet: "findings" }),
        act(
          { nodeId: "fix" },
          {
            state: "awaiting-human",
            policy: POLICY,
            enforcement: "enforced",
            session: agentSession({
              question: {
                id: "11111111-1111-4111-8111-111111111111",
                text: "Keep the old API?",
                choices: ["Yes", "No"],
                askedAt: "2026-10-29T10:06:00.000Z",
                requestId: "request-1",
              },
            }),
          },
        ),
      ],
      {
        status: "waiting",
        bindings: { ...runOf("multi-review").bindings, params: { autoFix: true, autoPr: false } },
      },
    );
    renderTab();
    await screen.findByTestId("graph-run-waiting-banner");
    expect(faceOf("has-findings").textContent).toContain("→ findings");
    const fix = faceOf("fix");
    expect(fix.textContent).toContain("waiting for you");
    expect(fix.querySelector("[data-graph-run-waiting]")).not.toBeNull();
    // The waiting node is selected by default, with the question to answer.
    expect(within(inspector()).getByText("Keep the old API?")).toBeTruthy();
  });
});

describe("GraphRunTab items fan-out (item 401)", () => {
  test("item branches read their item on the face and in the inspector; truncation is shown", async () => {
    const keys = ["item.validate:failure-1", "item.validate:failure-2"];
    stored = runOf("failure-diagnosis", {
      fanOuts: [
        {
          nodeId: "diagnose",
          iteration: 1,
          sources: ["a".repeat(64), "b".repeat(64)],
          items: keys.map((key, index) => ({
            key,
            index: index + 1,
            id: `validate/failure-${index + 1}`,
            artifact: (index ? "b" : "a").repeat(64),
          })),
          total: 3,
          truncatedIds: ["validate/failure-3"],
          createdAt: "2026-10-29T10:01:00.000Z",
        },
      ],
      activations: [
        act({ nodeId: "validate" }),
        act({ nodeId: "diagnose", branchKey: keys[0] }),
        act({ nodeId: "diagnose", branchKey: keys[1] }, { state: "running" }),
      ],
    });
    renderTab();
    await screen.findByTestId("graph-run-title");
    const face = faceOf("diagnose · Item validate/failure-2");
    expect(face.querySelector("[data-graph-run-truncated]")?.textContent).toBe(
      "2 of 3 items run; 1 truncated",
    );
    fireEvent.click(face);
    const item = await within(inspector()).findByText("validate/failure-2");
    expect(item.closest("[data-graph-item]")).not.toBeNull();
    expect(inspector().querySelector("[data-graph-item-truncated]")?.textContent).toBe(
      "2 of 3 items run; 1 truncated",
    );
  });
});

describe("GraphRunTab inspector", () => {
  test("shows the profile, the tier actually enforced and why, guards, usage and errors", async () => {
    stored = reviewRun([
      act(
        { nodeId: "plan" },
        {
          state: "failed",
          error: "The read-only guard found changes",
          errorCause: "guard-violation",
          policy: POLICY,
          enforcement: "provider-configured",
          enforcementReason: "Claude without its sandbox",
          guards: [
            {
              guard: "read-only",
              outcome: "violated",
              at: "2026-10-29T10:04:00.000Z",
              detail: "2 paths changed",
              paths: ["src/a.ts", "src/b.ts"],
            },
          ],
          session: agentSession({ tokenCount: 12_345, turnMode: "build" }),
        },
      ),
    ]);
    renderTab();
    await screen.findByTestId("graph-run-title");
    fireEvent.click(faceOf("plan"));
    fireEvent.mouseDown(within(inspector()).getByRole("tab", { name: "Details" }));
    fireEvent.click(within(inspector()).getByRole("tab", { name: "Details" }));
    const panel = inspector();
    await waitFor(() => expect(panel.querySelector("[data-graph-profile]")).not.toBeNull());
    expect(panel.querySelector("[data-graph-profile]")!.textContent).toBe("builder");
    expect(
      panel.querySelector('[data-graph-enforcement="provider-configured"]')!.textContent,
    ).toContain("Claude without its sandbox");
    const guard = panel.querySelector('[data-graph-guard="read-only"]')!;
    expect(guard.getAttribute("data-graph-guard-outcome")).toBe("violated");
    expect(guard.textContent).toContain("src/b.ts");
    expect(panel.querySelector("[data-graph-usage]")!.textContent).toContain("12");
    expect(panel.querySelector("[data-graph-activation-error]")!.textContent).toContain(
      "guard-violation",
    );
    expect(screen.getByTestId("graph-run-inspector-status").textContent).toBe("Failed");
  });

  test("renders output artifacts by type, read when opened", async () => {
    stored = reviewRun([
      act({ nodeId: "plan" }, { outputs: { code: "artifact-code", plan: "artifact-plan" } }),
    ]);
    handlers.graph_run_artifact = (args) => ({
      artifact: {
        formatVersion: 1,
        id: args.artifactId,
        digest: "d",
        type: "workspace@1",
        runId: "run-1",
        producer: { nodeId: "plan", activation: "x", port: "code" },
        inputs: [],
        createdAt: "2026-10-29T10:00:00.000Z",
        bytes: 64,
        state: "live",
      },
      value: { branch: "feature", headRef: "c".repeat(40), baseRef: null },
    });
    renderTab();
    await screen.findByTestId("graph-run-title");
    fireEvent.click(faceOf("plan"));
    const card = await waitFor(() => {
      const found = inspector().querySelector('[data-graph-artifact="artifact-code"]');
      if (!found) throw new Error("no card");
      return found as HTMLElement;
    });
    await waitFor(() => expect(card.textContent).toContain("feature"));
    expect(calls("graph_run_artifact")).toContainEqual({
      runId: "run-1",
      artifactId: "artifact-code",
    });
  });

  test("answers an agent's question through graph_run_answer", async () => {
    const question = {
      id: "22222222-2222-4222-8222-222222222222",
      text: "Which database?",
      choices: ["Postgres", "SQLite"],
      askedAt: "2026-10-29T10:06:00.000Z",
      requestId: "request-1",
    };
    const waiting = act(
      { nodeId: "plan" },
      {
        state: "awaiting-human",
        policy: POLICY,
        enforcement: "enforced",
        session: agentSession({ question }),
      },
    );
    stored = reviewRun([waiting], { status: "waiting" });
    handlers.graph_run_answer = () => ({ activationKey: waiting.key, question });
    renderTab();
    await screen.findByText("Which database?");
    fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Answer/ }), {
      target: { value: "Keep it light" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(calls("graph_run_answer")).toHaveLength(1));
    expect(calls("graph_run_answer")[0]).toEqual({
      runId: "run-1",
      activationKey: waiting.key,
      questionId: question.id,
      kind: "answered",
      text: "Keep it light",
      choice: "SQLite",
    });
  });
});

describe("GraphRunTab actions", () => {
  test("retry, pause and cancel go to the backend and apply the snapshot it returns", async () => {
    const failed = act(
      { nodeId: "review", branchKey: "panel.2" },
      { state: "failed", error: "Provider error" },
    );
    stored = reviewRun([
      act({ nodeId: "plan" }),
      act({ nodeId: "package" }),
      act({ nodeId: "review", branchKey: "panel.1" }, { state: "running" }),
      failed,
    ]);
    handlers.graph_run_retry = () => ({
      status: "changed",
      run: { ...stored, revision: 2 },
    });
    handlers.graph_run_pause = () => ({
      status: "changed",
      run: { ...stored, revision: 3, status: "paused" },
    });
    handlers.graph_run_cancel = () => ({
      status: "changed",
      run: { ...stored, revision: 4, status: "cancelling" },
    });
    renderTab();
    await screen.findByTestId("graph-run-title");
    fireEvent.click(faceOf("review · Panel 2"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls("graph_run_retry")).toHaveLength(1));
    expect(calls("graph_run_retry")[0]).toEqual({ runId: "run-1", activationKey: failed.key });

    fireEvent.click(screen.getByRole("button", { name: "Pause run" }));
    await waitFor(() => expect(screen.getByTestId("graph-run-status").textContent).toBe("Paused"));
    expect(screen.getByRole("button", { name: "Resume run" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel run…" }));
    const dialog = await screen.findByTestId("graph-run-cancel-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(calls("graph_run_cancel")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("graph-run-status").textContent).toBe("Stopping"),
    );
  });

  test("restart and rewind code use the restart backend, with a preview first", async () => {
    const rewind = fakeRewind();
    const planDone = act(
      { nodeId: "plan" },
      { inputs: { code: "artifact-target" }, outputs: { code: "artifact-code" } },
    );
    stored = reviewRun([planDone, act({ nodeId: "package" })]);
    renderTab({ rewindBackend: rewind });
    await screen.findByTestId("graph-run-title");
    fireEvent.click(faceOf("plan"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Restart from here" }));
    await waitFor(() => expect(rewind.restart).toHaveBeenCalledWith("run-1", planDone.key));

    fireEvent.click(within(inspector()).getByRole("button", { name: "Rewind code to here…" }));
    const dialog = await screen.findByTestId("graph-run-code-rewind-dialog");
    await within(dialog).findByText("Add the feature");
    fireEvent.click(within(dialog).getByRole("button", { name: "Drop 1 commit and restart" }));
    await waitFor(() =>
      expect(rewind.rewindCode).toHaveBeenCalledWith("run-1", planDone.key, "b".repeat(40)),
    );
  });

  test("skip is offered for a queued position; open session opens the provider session", async () => {
    const queued = act({ nodeId: "package" }, { state: "ready", startedAt: undefined });
    const plan = act(
      { nodeId: "plan" },
      { policy: POLICY, enforcement: "enforced", session: agentSession({ turnMode: "build" }) },
    );
    stored = reviewRun([plan, queued], { status: "paused" });
    handlers.graph_run_skip = () => ({ status: "changed", run: { ...stored, revision: 2 } });
    renderTab();
    await screen.findByTestId("graph-run-title");
    fireEvent.click(faceOf("package"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(calls("graph_run_skip")[0]).toEqual({ runId: "run-1", activationKey: queued.key }),
    );

    fireEvent.click(faceOf("plan"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open session" }));
    expect(createTabMock).toHaveBeenCalledTimes(1);
    const [agent, options] = createTabMock.mock.calls[0] as [string, CreateTabOptions];
    expect(agent).toBe("claude");
    expect(options).toMatchObject({
      resumeSessionId: "provider-session-1",
      requireExistingResumeSession: true,
      tabId: `graph-run-session:run-1:${plan.key}`,
    });
  });
});

describe("GraphRunTab rehydration", () => {
  test("re-reads the run when the backend announces a change, and shows the newer snapshot", async () => {
    stored = reviewRun([act({ nodeId: "plan" }, { state: "running" })]);
    renderTab();
    await screen.findByTestId("graph-run-title");
    expect(faceOf("plan").getAttribute("data-flow-state")).toBe("running");
    stored = reviewRun([act({ nodeId: "plan" })], { revision: 2, status: "complete" });
    await reactAct(async () => {
      dispatchResourceChange({ resource: "graph-run", id: "run-1", revision: 10 });
      await new Promise((done) => setTimeout(done, 80));
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-run-status").textContent).toBe("Complete"),
    );
    expect(faceOf("plan").getAttribute("data-flow-state")).toBe("complete");
    expect(calls("graph_run_get").at(-1)).toEqual({ runId: "run-1", knownRevision: 1 });
  });

  test("a run that finished while the tab was unmounted shows its final state on return", async () => {
    stored = reviewRun([act({ nodeId: "plan" }, { state: "running" })]);
    const first = renderTab();
    await screen.findByTestId("graph-run-title");
    // Switch away: the tab unmounts. Unmounting sends no command.
    const before = invokeMock.mock.calls.length;
    first.unmount();
    expect(invokeMock.mock.calls.length).toBe(before);
    expect(calls("graph_run_cancel")).toHaveLength(0);
    // The run finishes in the backend; no event reaches the unmounted view.
    stored = reviewRun([act({ nodeId: "plan" })], { revision: 5, status: "complete" });
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId("graph-run-status").textContent).toBe("Complete"),
    );
    expect(faceOf("plan").getAttribute("data-flow-state")).toBe("complete");
    expect(screen.queryByRole("button", { name: "Cancel run…" }) === null).toBe(true);
  });

  test("a deleted run says so", async () => {
    stored = undefined as unknown as GraphRun;
    renderTab();
    await screen.findByTestId("graph-run-missing");
  });
});
