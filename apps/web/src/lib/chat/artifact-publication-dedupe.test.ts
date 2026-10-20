import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_PUBLICATION_MESSAGE_PREFIX,
  artifactPartContent,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import type { ClaudeMessage } from "@/lib/claude-types";
import { dedupeArtifactPublications } from "./artifact-publication-dedupe";
import {
  messageHasVisibleContent,
  normalizeClaudeMessagesForDisplay,
  normalizeNativeMessage,
  normalizeNativeMessages,
} from "./native-message-adapters";
import type { NativeArtifactPart, NativeMessage, NativeMessagePart } from "./native-message-types";
import { artifactPartSearchText, chartSpecSearchText } from "./rich-search-text";
import { REPRESENTATIVE_BAR_CHART } from "@orkestrator/protocol/testing/rich-content-fixtures";

function ref(publicationId: string): TranscriptArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: "art_abcdefgh1",
    revision: 1,
    publicationId,
    kind: "chart",
    title: "Outcomes",
    summary: "Synthetic chart",
    provenance: { backendId: "backend-1", origin: "agent" },
  };
}

function artifactPart(publicationId: string): NativeArtifactPart {
  const artifact = ref(publicationId);
  return {
    type: "artifact",
    content: artifactPartContent(artifact),
    artifact,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
    sourcePartId: `artifact:${publicationId}`,
  };
}

function publishCall(toolUseId = "call-1"): NativeMessagePart {
  return {
    type: "tool-invocation",
    content: "",
    toolName: "mcp__orkestrator__publish_artifact",
    toolUseId,
    toolState: "success",
    toolArgs: { artifactId: "art_abcdefgh1", expectedRevision: 1 },
  };
}

function message(
  id: string,
  parts: NativeMessagePart[],
  extra: Partial<NativeMessage> = {},
): NativeMessage {
  return {
    id,
    role: "assistant",
    content: "",
    parts,
    createdAt: "2026-10-20T10:00:00.000Z",
    ...extra,
  };
}

describe("dedupeArtifactPublications", () => {
  test("returns the same array when every publication appears once", () => {
    const messages = [message("m1", [publishCall(), artifactPart("pub_one1234567")])];
    expect(dedupeArtifactPublications(messages)).toBe(messages);
  });

  test("drops a standalone publication row whose publication is anchored beside its publish call", () => {
    const anchored = message("m1", [publishCall(), artifactPart("pub_one1234567")]);
    const standalone = message(`${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_one1234567`, [
      artifactPart("pub_one1234567"),
    ]);
    expect(dedupeArtifactPublications([standalone, anchored])).toEqual([anchored]);
    expect(dedupeArtifactPublications([anchored, standalone])).toEqual([anchored]);
  });

  test("prefers the occurrence beside a publish call over a later provider echo", () => {
    const echo = message("m2", [{ type: "text", content: "done" }, artifactPart("pub_one1234567")]);
    const anchored = message("m1", [publishCall(), artifactPart("pub_one1234567")]);
    const result = dedupeArtifactPublications([echo, anchored]);
    expect(result).toHaveLength(2);
    expect(result[0]!.parts.map((part) => part.type)).toEqual(["text"]);
    expect(result[1]).toBe(anchored);
    // Rewritten rows are reused across calls so row identity stays stable.
    expect(dedupeArtifactPublications([echo, anchored])[0]).toBe(result[0]);
  });

  test("keeps a standalone row when no anchored occurrence is loaded", () => {
    const standalone = message(`${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_two1234567`, [
      artifactPart("pub_two1234567"),
    ]);
    expect(dedupeArtifactPublications([standalone])).toEqual([standalone]);
  });
});

describe("artifact parts through normalization", () => {
  test("survive provider-neutral normalization outside tool groups and count as visible", () => {
    const rows = normalizeNativeMessages([
      message("m1", [
        { type: "thinking", content: "plan" },
        publishCall(),
        {
          type: "tool-invocation",
          content: "",
          toolName: "Read",
          toolUseId: "read-1",
          toolState: "success",
        },
        artifactPart("pub_one1234567"),
      ]),
    ]);
    const parts = rows.flatMap((row) => row.parts);
    const artifact = parts.find((part) => part.type === "artifact");
    expect(artifact).toBeDefined();
    const group = parts.find((part) => part.type === "tool-group");
    expect(
      group && group.type === "tool-group" && group.parts.some((part) => part.type === "artifact"),
    ).toBe(false);
    const artifactRow = rows.find((row) => row.parts.some((part) => part.type === "artifact"))!;
    expect(messageHasVisibleContent(artifactRow)).toBe(true);
  });

  test("a row whose only part is an artifact is visible and never merged into adjacent tool rows", () => {
    const toolRow = message("m1", [publishCall()]);
    const artifactRow = message(`${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_one1234567`, [
      artifactPart("pub_one1234567"),
    ]);
    const nextTools = message("m2", [
      {
        type: "tool-invocation",
        content: "",
        toolName: "Read",
        toolUseId: "r",
        toolState: "success",
      },
    ]);
    const rows = normalizeNativeMessages([toolRow, artifactRow, nextTools]);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.parts.map((part) => part.type)).toEqual(["artifact"]);
  });

  test("is not adopted by a task group even with a parent task id", () => {
    const task: NativeMessagePart = {
      type: "tool-invocation",
      content: "",
      toolName: "Task",
      toolUseId: "task-1",
      agentState: "active",
    };
    const normalized = normalizeNativeMessage(
      message("m1", [task, { ...artifactPart("pub_one1234567"), parentTaskUseId: "task-1" }]),
    );
    expect(normalized.parts.some((part) => part.type === "artifact")).toBe(true);
  });

  test("survive the Claude display path and are de-duplicated there too", () => {
    const claude = (id: string, parts: NativeMessagePart[]): ClaudeMessage =>
      ({
        id,
        role: "assistant",
        content: "",
        parts,
        createdAt: "2026-10-20T10:00:00.000Z",
      }) as ClaudeMessage;
    const rows = normalizeClaudeMessagesForDisplay([
      claude("c1", [
        { type: "text", content: "Here is the chart" },
        publishCall(),
        artifactPart("pub_one1234567"),
      ]),
      claude(`${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_one1234567`, [
        artifactPart("pub_one1234567"),
      ]),
    ]);
    const artifacts = rows.flatMap((row) => row.parts).filter((part) => part.type === "artifact");
    expect(artifacts).toHaveLength(1);
  });
});

describe("rich search text", () => {
  test("chart search text includes title, description, series and category labels", () => {
    const text = chartSpecSearchText(REPRESENTATIVE_BAR_CHART);
    for (const expected of [
      "Illustrative test outcomes",
      "Synthetic fixture",
      "Run A",
      "Run B",
      "Unit",
      "Integration",
      "Browser",
      "Passed tests",
    ]) {
      expect(text).toContain(expected);
    }
  });

  test("artifact search text is the textual summary and reference text", () => {
    const text = artifactPartSearchText(artifactPart("pub_one1234567"));
    expect(text).toContain("[Artifact: Outcomes (chart, revision 1) — Synthetic chart]");
    expect(text).toContain("Outcomes");
    expect(artifactPartSearchText({ content: "only", artifact: null as never })).toBe("only");
  });
});
