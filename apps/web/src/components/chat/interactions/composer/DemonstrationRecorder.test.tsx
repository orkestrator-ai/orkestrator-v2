import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  BrowserPreviewTraceApi,
  BrowserPreviewTraceResult,
} from "@orkestrator/protocol/browser-preview";
import { FakeNodeClient, cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { DemonstrationRecorder } from "./DemonstrationRecorder";

afterEach(() => {
  cleanupNodeScopes();
  delete (window as { orkestrator?: unknown }).orkestrator;
});

const trace: BrowserPreviewTraceResult = {
  service: { origin: "https://demo.example", label: "Demo" },
  startedAt: "2026-11-20T00:00:00.000Z",
  durationMs: 10,
  steps: [
    {
      stepId: "one",
      offsetMs: 0,
      documentSegment: 1,
      action: "click",
      target: { label: "Keep this" },
    },
    {
      stepId: "two",
      offsetMs: 10,
      documentSegment: 1,
      action: "mark",
      userObservation: "Withhold this",
    },
  ],
  gaps: [],
  stopReason: "time-limit",
};

function fixture(initial: "idle" | "recording" | "stopped") {
  let mode = initial;
  const status = () => ({
    recording: mode === "recording",
    steps: mode === "idle" ? 0 : 2,
    elapsedMs: mode === "idle" ? 0 : 10,
    stopReason: mode === "stopped" ? trace.stopReason : null,
    origin: trace.service.origin,
  });
  const recorder = {
    start: mock(async () => {
      mode = "recording";
      return status();
    }),
    status: mock(async () => status()),
    stop: mock(async (_tab: string, retain?: boolean) => {
      mode = retain ? "stopped" : "idle";
      return trace;
    }),
    mark: mock(async () => status()),
  } satisfies BrowserPreviewTraceApi;
  (window as { orkestrator?: unknown }).orkestrator = { browserPreview: { trace: recorder } };
  let responses = 0;
  const client = new FakeNodeClient({
    invoke: {
      rich_interaction_compose: () => {
        responses += 1;
        if (responses === 1) throw new Error("Lost response");
        return {};
      },
    },
  });
  const child = (
    <DemonstrationRecorder environmentId="demo-env" logicalSessionKey="env-demo-env:tab" />
  );
  const rendered = renderInNodeScope(<div />, { client });
  const layout = rendered.scope.store(paneLayoutStore).getState();
  layout.initialize(null, "demo-env");
  const pane = rendered.scope
    .store(paneLayoutStore)
    .getState()
    .environments.get("demo-env")!.activePaneId;
  layout.addTab(
    pane,
    { id: "demo-browser", type: "browser", browserData: { url: "https://demo.example" } },
    "demo-env",
  );
  rendered.rerender(child);
  return {
    rendered,
    child,
    recorder,
    client,
    autoStop: () => {
      mode = "stopped";
    },
  };
}

test("auto stop enters review and retries send with the same reviewed steps and key", async () => {
  const { autoStop, client } = fixture("recording");
  await screen.findByText(/Recording https/);
  autoStop();
  await screen.findByText(/stopped: time-limit/, {}, { timeout: 2500 });
  fireEvent.click(screen.getByRole("checkbox", { name: /Withhold this/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Expected outcome" }), {
    target: { value: "Keep the selected result" },
  });
  const send = screen.getByRole("button", { name: "Send demonstration" });
  fireEvent.click(send);
  await screen.findByRole("alert");
  fireEvent.click(send);
  await waitFor(() =>
    expect(
      client.invocations.filter((call) => call.command === "rich_interaction_compose"),
    ).toHaveLength(2),
  );
  const calls = client.invocations.filter((call) => call.command === "rich_interaction_compose");
  expect(calls[0]?.args.idempotencyKey).toBe(calls[1]?.args.idempotencyKey);
  expect(JSON.stringify(calls[1]?.args)).not.toContain("Withhold this");
  expect(calls[1]?.args.result).toEqual({
    stepIds: ["one"],
    expectedOutcome: "Keep the selected result",
  });
});

test("closing the recorder retains the active trace and reopening restores its review", async () => {
  const { rendered, child, recorder } = fixture("idle");
  const start = await screen.findByRole("button", { name: "Record a demonstration" });
  await waitFor(() => expect(start).toHaveProperty("disabled", false));
  fireEvent.click(start);
  await screen.findByText(/Recording https/);
  rendered.rerender(<div />);
  await waitFor(() => expect(recorder.stop).toHaveBeenCalledWith("demo-browser", true));
  await act(async () => rendered.rerender(child));
  expect(await screen.findByText(/Review before sending: 2 step/)).toBeTruthy();
});
