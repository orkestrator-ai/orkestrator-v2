/**
 * Published transcript artifacts on workflow transcripts that read their
 * providers directly: build-pipeline stage transcripts (the `get_build_pipeline`
 * read) and Multi Review reviewer reads (conditional tokens). The reviewer
 * service read itself is covered in `multi-review-service.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactPublication } from "@orkestrator/protocol/transcript-artifacts";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { BuildPipelineService } from "./build-pipeline-service.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { readReviewerTranscript } from "./multi-review-reviewer-transcript.js";
import type { ArtifactLedgerReader } from "./native-agent-service-projection-artifacts.js";
import { StorageService } from "./storage.js";
import { WorkflowTranscriptArtifacts } from "./workflow-transcript-artifacts.js";

const ENV = "env-pipeline";

/** The ledger read surface over an in-memory list; `leaky` ignores the owner filter. */
function workflowLedger(options: { leaky?: boolean } = {}) {
  const publications: ArtifactPublication[] = [];
  const owned = (entry: ArtifactPublication, environmentId: string, conversationKey: string) =>
    options.leaky ||
    (entry.owner.environmentId === environmentId &&
      entry.owner.conversationKey === conversationKey);
  const reader: ArtifactLedgerReader = {
    publicationsForConversation(environmentId, conversationKey, read = {}) {
      return publications
        .filter((entry) => owned(entry, environmentId, conversationKey))
        .filter((entry) => entry.conversationSequence > (read.afterSequence ?? 0))
        .slice(0, read.limit ?? 1_000);
    },
    ledgerRevision(environmentId, conversationKey) {
      return publications
        .filter((entry) => owned(entry, environmentId, conversationKey))
        .reduce((max, entry) => Math.max(max, entry.conversationSequence), 0);
    },
  };
  const publish = (input: {
    environmentId?: string;
    conversationKey: string;
    artifactId: string;
    toolCallId?: string;
  }): ArtifactPublication => {
    const environmentId = input.environmentId ?? ENV;
    const sequence =
      publications.filter((entry) => entry.owner.conversationKey === input.conversationKey).length +
      1;
    const publicationId = `pub_wf${String(publications.length + 1).padStart(8, "0")}`;
    const publication: ArtifactPublication = {
      schemaVersion: 1,
      publicationId,
      artifactId: input.artifactId,
      revision: 1,
      receiptId: `rcpt_${publicationId}`,
      owner: {
        backendId: "backend-test",
        projectId: "project-1",
        environmentId,
        conversationKey: input.conversationKey,
      },
      conversationSequence: sequence,
      publishedAt: "2026-10-20T00:00:01.000Z",
      ...(input.toolCallId ? { anchor: { toolCallId: input.toolCallId } } : {}),
      ref: {
        schemaVersion: 1,
        artifactId: input.artifactId,
        revision: 1,
        publicationId,
        kind: "chart",
        title: "Stage chart",
        summary: "A chart the stage published.",
        provenance: { backendId: "backend-test", origin: "agent" },
      },
    };
    publications.push(publication);
    return publication;
  };
  return { reader, publish };
}

function publishCall(toolUseId: string, artifactId: string) {
  return {
    type: "tool-invocation",
    content: "publish_artifact",
    toolName: "mcp__orkestrator-artifacts__publish_artifact",
    toolUseId,
    toolState: "success",
    toolArgs: { artifactId, expectedRevision: 1 },
    toolOutput: '{"ok":true}',
  };
}

function artifactIds(row: unknown): string[] {
  const parts = (row as { parts?: Array<Record<string, any>> }).parts ?? [];
  return parts.filter((part) => part.type === "artifact").map((part) => part.artifact.artifactId);
}

