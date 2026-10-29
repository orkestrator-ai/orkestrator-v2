/**
 * D3 across engines, the Build Pipeline side: a stage that would use the
 * checkout waits while a graph run holds it, without failing, and runs once
 * the graph run lets go; a stage start shows to graph runs before its session
 * is on the record.
 */
import { describe, expect, test } from "bun:test";
import {
  FakeProvider,
  pipeline,
  startInput,
  withService,
} from "./build-pipeline-service-test-support.js";
import { WorkspaceWriters } from "./workspace-writers.js";

describe("Build Pipeline stages and graph runs on one environment", () => {
  test("setup and the Build stage wait while a graph run writes, then start", async () => {
    let graph: { writers: number; readers: number } | null = { writers: 1, readers: 0 };
    let writers: WorkspaceWriters | undefined;
    await withService(
      async (service, storage, _provider, invocations) => {
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        expect((await pipeline(storage, started.id)).phase).toBe("waiting-for-setup");
        const setupRuns = () =>
          invocations.filter((call) => call.command === "run_environment_setup").length;

        // Waiting is neither a failure nor a reconnect, and runs no setup.
        for (let pass = 0; pass < 3; pass++) await service.advanceNow(started.id);
        let waiting = await pipeline(storage, started.id);
        expect(waiting.phase).toBe("waiting-for-setup");
        expect(waiting.error).toBeUndefined();
        expect(waiting.reconnectAttempt).toBeUndefined();
        expect(waiting.sessions).toEqual([]);
        expect(setupRuns()).toBe(0);

        // A graph reader still keeps out a writing stage; an unseeded lock table too.
        graph = { writers: 0, readers: 1 };
        await service.advanceNow(started.id);
        graph = null;
        await service.advanceNow(started.id);
        waiting = await pipeline(storage, started.id);
        expect(waiting.phase).toBe("waiting-for-setup");
        expect(setupRuns()).toBe(0);

        graph = { writers: 0, readers: 0 };
        await service.advanceNow(started.id);
        const building = await pipeline(storage, started.id);
        expect(building.phase).toBe("building");
        expect(setupRuns()).toBe(1);
        // Graph runs now see the pipeline writing.
        await writers!.ready();
        expect(writers!.externalHold("env-1")).toMatchObject({
          writers: 1,
          holder: "build-pipeline",
          holderAccess: "write",
        });
      },
      {
        workspaceWriters: (storage) => {
          writers = new WorkspaceWriters(storage);
          writers.setGraphHoldProbe(() => graph);
          return writers;
        },
      },
    );
    writers?.dispose();
  });

  test("a stage start is visible to graph runs before its session is recorded", async () => {
    let writers: WorkspaceWriters | undefined;
    await withService(
      async (service, storage, provider: FakeProvider) => {
        await writers!.ready();
        const seen: unknown[] = [];
        const create = provider.createSession.bind(provider);
        provider.createSession = async (phase, label, options) => {
          seen.push(writers!.externalHold("env-1"));
          return create(phase, label, options);
        };
        const started = await service.start(startInput());
        await service.advanceNow(started.id);
        await service.advanceNow(started.id);
        expect((await pipeline(storage, started.id)).phase).toBe("building");
        expect(seen).toEqual([
          expect.objectContaining({ writers: 1, holder: "build-pipeline", holderAccess: "write" }),
        ]);
      },
      {
        workspaceWriters: (storage) => {
          writers = new WorkspaceWriters(storage);
          writers.setGraphHoldProbe(() => ({ writers: 0, readers: 0 }));
          return writers;
        },
      },
    );
    writers?.dispose();
  });
});
