/**
 * Human nodes in the run view (item 208): approve, choose and edit through
 * the shared answer form, the edit form's live validation, and the
 * inactive-environment path (start, switch away, answer later, return).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act as reactAct } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GraphHumanWait, GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { TerminalProvider } from "@/contexts/TerminalContext";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { useGraphRunStore } from "@/stores/graphRunStore";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { GraphRunTab } from "./GraphRunTab";
import { act, humanPlan, humanRunOf } from "./graph-run.test-fixtures";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const WAIT_ID = "33333333-3333-4333-8333-333333333333";
const BRIEF = { text: "Export reports as CSV." };

let stored: GraphRun;
let handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

function install() {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (handler) return handler(args);
    if (command === "graph_run_get") {
      return args.knownRevision === stored.revision
        ? { status: "unchanged", revision: stored.revision }
        : { status: "changed", run: stored };
    }
    return undefined;
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function calls(command: string) {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>);
}

function renderTab() {
  return render(
    <TerminalProvider>
      <div style={{ width: 1400, height: 900, position: "relative" }}>
        <GraphRunTab
          environmentId="env-1"
          data={{ runId: "run-1", title: "People" }}
          isActive
          layout="graph"
        />
      </div>
    </TerminalProvider>,
  );
}

function waitingCheck(wait: Partial<GraphHumanWait> = {}, overrides: Partial<NodeActivation> = {}) {
  return act(
    { nodeId: "check" },
    {
      state: "awaiting-human",
      inputs: { brief: "artifact-brief" },
      human: { id: WAIT_ID, form: "approve", openedAt: "2026-10-29T10:01:00.000Z", ...wait },
      ...overrides,
    },
  );
}

async function openCheck() {
  const graph = await screen.findByRole("tablist", { name: "Graph run" });
  fireEvent.click(within(graph).getByRole("tab", { name: /^Check the brief(,|$)/ }));
  return screen.findByTestId("graph-run-inspector");
}

beforeEach(() => {
  handlers = {};
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

describe("human node panel", () => {
  test("approve: choose Approve or Reject, add a note, send the wait's answer", async () => {
    const check = waitingCheck();
    stored = humanRunOf(humanPlan({ kind: "approve", instructions: "Is it ready?" }), [check]);
    handlers.graph_run_answer = () => ({ activationKey: check.key, human: check.human });
    renderTab();
    const inspector = await openCheck();
    expect(within(inspector).getByText("Waiting for an approval")).toBeTruthy();
    expect(within(inspector).getByText("Is it ready?")).toBeTruthy();
    // Human nodes have no decline: rejecting is a choice.
    expectDomAbsent(within(inspector).queryByRole("button", { name: "Decline" }), "decline");
    fireEvent.click(within(inspector).getByRole("button", { name: "Send" }));
    expect((await within(inspector).findByRole("alert")).textContent).toContain("Choose an option");
    expect(calls("graph_run_answer")).toHaveLength(0);

    fireEvent.click(within(inspector).getByRole("radio", { name: "Reject" }));
    fireEvent.change(within(inspector).getByRole("textbox", { name: "Note (optional)" }), {
      target: { value: "Needs numbers" },
    });
    fireEvent.click(within(inspector).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls("graph_run_answer")).toHaveLength(1));
    expect(calls("graph_run_answer")[0]).toEqual({
      runId: "run-1",
      activationKey: check.key,
      waitId: WAIT_ID,
      decision: "reject",
      note: "Needs numbers",
    });
  });

  test("choose: the options are the choices, and the answer names the outlet", async () => {
    const check = waitingCheck({ form: "choose" });
    stored = humanRunOf(
      humanPlan({
        kind: "choose",
        options: [
          { to: "fast", label: "Ship it" },
          { to: "slow", label: "Review again" },
        ],
      }),
      [check],
    );
    handlers.graph_run_answer = () => ({ activationKey: check.key, human: check.human });
    renderTab();
    const inspector = await openCheck();
    expect(within(inspector).getByText("Waiting for a choice")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("radio", { name: "Review again" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls("graph_run_answer")).toHaveLength(1));
    expect(calls("graph_run_answer")[0]).toMatchObject({ decision: "choose", outlet: "slow" });
  });

  test("edit: the type's form edits the value, checked live; an invalid value is not sent", async () => {
    const check = waitingCheck({ form: "edit" });
    stored = humanRunOf(humanPlan({ kind: "edit", edit: "brief" }), [check]);
    handlers.graph_run_artifact = () => ({
      artifact: {
        id: "artifact-brief",
        type: "text@1",
        bytes: 40,
        producer: { nodeId: "$run", activation: "$run", port: "brief" },
      },
      value: BRIEF,
    });
    handlers.graph_run_answer = () => ({ activationKey: check.key, human: check.human });
    renderTab();
    const inspector = await openCheck();
    const field = (await within(inspector).findByRole("textbox", { name: "text" })) as
      HTMLTextAreaElement | HTMLInputElement;
    expect(field.value).toBe(BRIEF.text);

    // As JSON, a value the type refuses shows why, and approving is held back.
    fireEvent.click(within(inspector).getByRole("button", { name: "JSON" }));
    fireEvent.change(within(inspector).getByRole("textbox", { name: "text@1 as JSON" }), {
      target: { value: '{"text": 5}' },
    });
    expect(
      (await within(inspector).findByText(/text/, { selector: "[data-graph-edit-problem]" }))
        .textContent,
    ).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("radio", { name: "Approve" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "Send" }));
    await within(inspector).findByText(/Fix the edited value first/);
    expect(calls("graph_run_answer")).toHaveLength(0);

    fireEvent.change(within(inspector).getByRole("textbox", { name: "text@1 as JSON" }), {
      target: { value: '{"text": "Export reports as CSV, with a header."}' },
    });
    expectDomAbsent(inspector.querySelector("[data-graph-edit-problem]"), "edit problem");
    fireEvent.click(within(inspector).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls("graph_run_answer")).toHaveLength(1));
    expect(calls("graph_run_answer")[0]).toEqual({
      runId: "run-1",
      activationKey: check.key,
      waitId: WAIT_ID,
      decision: "approve",
      value: { text: "Export reports as CSV, with a header." },
    });
  });

  test("an answered step shows the decision and takes no input", async () => {
    const decided = act(
      { nodeId: "check" },
      {
        state: "complete",
        outlet: "approved",
        inputs: { brief: "artifact-brief" },
        outputs: { brief: "artifact-edited" },
        human: {
          id: WAIT_ID,
          form: "edit",
          openedAt: "2026-10-29T10:01:00.000Z",
          answer: {
            decision: "approve",
            outlet: "approved",
            edited: { port: "brief", artifactId: "f".repeat(64) },
            note: "Tightened",
            at: "2026-10-29T10:02:00.000Z",
            by: "user",
          },
        },
      },
    );
    stored = humanRunOf(humanPlan({ kind: "edit", edit: "brief" }), [decided], {
      status: "complete",
    });
    renderTab();
    const inspector = await openCheck();
    expect(within(inspector).getByText("Approve (edited) — Tightened")).toBeTruthy();
    expect(within(inspector).getByText("Decided: approved")).toBeTruthy();
    expectDomAbsent(within(inspector).queryByRole("button", { name: "Send" }), "send button");
  });

  test("inactive environment: start, switch away, return to the wait, answer, see it decided", async () => {
    const check = waitingCheck({}, { startedAt: "2026-10-29T10:01:00.000Z" });
    const plan = humanPlan({ kind: "approve" }, { timeoutMs: 3_600_000 });
    stored = humanRunOf(plan, [check]);
    const first = renderTab();
    await openCheck();
    // Switch away: the tab unmounts and sends nothing; the wait stays in the backend.
    const before = invokeMock.mock.calls.length;
    first.unmount();
    expect(invokeMock.mock.calls.length).toBe(before);
    expect(calls("graph_run_answer")).toHaveLength(0);

    // Return later: the wait rehydrates from the snapshot, with its deadline.
    stored = { ...stored, revision: 2 };
    renderTab();
    let inspector = await openCheck();
    expect(within(inspector).getByText("Waiting for an approval")).toBeTruthy();
    expect(inspector.querySelector("[data-graph-human-timeout]")).toBeTruthy();
    handlers.graph_run_answer = () => ({ activationKey: check.key, human: check.human });
    fireEvent.click(within(inspector).getByRole("radio", { name: "Approve" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls("graph_run_answer")).toHaveLength(1));

    // The backend records the answer and the run finishes; the change re-reads the run.
    stored = humanRunOf(
      plan,
      [
        act(
          { nodeId: "check" },
          {
            state: "complete",
            outlet: "approved",
            inputs: { brief: "artifact-brief" },
            outputs: { brief: "artifact-brief" },
            human: {
              ...check.human!,
              answer: {
                decision: "approve",
                outlet: "approved",
                at: "2026-10-29T10:03:00.000Z",
                by: "user",
              },
            },
          },
        ),
      ],
      { status: "complete", revision: 3 },
    );
    await reactAct(async () => {
      dispatchResourceChange({ resource: "graph-run", id: "run-1", revision: 3 });
      await new Promise((done) => setTimeout(done, 80));
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-run-status").textContent).toBe("Complete"),
    );
    inspector = screen.getByTestId("graph-run-inspector");
    expect(within(inspector).getByText("Decided: approved")).toBeTruthy();
    expectDomAbsent(within(inspector).queryByRole("button", { name: "Send" }), "send button");
  });
});