async function withPipeline(
  run: (input: {
    invoke: (args: Record<string, unknown>) => Promise<any>;
    ledger: ReturnType<typeof workflowLedger>;
  }) => Promise<void>,
  ledgerOptions: { leaky?: boolean } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-stage-artifacts-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: ENV,
    projectId: "project-1",
    name: "pipeline",
    branch: "change",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/pipeline",
    setupScriptsComplete: true,
  });
  const ledger = workflowLedger(ledgerOptions);
  const pipelines = new BuildPipelineService(storage, async () => undefined as never, {
    autoAdvance: false,
    provider: async () => ({}) as BuildPipelineProvider,
    artifactLedger: () => ledger.reader,
  });
  try {
    const sessions: PipelineSession[] = [];
    for (const key of ["stage-build", "stage-review"]) {
      const body = [
        { id: `${key}-0`, role: "user", content: "Do the work" },
        {
          id: `${key}-1`,
          role: "assistant",
          content: "",
          parts: [publishCall(`toolu_${key}`, `art_${key}`)],
        },
        { id: `${key}-2`, role: "assistant", content: "Done" },
      ];
      const committed = await storage.commitBuildPipelineTranscript({
        pipelineId: "p1",
        sessionKey: key,
        sdkSessionId: `sdk-${key}`,
        messages: body,
        revision: 1,
        fingerprint: transcriptFingerprint(body),
      });
      if (committed.status !== "staged") throw new Error("commit failed");
      sessions.push({
        phase: key === "stage-build" ? "build" : "review",
        iteration: 0,
        sessionKey: key,
        sdkSessionId: `sdk-${key}`,
        status: "idle",
        startedAt: "2026-10-20T00:00:00.000Z",
        label: key,
        messageRevision: 1,
        messagesFingerprint: committed.fingerprint,
        transcript: committed.reference,
      });
    }
    await storage.saveBuildPipeline("p1", "project-1", ENV, 1, {
      id: "p1",
      environmentId: ENV,
      phase: "reviewing",
      sessions,
      currentSessionIndex: 1,
    });
    const handler = createCommandRegistry().get("get_build_pipeline")!;
    const context = { storage, buildPipelines: pipelines } as unknown as CommandContext;
    await run({ invoke: async (args) => handler(args, context), ledger });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("build-pipeline stage transcripts", () => {
  test("a stage's publication appears beside the publish call in its own patch only", async () => {
    await withPipeline(async ({ invoke, ledger }) => {
      ledger.publish({
        conversationKey: "stage-build",
        artifactId: "art_stage-build",
        toolCallId: "toolu_stage-build",
      });
      // Anchored by arguments: no recorded tool call id.
      ledger.publish({ conversationKey: "stage-review", artifactId: "art_stage-review" });
      // Another environment's publication under the same session key never appears.
      ledger.publish({
        environmentId: "env-other",
        conversationKey: "stage-build",
        artifactId: "art_stage-build",
      });

      const read = await invoke({ pipelineId: "p1", knownSessions: {} });
      const patches = new Map<string, unknown[]>(
        read.messagePatches.map((patch: { sessionKey: string; messages: unknown[] }) => [
          patch.sessionKey,
          patch.messages,
        ]),
      );
      const build = patches.get("stage-build")!;
      const review = patches.get("stage-review")!;
      expect(build.map(artifactIds)).toEqual([[], ["art_stage-build"], []]);
      expect(review.map(artifactIds)).toEqual([[], ["art_stage-review"], []]);
      // The part sits after the call in the same row, as in a native tab.
      expect(
        (build[1] as { parts: Array<{ type: string }> }).parts.map((part) => part.type),
      ).toEqual(["tool-invocation", "artifact"]);
    });
  });

  test("publications of other conversations are refused even from a leaky ledger", async () => {
    await withPipeline(
      async ({ invoke, ledger }) => {
        ledger.publish({
          conversationKey: "stage-review",
          artifactId: "art_stage-build",
          toolCallId: "toolu_stage-build",
        });
        ledger.publish({
          environmentId: "env-other",
          conversationKey: "stage-build",
          artifactId: "art_stage-build",
        });
        const read = await invoke({ pipelineId: "p1", knownSessions: {} });
        for (const patch of read.messagePatches as Array<{
          sessionKey: string;
          messages: unknown[];
        }>) {
          if (patch.sessionKey !== "stage-build") continue;
          expect(patch.messages.flatMap(artifactIds)).toEqual([]);
        }
      },
      { leaky: true },
    );
  });
});

describe("reviewer transcript reads", () => {
  test("a ledger change makes the read ignore a token issued before it", async () => {
    const offered: Array<string | undefined> = [];
    const provider = {
      async transcriptSnapshot(
        _sessionId: string,
        options: { knownSourceToken?: string },
      ): Promise<any> {
        offered.push(options.knownSourceToken);
        if (options.knownSourceToken === "provider-token") {
          return { unchanged: true, sourceToken: "provider-token" };
        }
        return { messages: [], sourceToken: "provider-token", complete: true };
      },
    } as unknown as BuildPipelineProvider;

    const first = await readReviewerTranscript(
      provider,
      "session-1",
      undefined,
      undefined,
      undefined,
      "artifacts-1",
    );
    const token = first.sourceToken!;
    const same = await readReviewerTranscript(
      provider,
      "session-1",
      token,
      undefined,
      undefined,
      "artifacts-1",
    );
    expect(same.kind).toBe("unchanged");
    const moved = await readReviewerTranscript(
      provider,
      "session-1",
      token,
      undefined,
      undefined,
      "artifacts-2",
    );
    expect(moved.kind).toBe("snapshot");
    expect(offered).toEqual([undefined, "provider-token", undefined]);
  });

  test("placement keeps rows it does not change and refuses a foreign owner", () => {
    const ledger = workflowLedger({ leaky: true });
    ledger.publish({ conversationKey: "reviewer-b", artifactId: "art_1", toolCallId: "toolu_1" });
    const placement = new WorkflowTranscriptArtifacts(() => ledger.reader);
    const rows = [{ id: "r1", role: "assistant", parts: [publishCall("toolu_1", "art_1")] }];
    expect(placement.place(ENV, "reviewer-a", rows)).toBe(rows);
    expect(placement.revision(ENV, "reviewer-a")).toBe(1);
    expect(new WorkflowTranscriptArtifacts(undefined).place(ENV, "reviewer-a", rows)).toBe(rows);
  });
});
