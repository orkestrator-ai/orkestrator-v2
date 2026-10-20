/**
 * Test fixtures for workflow transcripts that render published artifacts
 * (Multi Review reviewer tabs, build-pipeline stages, feature planning).
 * Test-only: answers the transcript-artifact commands through the mocked
 * `invoke`, scoped by conversation the way the backend scopes them.
 */
import type { mock } from "bun:test";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
} from "@orkestrator/protocol/transcript-artifact-commands";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";

export const WORKFLOW_ARTIFACT_BACKEND = "backend-1";

export function workflowArtifactRef(
  artifactId: string,
  title: string,
  publicationId = `pub_${artifactId.slice(4)}`,
): TranscriptArtifactRef {
  return {
    schemaVersion: 1,
    artifactId,
    revision: 1,
    publicationId,
    kind: "chart",
    title,
    summary: `Summary of ${title}`,
    provenance: { backendId: WORKFLOW_ARTIFACT_BACKEND, origin: "agent" },
  };
}

export function workflowPublicationView(
  ref: TranscriptArtifactRef,
  options: { toolCallId?: string; publishedAt?: string; sequence?: number } = {},
): ArtifactPublicationView {
  return {
    ref,
    publishedAt: options.publishedAt ?? "2026-10-20T10:00:05.000Z",
    conversationSequence: options.sequence ?? 1,
    kind: ref.kind,
    ...(options.toolCallId ? { anchor: { toolCallId: options.toolCallId } } : {}),
    receipt: {
      receiptId: "rcpt_abcdefgh1",
      completedAt: "2026-10-20T10:00:04.000Z",
      profile: null,
      captures: [],
      semantics: "not-assessed",
    },
    source: { sha256: "a".repeat(64), byteLength: 10, effectiveSha256: "b".repeat(64) },
    availability: "available",
  } as ArtifactPublicationView;
}

/** A successful `publish_artifact` call on the workflow turn's artifact server. */
export function workflowPublishCall(toolUseId: string, artifactId: string) {
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

/**
 * Answers capabilities, the ledger and publication reads. The ledger lists a
 * conversation's publications only for its own environment and key.
 */
export function installWorkflowArtifactBackend(
  invokeMock: ReturnType<typeof mock>,
  ledgers: Array<{
    environmentId: string;
    logicalSessionKey: string;
    publications: ArtifactPublicationView[];
  }>,
): void {
  invokeMock.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
    const owned = ledgers.find(
      (ledger) =>
        ledger.environmentId === args.environmentId &&
        ledger.logicalSessionKey === args.logicalSessionKey,
    );
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) {
      return Promise.resolve({
        backendId: WORKFLOW_ARTIFACT_BACKEND,
        authoring: true,
        previewRenderer: { available: true, isolation: "container" },
        liveInteractive: true,
        contentOrigin: "http://127.0.0.1:9999",
        rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
      });
    }
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) {
      return Promise.resolve({ publications: owned?.publications ?? [], nextSequence: null });
    }
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) {
      const view = owned?.publications.find(
        (entry) => entry.ref.publicationId === args.publicationId,
      );
      return view
        ? Promise.resolve(view)
        : Promise.reject(new Error(JSON.stringify({ code: "not_found", message: "not found" })));
    }
    return Promise.resolve(undefined);
  });
}

/** The scopes the client asked the ledger for, in order. */
export function listedConversations(invokeMock: ReturnType<typeof mock>): string[] {
  return invokeMock.mock.calls
    .filter((call) => call[0] === TRANSCRIPT_ARTIFACT_COMMANDS.listPublications)
    .map((call) => {
      const args = call[1] as { environmentId: string; logicalSessionKey: string };
      return `${args.environmentId}/${args.logicalSessionKey}`;
    });
}
