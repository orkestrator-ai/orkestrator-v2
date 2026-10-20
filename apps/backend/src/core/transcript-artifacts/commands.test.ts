import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import type { CommandContext, CommandHandler } from "../commands-context.js";
import { registerTranscriptArtifactCommands } from "./commands.js";
import { registerTranscriptArtifactPdfCommands } from "./commands-pdf.js";
import {
  CONVERSATION,
  ENV,
  PROJECT,
  SAMPLE_CHART,
  createHarness,
  key,
  settle,
  type Harness,
} from "./service-test-support.js";

let h: Harness;
const commands = new Map<string, CommandHandler>();
registerTranscriptArtifactCommands((name, handler) => commands.set(name, handler));
registerTranscriptArtifactPdfCommands(
  (name, handler) => commands.set(name, handler),
  (name) => commands.get(name),
);

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

function invoke(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const context = { transcriptArtifacts: h.service } as unknown as CommandContext;
  return Promise.resolve(commands.get(name)!(args as never, context));
}

async function publishChart(): Promise<string> {
  const created = await h.call("create_artifact", {
    requestKey: key(),
    draft: { title: "Sales/Q3", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } },
  });
  const op = await settle(
    h,
    (
      await h.call("preview_artifact", {
        requestKey: key(),
        artifactId: created.artifactId,
        revision: 1,
      })
    ).operationId,
  );
  const published = await h.call("publish_artifact", {
    requestKey: key(),
    artifactId: created.artifactId,
    expectedRevision: 1,
    receiptId: op.operation.receiptId,
  });
  return published.publicationId;
}

describe("transcript artifact commands", () => {
  test("registers every protocol command", () => {
    expect(Object.values(TRANSCRIPT_ARTIFACT_COMMANDS).every((name) => commands.has(name))).toBe(
      true,
    );
  });

  test("capabilities report backend identity, renderer status and rollout flags", async () => {
    const capabilities = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities);
    expect(capabilities).toMatchObject({
      backendId: h.service.backendId(),
      authoring: true,
      previewRenderer: { available: true, isolation: "process" },
      liveInteractive: true,
      contentOrigin: "http://localhost:4999",
      rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
    });
  });

  test("scoped reads, representations and structured failures", async () => {
    const publicationId = await publishChart();
    const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
    const listed = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.listPublications, scope);
    expect(
      listed.publications.map(
        (entry: { ref: { publicationId: string } }) => entry.ref.publicationId,
      ),
    ).toEqual([publicationId]);
    expect(listed.nextSequence).toBeNull();
    const csv = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, {
      ...scope,
      publicationId,
      representation: "chart-csv",
    });
    expect(csv.data).toContain("q1");
    expect(csv.filename).toBe("Sales Q3.csv");
    const svg = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, {
      ...scope,
      publicationId,
      representation: "rendered-svg",
    });
    expect(svg.mimeType).toBe("image/svg+xml");
    expect(svg.executableOutsideOrkestrator).toBe(false);

    const failure = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.getPublication, {
      environmentId: ENV,
      logicalSessionKey: "env-env-1:other",
      publicationId,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("not_found");
    expect(JSON.parse(failure.message)).toEqual({
      code: "not_found",
      message: "Publication not found",
      retryClass: "never",
    });
    const bad = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, {
      ...scope,
      publicationId,
      representation: "../../etc",
    }).catch((error) => error);
    expect(JSON.parse(bad.message).code).toBe("invalid_input");
  });

  test("draft inspection and asset staging commands are scoped and structured", async () => {
    const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
    const staged = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.stageAsset, {
      ...scope,
      name: "notes.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    expect(staged.assetRef).toMatch(/^stg-/);
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: {
        title: "Doc",
        summary: "",
        payload: { kind: "html-static", html: "<p>hi</p>" },
        assets: [{ name: "notes.txt", assetRef: staged.assetRef }],
      },
    });
    expect(created.isError).toBe(false);
    const listed = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.listDrafts, scope);
    expect(listed.drafts.map((draft: { artifactId: string }) => draft.artifactId)).toEqual([
      created.artifactId,
    ]);
    const source = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readDraft, {
      ...scope,
      artifactId: created.artifactId,
      representation: "source",
    });
    expect(source.data).toBe("<p>hi</p>");
    const foreign = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readDraft, {
      environmentId: ENV,
      logicalSessionKey: "env-env-1:other",
      artifactId: created.artifactId,
      representation: "source",
    }).catch((error) => error);
    expect(foreign.code).toBe("not_found");
    const unknown = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readDraft, {
      ...scope,
      artifactId: created.artifactId,
      representation: "../../etc/passwd",
    }).catch((error) => error);
    expect(unknown.code).toBe("invalid_input");
    const mismatch = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.stageAsset, {
      ...scope,
      name: "x.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("not a png").toString("base64"),
    }).catch((error) => error);
    expect(mismatch.code).toBe("policy_denied");
  });

  test("mermaid rendering caches successes and deterministic syntax failures", async () => {
    const ok = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, {
      source: "graph TD; A-->B",
      theme: "dark",
    });
    expect(ok).toMatchObject({
      ok: true,
      rendererVersion: "mermaid-renderer:v1",
      diagramType: "flowchart",
    });
    await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, {
      source: "graph TD; A-->B",
      theme: "dark",
    });
    const failed = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, {
      source: "SYNTAX_ERROR",
      theme: "light",
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "validation_failed", line: 1, column: 5 },
    });
    await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, {
      source: "SYNTAX_ERROR",
      theme: "light",
    });
    expect(h.runner.calls).toHaveLength(2);
    const tooLarge = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.renderMermaid, {
      source: "x".repeat(40_000),
      theme: "light",
    });
    expect(tooLarge.ok).toBe(false);
  });

  test("live workflow reads are separate and report deleted runs as unavailable", async () => {
    await h.storage.saveBuildPipeline("bp-1", PROJECT, ENV, 2, {
      id: "bp-1",
      phase: "building",
      sessions: [],
      currentSessionIndex: 0,
      projectId: PROJECT,
      environmentId: ENV,
    });
    const live = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot, {
      environmentId: ENV,
      workflowId: "build-pipeline",
      runId: "bp-1",
    });
    expect(live).toMatchObject({
      status: "available",
      terminal: false,
      snapshot: { runId: "bp-1", status: "running" },
    });
    const gone = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot, {
      environmentId: ENV,
      workflowId: "build-pipeline",
      runId: "bp-gone",
    });
    expect(gone).toMatchObject({ status: "unavailable", reason: "deleted" });
    const otherEnv = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot, {
      environmentId: "env-2",
      workflowId: "build-pipeline",
      runId: "bp-1",
    });
    expect(otherEnv.status).toBe("unavailable");
  });

  test("close_live_session revokes the capability", async () => {
    await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession, { generation: "gen-7" });
    expect(h.content.revoked).toEqual(["gen-7"]);
  });
});
