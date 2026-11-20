/**
 * The live workflow inspector over the `workflow` push topic
 * (docs/architecture/push-events.md): while its subscription is healthy it
 * reads when a frame names the run and otherwise only on the 30 s recovery
 * poll; without push, or once the stream drops, it keeps its 4 s cadence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import type { WorkflowSnapshotV1 } from "@orkestrator/protocol/workflow-snapshot";
import {
  PUSH_CHANGED_EVENT,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
} from "@orkestrator/protocol/push-events";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { FakeNodeClient, cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { pushClientFor } from "@/lib/push/push-subscriptions";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import { useWorkflowLiveSnapshot } from "./WorkflowLiveInspector";

const STREAM = "stream-aaaaaaaaaaaaaaaa";
const KIND = "multi-review";
const RUN = "run-1";
const PUSH_KEY = `${KIND}/${RUN}`;
/** Fast enough to see several old-cadence reads in a short real-time window. */
const POLL_MS = 40;

function snapshot(sourceRevision: string, status = "running"): WorkflowSnapshotV1 {
  return {
    schemaVersion: 1,
    workflowId: KIND,
    runId: RUN,
    sourceRevision,
    capturedAt: "2026-11-19T10:00:00.000Z",
    title: "Multi review",
    description: "Synthetic",
    status: status as WorkflowSnapshotV1["status"],
    completeness: {
      mode: "complete",
      totalNodes: 1,
      totalEdges: 0,
      omittedNodes: 0,
      omittedEdges: 0,
    },
    nodes: [{ id: "input", label: "Package", role: "input", status: "succeeded", links: [] }],
    edges: [],
  };
}

function Probe() {
  const live = useWorkflowLiveSnapshot({
    environmentId: "env-1",
    workflowId: KIND,
    runId: RUN,
    enabled: true,
    pollIntervalMs: POLL_MS,
  });
  return <div data-testid="probe" data-phase={live.phase} />;
}

function setup(options: { terminal?: () => boolean } = {}) {
  let revision = 0;
  const client = new FakeNodeClient({
    invoke: {
      [TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot]: () => {
        revision += 1;
        const terminal = options.terminal?.() ?? false;
        return {
          status: "available",
          snapshot: snapshot(`rev-${revision}`, terminal ? "succeeded" : "running"),
          terminal,
        };
      },
      push_set_subscriptions: (args: Readonly<Record<string, unknown>>) => {
        const set = args as unknown as PushSetSubscriptionsArgs;
        return {
          status: "applied",
          setRevision: set.setRevision,
          seqBase: 0,
          subscriptions: set.subscriptions.map(({ topic, key }) => ({
            topic,
            key,
            status: "ok",
            generation: "g1",
            revision: 0,
          })),
        };
      },
    },
  });
  const view = renderInNodeScope(<Probe />, { client });
  const reads = () => client.calls(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot).length;
  const sets = () => client.calls("push_set_subscriptions");
  const connect = async () => {
    await act(async () => {
      client.emit(PUSH_STREAM_STATE_EVENT, {
        state: "connected",
        offer: { versions: [1], streamId: STREAM },
      });
    });
    await waitFor(() =>
      expect(pushClientFor(view.scope).isHealthy("workflow", PUSH_KEY)).toBe(true),
    );
  };
  const frame = async (seq: number, key = PUSH_KEY) => {
    await act(async () => {
      client.emit(PUSH_CHANGED_EVENT, {
        seq,
        changes: [{ topic: "workflow", key, generation: "g1", revision: seq, parts: ["progress"] }],
      });
    });
  };
  return { client, view, reads, sets, connect, frame };
}

const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

afterEach(() => {
  cleanupNodeScopes();
  resetResourceSync();
});

const announceSave = () =>
  act(() => dispatchResourceChange({ resource: KIND, id: RUN, revision: 2 } as never));

describe("useWorkflowLiveSnapshot over push", () => {
  test("without a push offer it keeps the old cadence", async () => {
    const { reads, sets } = setup();
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
    const first = reads();
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(first + 3), { timeout: 2_000 });
    expect(sets()).toHaveLength(0);
  });

  test("subscribes its run, reads on frames and otherwise only on the recovery poll", async () => {
    const { reads, sets, connect, frame } = setup();
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
    await connect();
    expect(sets().at(-1)?.args).toMatchObject({
      streamId: STREAM,
      subscriptions: [{ topic: "workflow", key: PUSH_KEY }],
    });
    // The first answer reads once; after that a quiet run costs nothing for
    // many old-cadence periods.
    await pause(POLL_MS * 3);
    const settled = reads();
    await pause(POLL_MS * 8);
    expect(reads()).toBe(settled);

    // A frame for this run reads at once; another run's frame does not.
    await frame(1);
    await waitFor(() => expect(reads()).toBe(settled + 1));
    await frame(2, `${KIND}/other-run`);
    await pause(POLL_MS * 3);
    expect(reads()).toBe(settled + 1);
    // The save's `resource-changed` is the frame's twin: no second read.
    await announceSave();
    await pause(POLL_MS * 3);
    expect(reads()).toBe(settled + 1);
  });

  test("a dropped stream returns it to the old cadence; completion comes only from the read", async () => {
    const { reads, connect, client, view } = setup();
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
    await connect();
    await pause(POLL_MS * 3);
    const quiet = reads();

    await act(async () => {
      client.emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" });
    });
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(quiet + 3), { timeout: 2_000 });
    // Losing the stream is not completion: the view is still live.
    expect(view.getByTestId("probe").getAttribute("data-phase")).toBe("live");
  });

  test("a terminal read stops polling even while push is unhealthy", async () => {
    let terminal = false;
    const { reads } = setup({ terminal: () => terminal });
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(2));
    terminal = true;
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3));
    await pause(POLL_MS * 2);
    const done = reads();
    await pause(POLL_MS * 6);
    expect(reads()).toBe(done);
    // Without push, the run's own `resource-changed` (named by its record id) reads.
    await announceSave();
    await waitFor(() => expect(reads()).toBe(done + 1));
  });
});
