import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { KEY_INFORMATION_TOOL_NAMES } from "@orkestrator/protocol/build-pipeline-key-information";
import { AgentToolsServer } from "./agent-tools.js";
import {
  createBuildPipelineKeyInformationHost,
  keyInformationAuthor,
  pipelineRecordForEnvironment,
  pruneKeyInformationAfterRewind,
  recordReviewIssuesInKeyInformation,
  recordVerdictInKeyInformation,
  type BuildPipelineKeyInformationHost,
  type KeyInformationView,
} from "./build-pipeline-key-information.js";
import { registerKeyInformationTools } from "./build-pipeline-key-information-tools.js";
import { keyInformationInstruction } from "./build-pipeline-prompts.js";
import { callToolInProcess, listToolsInProcess } from "./mcp-in-process.js";
import type { PersistedBuildPipeline } from "./models.js";
import { StorageService } from "./storage.js";

const SCOPE = { environmentId: "env-1", projectId: "project-1" };

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "claude",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-11-01T10:00:00.000Z",
    taskTitle: "Key information",
    taskSnapshot: {
      title: "Key information",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

function record(snapshot: BuildPipeline): PersistedBuildPipeline {
  return {
    version: 1,
    id: snapshot.id,
    projectId: snapshot.projectId,
    environmentId: snapshot.environmentId,
    snapshot: snapshot as unknown as Record<string, unknown>,
    updatedAt: snapshot.createdAt,
    revision: snapshot.backendRevision,
  } as PersistedBuildPipeline;
}

/** A host over in-memory records whose mutation applies to a copy and stores it. */
function memoryHost(
  pipelines: BuildPipeline[],
  options: { mutateDelayMs?: number; timeoutMs?: number } = {},
) {
  const store = new Map(pipelines.map((entry) => [entry.id, structuredClone(entry)]));
  const host = createBuildPipelineKeyInformationHost({
    listPipelines: async () => [...store.values()].map(record),
    mutate: async (pipelineId, mutation) => {
      if (options.mutateDelayMs) await Bun.sleep(options.mutateDelayMs);
      const candidate = structuredClone(store.get(pipelineId)!);
      await mutation(candidate);
      candidate.backendRevision += 1;
      store.set(pipelineId, candidate);
      return candidate;
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { host, store };
}

describe("pipelineRecordForEnvironment", () => {
  test("prefers an active pipeline, then the newest, and never another project's", () => {
    const old = pipeline({ id: "old", phase: "complete", createdAt: "2026-10-01T00:00:00.000Z" });
    const newer = pipeline({ id: "newer", phase: "failed", createdAt: "2026-10-05T00:00:00.000Z" });
    const active = pipeline({
      id: "active",
      phase: "verifying",
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const foreign = pipeline({ id: "foreign", projectId: "project-2" });
    const elsewhere = pipeline({ id: "elsewhere", environmentId: "env-2" });

    expect(pipelineRecordForEnvironment([old, newer, active, foreign].map(record), SCOPE)?.id).toBe(
      "active",
    );
    expect(pipelineRecordForEnvironment([old, newer].map(record), SCOPE)?.id).toBe("newer");
    expect(pipelineRecordForEnvironment([foreign, elsewhere].map(record), SCOPE)).toBeNull();
  });
});

describe("keyInformationAuthor", () => {
  test("follows the running phase, the paused phase, then the current session", () => {
    expect(keyInformationAuthor(pipeline({ phase: "addressing" }))).toBe("address");
    expect(keyInformationAuthor(pipeline({ phase: "paused", pausedFromPhase: "verifying" }))).toBe(
      "verify",
    );
    expect(keyInformationAuthor(pipeline({ phase: "complete" }))).toBe("build");
  });
});

describe("the key information host", () => {
  test("reads the owning pipeline's view and records an update as its stage and round", async () => {
    const { host, store } = memoryHost([pipeline({ phase: "fixing", iteration: 1 })]);

    const before = await host.read(SCOPE);
    expect(before).toMatchObject({
      pipelineId: "pipeline-1",
      round: 2,
      maxRounds: 3,
      author: "fix",
      keyInformation: null,
    });

    const after = await host.update(SCOPE, {
      statement: "The panel is missing.",
      issues: [{ issue: "A", resolution: "Done", status: "resolved" }],
    });
    expect(after.keyInformation?.statement).toBe("The panel is missing.");
    expect(after.keyInformation?.issues).toEqual([
      { round: 1, issue: "A", resolution: "Done", status: "resolved" },
    ]);
    expect(after.keyInformation?.updates.at(-1)).toMatchObject({ author: "fix", round: 1 });
    expect(store.get("pipeline-1")!.keyInformation).toEqual(after.keyInformation!);
  });

  test("has nothing for an environment no pipeline owns", async () => {
    const { host } = memoryHost([]);
    expect(await host.read(SCOPE)).toBeNull();
    await expect(host.update(SCOPE, { context: "x" })).rejects.toThrow("No build pipeline");
  });

  test("an update that waits too long is refused and never applied later", async () => {
    const { host, store } = memoryHost([pipeline()], { mutateDelayMs: 60, timeoutMs: 10 });
    await expect(host.update(SCOPE, { context: "late" })).rejects.toThrow("busy");
    await Bun.sleep(80);
    expect(store.get("pipeline-1")!.keyInformation).toBeUndefined();
  });
});

describe("what the supervisor records", () => {
  test("a review's issues, the verdict, and pruning after a rewind", () => {
    const subject = pipeline({ iteration: 1 });
    recordReviewIssuesInKeyInformation(
      subject,
      { iteration: 0 },
      { issues: [{ title: "Round one issue", severity: "P1" }] as never },
    );
    recordReviewIssuesInKeyInformation(
      subject,
      { iteration: 1 },
      { issues: [{ title: "Round two issue", severity: "P2" }] as never },
    );
    recordVerdictInKeyInformation(
      subject,
      { iteration: 1 },
      {
        passed: false,
        rationale: "Criterion failed",
        criteria: [{ id: "ac-1", text: "Header shows the timer" }],
        results: [{ id: "ac-1", status: "failed", evidence: "Not in the diff" }],
      },
    );
    expect(subject.keyInformation?.issues.map((issue) => [issue.round, issue.issue])).toEqual([
      [0, "Round one issue"],
      [1, "Round two issue"],
    ]);
    expect(subject.keyInformation?.verifications).toEqual([
      {
        round: 1,
        passed: false,
        summary: "Criterion failed",
        checks: [{ check: "Header shows the timer", passed: false, details: "Not in the diff" }],
      },
    ]);

    // A restart back into round one drops what round two recorded and the
    // verification of the round it reruns.
    pruneKeyInformationAfterRewind(subject, 0, false);
    expect(subject.keyInformation?.issues.map((issue) => issue.round)).toEqual([0]);
    expect(subject.keyInformation?.verifications).toEqual([]);
  });
});

describe("the key information tools", () => {
  function fixedHost(view: KeyInformationView | null): BuildPipelineKeyInformationHost & {
    patches: unknown[];
  } {
    const patches: unknown[] = [];
    return {
      patches,
      read: async () => view,
      update: async (_scope, patch) => {
        patches.push(patch);
        return view!;
      },
    };
  }

  const view: KeyInformationView = {
    pipelineId: "pipeline-1",
    taskTitle: "Key information",
    phase: "building",
    round: 1,
    maxRounds: 3,
    author: "build",
    keyInformation: null,
  };

  test("are registered only for an environment a pipeline owns", async () => {
    const listed = async (host: BuildPipelineKeyInformationHost) =>
      (
        await listToolsInProcess(async () => {
          const server = new McpServer({ name: "test", version: "1.0.0" });
          await registerKeyInformationTools(server, host, SCOPE);
          return server;
        })
      ).map((tool) => [tool.name, tool.readOnly]);

    expect(await listed(fixedHost(view))).toEqual([
      ["get_key_information", true],
      ["update_key_information", false],
    ]);
    const unowned = new McpServer({ name: "test", version: "1.0.0" });
    expect(await registerKeyInformationTools(unowned, fixedHost(null), SCOPE)).toBe(false);
  });

  test("pass an update through and refuse an empty one", async () => {
    const host = fixedHost(view);
    const factory = async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      await registerKeyInformationTools(server, host, SCOPE);
      return server;
    };

    const read = await callToolInProcess(factory, "get_key_information", {});
    expect(read.isError).toBe(false);
    expect(read.structuredContent).toMatchObject({ pipelineId: "pipeline-1", round: 1 });

    const update = {
      framing: "objective",
      decisions: [
        {
          decision: "Where",
          options: [{ option: "Header", pros: ["Visible"], cons: [] }],
          chosen: "Header",
        },
      ],
      verification: { summary: "ok", checks: [{ check: "a", passed: true }] },
    };
    const updated = await callToolInProcess(factory, "update_key_information", update);
    expect(updated.isError).toBe(false);
    expect(host.patches).toEqual([update]);

    const empty = await callToolInProcess(factory, "update_key_information", {});
    expect(empty.isError).toBe(true);
    const invalid = await callToolInProcess(factory, "update_key_information", {
      tests: [{ name: "a", result: "flaky" }],
    });
    expect(invalid.isError).toBe(true);
    expect(host.patches).toHaveLength(1);
  });
});

describe("AgentToolsServer with a key information host", () => {
  let dataDir: string;
  let server: AgentToolsServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "orkestrator-key-information-tools-"));
    server = new AgentToolsServer(new StorageService(dataDir), "127.0.0.1");
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function listTools(): Promise<Array<{ name: string; inputSchema?: unknown }>> {
    const { url, token } = server.connection("env-1", "project-1", "host");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = await response.text();
    const line = text.startsWith("{")
      ? text
      : text
          .split("\n")
          .find((entry) => entry.startsWith("data: "))
          ?.slice("data: ".length);
    return (JSON.parse(line ?? "{}") as { result?: { tools?: [] } }).result?.tools ?? [];
  }

  test("lists the tools, with portable schemas, only to an environment a pipeline owns", async () => {
    const names = async () => (await listTools()).map((tool) => tool.name);
    expect(await names()).not.toContain("update_key_information");

    let owned = false;
    server.setKeyInformationToolHost({
      read: async (scope) =>
        owned && scope.environmentId === "env-1"
          ? {
              pipelineId: "pipeline-1",
              taskTitle: "t",
              phase: "building",
              round: 1,
              maxRounds: 3,
              author: "build",
              keyInformation: null,
            }
          : null,
      update: async () => {
        throw new Error("unused");
      },
    });
    expect(await names()).not.toContain("update_key_information");

    owned = true;
    const tools = await listTools();
    for (const name of KEY_INFORMATION_TOOL_NAMES) {
      expect(tools.map((tool) => tool.name)).toContain(name);
    }
    const schema = JSON.stringify(
      tools.find((tool) => tool.name === "update_key_information")?.inputSchema,
    );
    expect(schema).not.toContain("$ref");
    expect(schema).not.toContain("$defs");
  });
});

describe("keyInformationInstruction", () => {
  test("asks Build, Fix, Address and Verify to keep the brief, and no other stage", () => {
    expect(keyInformationInstruction("build")).toContain("`framing`");
    expect(keyInformationInstruction("build")).toContain("pros and cons");
    expect(keyInformationInstruction("fix")).toContain("update_key_information");
    expect(keyInformationInstruction("address")).toContain("`issues`");
    expect(keyInformationInstruction("verify")).toContain("`verification`");
    for (const phase of ["review", "pr", "resolve-conflicts"] as const) {
      expect(keyInformationInstruction(phase)).toBe("");
    }
  });
});
