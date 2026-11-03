/**
 * Session titles from a first message whose transcript-annotation envelope is
 * as large as the composer allows (0081 task 3): the title must be the user's
 * request whichever display bound the message passes through, never part of
 * the envelope.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { bridgeTranscriptSummaryUpdate } from "@orkestrator/protocol/node/bridge-transcript-summary";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/node/progressive-transcript";
import {
  MAX_TRANSCRIPT_ANNOTATIONS,
  MAX_TRANSCRIPT_ANNOTATION_COMMENT_LENGTH,
  MAX_TRANSCRIPT_ANNOTATION_TEXT_LENGTH,
  buildPromptWithTranscriptAnnotations,
} from "@orkestrator/protocol/transcript-annotations";

import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

import { codexConnection } from "./agent-provider-test-support.js";
import { readHttpBridgeSummaryTranscript } from "./http-bridge-transcript-v2.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
const request = "Compare these two excerpts";

/**
 * Every annotation at its text and comment limit. `<` is escaped to six
 * characters inside the envelope and a CJK character is three UTF-8 bytes, so
 * the message is several times the bridge's live window.
 */
function promptAtAnnotationLimits(): string {
  const text = "<界".repeat(MAX_TRANSCRIPT_ANNOTATION_TEXT_LENGTH / 2);
  const comment = "界".repeat(MAX_TRANSCRIPT_ANNOTATION_COMMENT_LENGTH);
  const prompt = buildPromptWithTranscriptAnnotations(
    request,
    Array.from({ length: MAX_TRANSCRIPT_ANNOTATIONS }, (_, index) => ({
      id: `excerpt-${index}`,
      text,
      comment,
      source: "transcript" as const,
    })),
  );
  expect(Buffer.byteLength(prompt)).toBeGreaterThan(liveWindow.targetBytes);
  return prompt;
}

function userRow(content: string) {
  return {
    id: "user-1",
    role: "user" as const,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-11-03T10:00:00.000Z",
  };
}

function expectNoEnvelope(title: string | undefined): void {
  expect(title ?? "").not.toContain("orkestrator_transcript_annotations");
  expect(title ?? "").not.toContain("selectedText");
  expect(title ?? "").not.toContain("界");
}

describe("session titles at the transcript-annotation limits", () => {
  test("a snapshot projection titles the session from the request", async () => {
    const prompt = promptAtAnnotationLimits();
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        title: "Agent Session",
        messages: [userRow(prompt)],
      }),
      setSessionTitle: async () => undefined,
    });
    await withService(
      { prefix: "orkestrator-title-annotation-limits-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-annotation-limits",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.title).toBe(request);
        await waitForCondition(() => stub.setSessionTitle?.mock.calls.length === 1);
        expect(stub.setSessionTitle).toHaveBeenCalledWith("provider-session", request);
      },
    );
  });

  test.each(["v1", "v2"] as const)(
    "%s live window that keeps only the tail of the message never titles from it",
    async (version) => {
      const prompt = promptAtAnnotationLimits();
      const rows = [userRow(prompt)];
      // The real bridge bound: a lone row over the live window keeps only the
      // last 64 KiB of its content, which starts inside the envelope.
      const buildUpdate = version === "v2" ? bridgeTranscriptSummaryUpdate : bridgeTranscriptUpdate;
      const update = buildUpdate(rows, {
        sessionIdentity: "session-1",
        generation: 1,
        contentEpoch: 1,
        revision: 1,
        limit: liveWindow.messages,
        targetBytes: liveWindow.targetBytes,
        complete: true,
      });
      if (update.status !== "snapshot") throw new Error("expected bridge snapshot");
      const trimmed = (update.value.messages[0] as { content: string }).content;
      expect(trimmed.length).toBeLessThan(prompt.length);
      expect(prompt.endsWith(trimmed)).toBe(true);
      expect(trimmed).not.toContain(request);

      expect(update.value.messageWindow.omittedParts).toBeGreaterThan(0);
      // Use the real HTTP v2 parser and provider mapping, rather than copying
      // omittedParts into a stub snapshot and bypassing the adapter under test.
      const summary =
        version === "v2"
          ? await readHttpBridgeSummaryTranscript({
              agent: "codex",
              connection: codexConnection,
              sessionId: "provider-session",
              options: { limit: liveWindow.messages, targetBytes: liveWindow.targetBytes },
              fetchImpl: (async (input) => {
                const url = new URL(String(input));
                expect(url.pathname).toBe("/session/provider-session/transcript");
                expect(url.searchParams.get("version")).toBe("2");
                return Response.json(update);
              }) as typeof fetch,
            })
          : undefined;
      if (summary && (summary.kind !== "summary" || "unchanged" in summary.result)) {
        throw new Error("expected v2 summary snapshot");
      }
      const snapshot =
        summary?.kind === "summary"
          ? summary.result
          : {
              ...update.value,
              omittedParts: update.value.messageWindow.omittedParts,
              historyStartIndex: update.value.startIndex,
              sourceToken: update.token,
              historyEpoch: "1:1",
            };
      if ("unchanged" in snapshot) throw new Error("expected snapshot");
      if (version === "v2") {
        expect(snapshot.representation).toBe("summary");
        expect(snapshot.omittedParts).toBe(update.value.messageWindow.omittedParts);
      }
      const stub = createProviderStub("codex", {
        transcriptSnapshot: async () => snapshot,
        // Hydration has the whole row, as the provider's own history does.
        messages: async () => rows,
        setSessionTitle: async () => undefined,
      });
      await withService(
        { prefix: "orkestrator-title-annotation-tail-", provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: "env-env-1:tab-annotation-tail",
          };
          await service.ensureSession(identity);
          const read = () =>
            service.getTranscriptUpdate({
              ...identity,
              viewVersion: 1,
              liveWindow,
              forceSnapshot: true,
            });
          const preview = await read();
          if (preview.status !== "snapshot") throw new Error("expected snapshot");
          expectNoEnvelope(preview.value.title);
          expectNoEnvelope((await service.getProjection(identity))?.title);
          // Once the whole row is read the title is the request, and it is the
          // only title ever offered to the provider.
          await waitForCondition(() => stub.setSessionTitle?.mock.calls.length === 1);
          expect(stub.setSessionTitle).toHaveBeenCalledWith("provider-session", request);
          const settled = await read();
          if (settled.status !== "snapshot") throw new Error("expected snapshot");
          expect(settled.value.title).toBe(request);
        },
      );
    },
  );
});
