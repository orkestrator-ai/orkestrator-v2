import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractBuildPipelineDetail,
  mergeBuildPipelineDetail,
} from "@orkestrator/protocol/build-pipeline-detail";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { StorageService } from "./storage.js";
import { BackendRuntime } from "./backend-runtime.js";
import { withoutTranscriptBodies } from "./build-pipeline-transcript-projection.js";
import { buildPipelineDetailFingerprint } from "./build-pipeline-detail-fingerprint.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

async function withCommands<T>(
  run: (invoke: Invoke, storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-detail-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const commands = createCommandRegistry({});
  const context = {
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    emit: () => undefined,
    storage,
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  const invoke: Invoke = async (command, args) => {
    const handler = commands.get(command);
    if (!handler) throw new Error(`Command not registered: ${command}`);
    return await handler(args, context);
  };
  try {
    return await run(invoke, storage, dataDir);
  } finally {
    context.runtime.shutdown();
    await context.runtime.terminals.history.settled();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function pipeline(overrides: Record<string, unknown> = {}, buildSession: object = {}) {
  return {
    id: "p1",
    projectId: "proj-1",
    environmentId: "",
    phase: "reviewing",
    currentSessionIndex: 0,
    taskSnapshot: { title: "Task", description: "d".repeat(2_000) },
    structuredReview: { summary: "s".repeat(4_000) },
    validationRun: { id: "run-1", status: "passed" },
    keyInformation: { summary: "brief" },
    sessions: [
      {
        phase: "build",
        iteration: 0,
        sessionKey: "build",
        sdkSessionId: "sdk-build",
        status: "running",
        startedAt: "2026-11-14T00:00:00.000Z",
        label: "Build",
        messageRevision: 1,
        fixResult: { summary: "f".repeat(1_000) },
        interactionPolicy: { mode: "unattended" },
        ...buildSession,
      },
      {
        phase: "review",
        iteration: 0,
        sessionKey: "review",
        sdkSessionId: "sdk-review",
        status: "idle",
        startedAt: "2026-11-14T00:00:00.000Z",
        label: "Review",
        reviewReport: { verdict: "pass", body: "r".repeat(3_000) },
      },
    ],
    ...overrides,
  };
}

async function save(storage: StorageService, snapshot: Record<string, unknown>) {
  return storage.saveBuildPipeline("p1", "proj-1", "", 1, snapshot);
}

type DetailAnswer = {
  unchanged: false;
  record: { revision: number; snapshot: Record<string, unknown> };
  messagePatches: unknown[];
  detailFingerprint?: string;
  detailOmitted?: true;
};

/** The whole record every caller that names no fingerprint receives. */
async function fullRecord(storage: StorageService): Promise<DetailAnswer["record"]> {
  return withoutTranscriptBodies(
    (await storage.getBuildPipeline("p1"))!,
  ) as unknown as DetailAnswer["record"];
}

describe("get_build_pipeline detail fingerprint", () => {
  test("a transcript-only change is answered without the detail the caller holds", async () => {
    await withCommands(async (invoke, storage) => {
      await save(storage, pipeline());
      const first = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: "",
      })) as DetailAnswer;
      expect(first.unchanged).toBe(false);
      expect(first.detailOmitted).toBeUndefined();
      expect(first.messagePatches).toEqual([]);
      expect(first.record).toEqual(await fullRecord(storage));
      expect(first.detailFingerprint).toBe(
        buildPipelineDetailFingerprint(first.record.snapshot) ?? undefined,
      );
      const held = extractBuildPipelineDetail(first.record.snapshot)!;

      // Only the session's transcript cursor moves.
      await save(storage, pipeline({}, { messageRevision: 2 }));
      const second = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownRevision: first.record.revision,
        knownDetailFingerprint: first.detailFingerprint,
      })) as DetailAnswer;
      expect(second.detailOmitted).toBe(true);
      expect(second.detailFingerprint).toBe(first.detailFingerprint);
      expect(second.record.revision).toBe(first.record.revision + 1);
      expect("taskSnapshot" in second.record.snapshot).toBe(false);
      expect("structuredReview" in second.record.snapshot).toBe(false);
      const sessions = second.record.snapshot.sessions as Array<Record<string, unknown>>;
      expect("fixResult" in sessions[0]!).toBe(false);
      expect("reviewReport" in sessions[1]!).toBe(false);
      expect(sessions[0]!.messageRevision).toBe(2);
      const full = await fullRecord(storage);
      expect(JSON.stringify(second.record).length).toBeLessThan(JSON.stringify(full).length / 2);
      // Merged back, the caller holds exactly the full record.
      expect({
        ...second.record,
        snapshot: mergeBuildPipelineDetail(second.record.snapshot, held),
      }).toEqual(full);
    });
  });

  test("a change to a heavy field reaches the caller on the next read", async () => {
    await withCommands(async (invoke, storage) => {
      await save(storage, pipeline());
      const first = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: "",
      })) as DetailAnswer;
      // A per-session heavy field changes, and separately a top-level one.
      for (const changed of [
        pipeline({}, { fixResult: { summary: "second fix" } }),
        pipeline({ keyInformation: { summary: "updated" } }),
      ]) {
        await save(storage, changed);
        const answer = (await invoke("get_build_pipeline", {
          pipelineId: "p1",
          knownDetailFingerprint: first.detailFingerprint,
        })) as DetailAnswer;
        expect(answer.detailOmitted).toBeUndefined();
        expect(answer.detailFingerprint).not.toBe(first.detailFingerprint);
        expect(answer.record).toEqual(await fullRecord(storage));
      }
    });
  });

  test("a stale or foreign fingerprint gets the whole record", async () => {
    await withCommands(async (invoke, storage) => {
      await save(storage, pipeline());
      for (const knownDetailFingerprint of ["d1-stale", "", "x".repeat(300)]) {
        const answer = (await invoke("get_build_pipeline", {
          pipelineId: "p1",
          knownDetailFingerprint,
        })) as DetailAnswer;
        expect(answer.detailOmitted).toBeUndefined();
        expect(answer.record).toEqual(await fullRecord(storage));
      }
    });
  });

  test("callers that name no fingerprint keep receiving the whole record", async () => {
    await withCommands(async (invoke, storage) => {
      await save(storage, pipeline());
      const plain = await invoke("get_build_pipeline", { pipelineId: "p1" });
      expect(plain).toEqual(await fullRecord(storage));
      expect(plain).not.toHaveProperty("detailFingerprint");
      const conditional = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownSessions: {},
      })) as DetailAnswer;
      expect(conditional.record).toEqual(await fullRecord(storage));
      expect(conditional).not.toHaveProperty("detailFingerprint");
      expect(conditional).not.toHaveProperty("detailOmitted");
      const listed = (await invoke("list_build_pipelines", { projectId: "proj-1" })) as unknown[];
      expect(listed).toEqual([await fullRecord(storage)]);
    });
  });

  test("the current revision is still unchanged, and a deleted pipeline is null", async () => {
    await withCommands(async (invoke, storage) => {
      const saved = await save(storage, pipeline());
      await expect(
        invoke("get_build_pipeline", {
          pipelineId: "p1",
          knownRevision: saved.revision,
          knownDetailFingerprint: "",
        }),
      ).resolves.toEqual({ unchanged: true, revision: saved.revision });
      await storage.deleteBuildPipeline("p1");
      await expect(
        invoke("get_build_pipeline", { pipelineId: "p1", knownDetailFingerprint: "d1-anything" }),
      ).resolves.toBeNull();
    });
  });

  test("a transcript read omits the held detail and still patches the stale session", async () => {
    await withCommands(async (invoke, storage) => {
      const body = [{ id: "m1", role: "assistant", text: "hello" }];
      const committed = await storage.commitBuildPipelineTranscript({
        pipelineId: "p1",
        sessionKey: "build",
        sdkSessionId: "sdk-build",
        messages: body,
        revision: 1,
        fingerprint: transcriptFingerprint(body),
      });
      if (committed.status !== "staged") throw new Error("commit failed");
      await save(
        storage,
        pipeline(
          {},
          { transcript: committed.reference, messagesFingerprint: committed.fingerprint },
        ),
      );
      const control = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: "",
      })) as DetailAnswer;
      const answer = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownSessions: {},
        prioritySessionKey: "build",
        knownDetailFingerprint: control.detailFingerprint,
      })) as DetailAnswer & {
        messagePatches: Array<{ sessionKey: string; messages: unknown[] }>;
      };
      expect(answer.detailOmitted).toBe(true);
      expect(answer.messagePatches).toHaveLength(1);
      expect(answer.messagePatches[0]).toMatchObject({ sessionKey: "build", messages: body });
      expect("structuredReview" in answer.record.snapshot).toBe(false);
    });
  });

  test("a record another process wrote gets the fingerprint the save path computed", async () => {
    await withCommands(async (invoke, storage, dataDir) => {
      await save(storage, pipeline());
      const first = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: "",
      })) as DetailAnswer;
      const other = new StorageService(dataDir);
      await other.init();
      const fresh = await other.getBuildPipelineWithDetailFingerprint("p1");
      expect(fresh?.detailFingerprint).toBe(first.detailFingerprint);
    });
  });

  test("a heavy field another process changes reaches a reader whose fingerprint is warm", async () => {
    await withCommands(async (invoke, storage, dataDir) => {
      await save(storage, pipeline());
      // This process reads twice, so its fingerprint for the record is cached.
      const first = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: "",
      })) as DetailAnswer;
      const warm = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: first.detailFingerprint,
      })) as DetailAnswer;
      expect(warm.detailOmitted).toBe(true);

      // Another process rewrites a heavy field (and nothing else).
      const other = new StorageService(dataDir);
      await other.init();
      await other.saveBuildPipeline(
        "p1",
        "proj-1",
        "",
        1,
        pipeline({}, { fixResult: { summary: "written elsewhere" } }),
      );

      const after = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownRevision: warm.record.revision,
        knownDetailFingerprint: first.detailFingerprint,
      })) as DetailAnswer;
      expect(after.unchanged).toBe(false);
      expect(after.detailOmitted).toBeUndefined();
      expect(after.detailFingerprint).toBeDefined();
      expect(after.detailFingerprint).not.toBe(first.detailFingerprint);
      expect(after.record.revision).toBeGreaterThan(warm.record.revision);
      const sessions = after.record.snapshot.sessions as Array<Record<string, unknown>>;
      expect(sessions[0]!.fixResult).toEqual({ summary: "written elsewhere" });
      expect(after.record).toEqual(await fullRecord(storage));
      // The new fingerprint is the one the writer computed at its save path.
      expect(after.detailFingerprint).toBe(
        (await other.getBuildPipelineWithDetailFingerprint("p1"))?.detailFingerprint ?? undefined,
      );

      // A caller now naming the new fingerprint gets the detail left out again.
      const settled = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: after.detailFingerprint,
      })) as DetailAnswer;
      expect(settled.detailOmitted).toBe(true);
    });
  });

  test("a record whose sessions share a key is never split", async () => {
    await withCommands(async (invoke, storage) => {
      const duplicated = pipeline();
      (duplicated.sessions[1] as { sessionKey: string }).sessionKey = "build";
      await save(storage, duplicated);
      const answer = (await invoke("get_build_pipeline", {
        pipelineId: "p1",
        knownDetailFingerprint: "",
      })) as DetailAnswer;
      expect(answer).not.toHaveProperty("detailFingerprint");
      expect(answer.record).toEqual(await fullRecord(storage));
    });
  });
});
