/**
 * The display budget holds while nobody is reading the transcript.
 *
 * Every test here drives the real translator and never calls a read route or
 * `boundTranscriptForRead`: an inactive tab issues no transcript reads, and
 * `/activity` deliberately does not hydrate, so the producer path is the only
 * thing standing between a long turn and unbounded memory.
 */
import { describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { MAX_MESSAGE_TEXT_BYTES, MAX_PARTS_PER_MESSAGE, MAX_TRANSCRIPT_BYTES } from "./config.js";
import type { BridgeToolPart, SessionState } from "./state.js";
import { STREAM_BOUND_INTERVAL_BYTES } from "./transcript.js";
import { applyInteractionUpdate, settleBackgroundChildren } from "./translate.js";

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  return state;
}

const encodedBytes = (state: SessionState) => Buffer.byteLength(JSON.stringify(state.messages));

/** The documented transient bound: budget, one check interval, one admitted update. */
function transientCeiling(largestUpdateBytes: number): number {
  return MAX_TRANSCRIPT_BYTES + STREAM_BOUND_INTERVAL_BYTES + largestUpdateBytes;
}

function sourcePartIds(state: SessionState): string[] {
  return state.messages.flatMap((message) => message.parts.map((part) => part.sourcePartId));
}

describe("producer-side transcript bounds", () => {
  test("600 reasoning blocks with no reader stay within the part cap throughout", () => {
    // The validation probe: this used to retain all 600 parts.
    const state = running();
    for (let index = 0; index < 600; index += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: "x".repeat(1024) });
      applyInteractionUpdate(state, { type: "thinking-completed" });
      expect(state.messages.at(-1)!.parts.length).toBeLessThanOrEqual(MAX_PARTS_PER_MESSAGE);
    }
    expect(state.transcriptTruncated).toBe(true);
    expect(state.droppedParts).toBe(600 - MAX_PARTS_PER_MESSAGE);
    // Ids stay unique after the front of the message was shed.
    const ids = sourcePartIds(state);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("byte growth from many individually legal updates stays within the documented bound", () => {
    const state = running();
    const chunk = "é".repeat(256 * 1024); // 512 KiB of UTF-8 in 256 Ki UTF-16 units.
    const largestUpdate = Buffer.byteLength(chunk) * 2 + 4096;
    for (let index = 0; index < 80; index += 1) {
      applyInteractionUpdate(state, { type: "text-delta", text: chunk });
      applyInteractionUpdate(state, {
        type: "tool-call-started",
        callId: `read-${index}`,
        toolCall: { type: "read", args: { path: `f${index}.ts` } },
      });
      expect(encodedBytes(state)).toBeLessThanOrEqual(transientCeiling(largestUpdate));
    }
    expect(state.transcriptTruncated).toBe(true);
  });

  test("text charges are UTF-8 and escape aware rather than UTF-16 length", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "a" });
    const before = state.uncheckedTranscriptBytes;
    applyInteractionUpdate(state, { type: "text-delta", text: '中"\n' });
    // Part and message body both grow, each by 3 + 2 + 2 encoded bytes.
    expect(state.uncheckedTranscriptBytes - before).toBe(14);
  });

  test("an unobserved stream's charged bytes never lag the real growth", () => {
    const state = running();
    let measured = encodedBytes(state);
    for (let index = 0; index < 200; index += 1) {
      const unchecked = state.uncheckedTranscriptBytes;
      applyInteractionUpdate(state, {
        type: index % 3 === 0 ? "thinking-delta" : "text-delta",
        text: `line ${index} "quoted" \\ ${"😀".repeat(index % 7)}\n`,
      });
      if (index % 5 === 0) applyInteractionUpdate(state, { type: "thinking-completed" });
      const now = encodedBytes(state);
      if (state.uncheckedTranscriptBytes >= unchecked) {
        expect(state.uncheckedTranscriptBytes - unchecked).toBeGreaterThanOrEqual(now - measured);
      }
      measured = now;
    }
  });

  test("interleaved text, tools, summaries and nested updates keep lookups working after trims", () => {
    const state = running();
    for (let round = 0; round < 700; round += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: `why ${round}` });
      applyInteractionUpdate(state, { type: "thinking-completed" });
      applyInteractionUpdate(state, { type: "text-delta", text: `says ${round}` });
      if (round % 4 === 0) {
        applyInteractionUpdate(state, {
          type: "tool-call-started",
          callId: `call-${round}`,
          toolCall: { type: "read", args: { path: "a.ts" } },
        });
      }
      if (round % 9 === 0) applyInteractionUpdate(state, { type: "summary", summary: `s${round}` });
      if (round % 6 === 0) {
        applyInteractionUpdate(state, {
          type: "tool-call-delta",
          callId: `call-${round - (round % 4)}`,
          taskUpdate: { type: "text-delta", text: `child ${round}` },
        });
      }
    }
    const message = state.messages.at(-1)!;
    expect(message.parts.length).toBeLessThanOrEqual(MAX_PARTS_PER_MESSAGE);
    const ids = sourcePartIds(state);
    expect(new Set(ids).size).toBe(ids.length);

    // The open text block is still found by id: the next delta continues it
    // (prose stays one block across interleaved reasoning) instead of opening
    // a new part or landing in a part that merely reuses an evicted id.
    const openId = state.openTextParts.get("text\u0000");
    const before = message.parts.length;
    applyInteractionUpdate(state, { type: "text-delta", text: " and more" });
    expect(message.parts.length).toBe(before);
    const open = message.parts.find((part) => part.sourcePartId === openId);
    expect(open?.type).toBe("text");
    expect(open?.content.endsWith("says 699 and more")).toBe(true);
  });

  test("a running child stays active after its launch card is trimmed away", () => {
    const state = running();
    const launch = { type: "task", args: { description: "Background", prompt: "p" } };
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "launch",
      toolCall: launch,
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "launch",
      toolCall: {
        ...launch,
        result: {
          status: "success",
          value: { isBackground: true, backgroundReason: "agentRequest", agentId: "a1" },
        },
      },
    });
    for (let index = 0; index < MAX_PARTS_PER_MESSAGE + 10; index += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: "t" });
      applyInteractionUpdate(state, { type: "thinking-completed" });
    }
    const cards = state.messages
      .flatMap((message) => message.parts)
      .filter((part): part is BridgeToolPart => part.type === "tool-invocation");
    expect(cards.find((part) => part.toolUseId === "launch")).toBeUndefined();
    // Display trimming is not evidence that the child stopped.
    expect(state.activeSubagentDescriptors.has("launch")).toBe(true);
    settleBackgroundChildren(state);
    expect(state.activeSubagentDescriptors.size).toBe(0);
  });

  test("a single text part never outgrows its own byte cap while streaming", () => {
    const state = running();
    for (let index = 0; index < 40; index += 1) {
      applyInteractionUpdate(state, { type: "text-delta", text: "y".repeat(128 * 1024) });
    }
    const part = state.messages[0]!.parts[0]!;
    // The cap plus the "[output truncated]" marker appended once it saturates.
    const notice = Buffer.byteLength("\n\n[output truncated]");
    expect(Buffer.byteLength(part.content)).toBeLessThanOrEqual(MAX_MESSAGE_TEXT_BYTES + notice);
  });
});
