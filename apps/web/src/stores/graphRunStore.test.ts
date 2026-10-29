import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { graphRunSummary } from "@orkestrator/protocol/graphs/run-view";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { act, runOf } from "@/components/graph-run/graph-run.test-fixtures";
import { MAX_CACHED_ARTIFACTS, graphRunCacheKey, useGraphRunStore } from "./graphRunStore";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
type Handler = (args: Record<string, unknown>) => unknown;

function install(handlers: Record<string, Handler>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args);
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function calls(command: string) {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>);
}

beforeEach(() => {
  useGraphRunStore.setState({
    runs: new Map(),
    lists: new Map(),
    transcripts: new Map(),
    artifacts: new Map(),
  });
});

afterEach(() => {
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("graphRunStore", () => {
  test("reads a run, then asks with the revision it holds", async () => {
    let stored = runOf("multi-review", { revision: 3 });
    install({
      graph_run_get: (args) =>
        args.knownRevision === stored.revision
          ? { status: "unchanged", revision: stored.revision }
          : { status: "changed", run: stored },
    });
    await useGraphRunStore.getState().loadRun("run-1");
    expect(useGraphRunStore.getState().runs.get("run-1")).toMatchObject({
      status: "ready",
      run: { revision: 3 },
    });
    expect(calls("graph_run_get")).toEqual([{ runId: "run-1" }]);

    await useGraphRunStore.getState().loadRun("run-1");
    expect(calls("graph_run_get")[1]).toEqual({ runId: "run-1", knownRevision: 3 });
    expect(useGraphRunStore.getState().runs.get("run-1")!.run!.revision).toBe(3);

    stored = runOf("multi-review", { revision: 4, status: "complete" });
    await useGraphRunStore.getState().loadRun("run-1");
    expect(useGraphRunStore.getState().runs.get("run-1")!.run).toMatchObject({
      revision: 4,
      status: "complete",
    });
  });

  test("never moves a run backwards to an older snapshot", () => {
    const store = useGraphRunStore.getState();
    store.applyRun(runOf("multi-review", { revision: 5, status: "paused" }));
    store.applyRun(runOf("multi-review", { revision: 4, status: "running" }));
    expect(useGraphRunStore.getState().runs.get("run-1")!.run).toMatchObject({
      revision: 5,
      status: "paused",
    });
  });

  test("an unknown run reads as missing; a failed refresh keeps the last snapshot", async () => {
    install({
      graph_run_get: () => {
        throw new Error("The graph run does not exist");
      },
    });
    await useGraphRunStore.getState().loadRun("gone");
    expect(useGraphRunStore.getState().runs.get("gone")).toMatchObject({
      status: "missing",
      run: null,
    });

    useGraphRunStore.getState().applyRun(runOf("multi-review", { revision: 2 }));
    install({
      graph_run_get: () => {
        throw new Error("Backend offline");
      },
    });
    await useGraphRunStore.getState().loadRun("run-1");
    expect(useGraphRunStore.getState().runs.get("run-1")).toMatchObject({
      status: "ready",
      error: "Backend offline",
      run: { revision: 2 },
    });
  });

  test("a burst of change events costs one read in flight and one after it", async () => {
    let resolve: (() => void) | null = null;
    install({
      graph_run_get: () =>
        new Promise((done) => {
          resolve = () => done({ status: "changed", run: runOf("multi-review") });
        }),
    });
    const first = useGraphRunStore.getState().loadRun("run-1");
    void useGraphRunStore.getState().loadRun("run-1");
    void useGraphRunStore.getState().loadRun("run-1");
    expect(calls("graph_run_get")).toHaveLength(1);
    resolve!();
    await new Promise((done) => setTimeout(done, 0));
    resolve!();
    await first;
    expect(calls("graph_run_get")).toHaveLength(2);
  });

  test("lists an environment's runs and keeps a listed run current", async () => {
    const run = runOf("multi-review", { revision: 1 });
    install({ graph_runs_list: () => [graphRunSummary(run)] });
    await useGraphRunStore.getState().loadList("env-1");
    expect(calls("graph_runs_list")).toEqual([{ environmentId: "env-1" }]);
    expect(useGraphRunStore.getState().lists.get("env-1")!.runs[0]!.status).toBe("running");
    useGraphRunStore.getState().applyRun({ ...run, revision: 2, status: "complete" });
    expect(useGraphRunStore.getState().lists.get("env-1")!.runs[0]).toMatchObject({
      status: "complete",
      revision: 2,
    });
  });

  test("reads a transcript once per stored revision", async () => {
    install({
      graph_run_transcript: () => ({
        status: "found",
        messages: [{ id: "m1" }],
        startIndex: 0,
        messageCount: 1,
        revision: 1,
        complete: true,
      }),
    });
    const key = act({ nodeId: "plan" }).key;
    await useGraphRunStore.getState().loadTranscript("run-1", key, 1);
    await useGraphRunStore.getState().loadTranscript("run-1", key, 1);
    expect(calls("graph_run_transcript")).toEqual([{ runId: "run-1", activationKey: key }]);
    await useGraphRunStore.getState().loadTranscript("run-1", key, 2);
    expect(calls("graph_run_transcript")).toHaveLength(2);
    expect(
      useGraphRunStore.getState().transcripts.get(graphRunCacheKey("run-1", key)),
    ).toMatchObject({ status: "ready", revision: 2 });
  });

  test("artifacts are read once and the cache is bounded", async () => {
    install({
      graph_run_artifact: (args) => ({
        artifact: { id: args.artifactId, type: "workspace@1", bytes: 10, state: "live" },
        value: { headRef: "a" },
      }),
    });
    await useGraphRunStore.getState().loadArtifact("run-1", "a-1");
    await useGraphRunStore.getState().loadArtifact("run-1", "a-1");
    expect(calls("graph_run_artifact")).toHaveLength(1);
    await useGraphRunStore.getState().loadArtifact("run-1", "a-1", { force: true });
    expect(calls("graph_run_artifact")).toHaveLength(2);
    for (let index = 0; index < MAX_CACHED_ARTIFACTS + 5; index++) {
      await useGraphRunStore.getState().loadArtifact("run-1", `b-${index}`);
    }
    const artifacts = useGraphRunStore.getState().artifacts;
    expect(artifacts.size).toBe(MAX_CACHED_ARTIFACTS);
    expect(artifacts.has(graphRunCacheKey("run-1", "a-1"))).toBe(false);
  });
});
