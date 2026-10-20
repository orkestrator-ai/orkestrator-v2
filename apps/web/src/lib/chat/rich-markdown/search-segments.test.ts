import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  getNativeMessageSearchProjection,
  getNativeMessageSearchText,
} from "@/components/chat/native-message-search";
import { findAgentChatTextMatches } from "@/components/chat/AgentChatFind";
import { markdownSearchProjection, markdownSearchText } from "./markdown-search";
import {
  decodeBlockViewKey,
  modelMatchGroup,
  pairBlockGroups,
  searchGroupId,
  type SearchGroup,
} from "./search-segments";
import { richBlockViewKey } from "@/lib/chat/rich-identity";

const CONTENT = [
  "Prose 🚀 has the needle.",
  "",
  "<details>",
  "<summary>Hidden notes</summary>",
  "",
  "The needle hides here, with a fence:",
  "",
  "```ts",
  "const needle = 1;",
  "```",
  "",
  "</details>",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[needle] --> B",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| needle | 1 |",
  "",
  "```chart",
  "not a chart",
  "```",
].join("\n");

function message(parts: string[]): NativeMessage {
  return {
    id: "m-1",
    role: "assistant",
    content: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    parts: parts.map((content, index) => ({
      type: "text" as const,
      content,
      sourcePartId: `part-${index}`,
    })),
  };
}

describe("semantic search projection", () => {
  test("segments are the outermost keyed blocks with UTF-16 source and text offsets", () => {
    const projection = markdownSearchProjection(CONTENT, { rich: true });
    expect(projection.text).toBe(markdownSearchText(CONTENT, { rich: true }));
    const detailsStart = CONTENT.indexOf("<details>");
    const mermaidStart = CONTENT.indexOf("```mermaid");
    const tableStart = CONTENT.indexOf("| Name");
    // The emoji is two UTF-16 code units: offsets are string indices.
    expect(CONTENT.indexOf("has")).toBe("Prose 🚀 ".length);
    expect(projection.segments.map((segment) => [segment.kind, segment.blockId])).toEqual([
      ["details", `details:${detailsStart}`],
      ["diagram", `code:${mermaidStart}`],
      ["table", `table:${tableStart}`],
    ]);
    for (const segment of projection.segments) {
      expect(segment.sourceStart).toBe(Number(segment.blockId.split(":")[1]));
      expect(segment.sourceEnd).toBeGreaterThan(segment.sourceStart!);
      expect(projection.text.slice(segment.start, segment.end)).toContain("needle");
    }
    // The fence nested in the disclosure belongs to the disclosure's segment.
    const details = projection.segments[0]!;
    expect(projection.text.slice(details.start, details.end)).toContain("const needle = 1;");
    expect(details.reveal).toBe("open-disclosure");
    expect(projection.segments[1]!.reveal).toBe("show-source");
    // A chart fence is not keyed: its searchable labels sit beside the chart.
    expect(projection.segments.some((segment) => segment.kind === "code")).toBe(false);
  });

  test("message projections equal the search text and number segments by part", () => {
    const fence = "```ts\nconst x = 1;\n```";
    const msg = message([fence, `Intro\n\n${fence}`]);
    const projection = getNativeMessageSearchProjection(msg);
    expect(projection.text).toBe(getNativeMessageSearchText(msg));
    expect(projection.segments.map((segment) => [segment.part, segment.blockId])).toEqual([
      [0, "code:0"],
      [1, `code:${"Intro\n\n".length}`],
    ]);
    for (const segment of projection.segments) {
      expect(projection.text.slice(segment.start, segment.end)).toBe("const x = 1;");
    }
  });

  test("every match maps to its own block or prose", () => {
    const msg = message([CONTENT]);
    const projection = getNativeMessageSearchProjection(msg);
    const groups = findAgentChatTextMatches(projection.text, "needle").map((match) =>
      searchGroupId(modelMatchGroup(projection, match.characterIndex)),
    );
    const detailsId = `details:${CONTENT.indexOf("<details>")}`;
    const diagramId = `code:${CONTENT.indexOf("```mermaid")}`;
    const tableId = `table:${CONTENT.indexOf("| Name")}`;
    expect(groups).toEqual([
      "prose",
      `block\u00000\u0000${detailsId}`,
      `block\u00000\u0000${detailsId}`,
      `block\u00000\u0000${diagramId}`,
      `block\u00000\u0000${tableId}`,
    ]);
  });

  test("DOM block keys decode to part and block id; repeated block ids pair by part order", () => {
    const scope = { backendId: "b", environmentId: "e", logicalSessionKey: "s", generation: "g" };
    expect(decodeBlockViewKey(richBlockViewKey(scope, "m-1", "part-b", "code:0"))).toEqual({
      sourcePartId: "part-b",
      blockId: "code:0",
    });
    expect(decodeBlockViewKey('["artifact","b","e","s","m","p","a",1]')).toBeNull();
    const block = (part: string, blockId = "code:0") =>
      ({ type: "block", part, blockId }) as Extract<SearchGroup, { type: "block" }>;
    const pairs = pairBlockGroups(
      [block("1"), block("0"), block("0", "table:9")],
      [block("part-a"), block("part-b"), block("part-a", "table:9")],
    );
    expect(pairs.get(searchGroupId(block("0")))).toBe(searchGroupId(block("part-a")));
    expect(pairs.get(searchGroupId(block("1")))).toBe(searchGroupId(block("part-b")));
    expect(pairs.get(searchGroupId(block("0", "table:9")))).toBe(
      searchGroupId(block("part-a", "table:9")),
    );
  });
});
