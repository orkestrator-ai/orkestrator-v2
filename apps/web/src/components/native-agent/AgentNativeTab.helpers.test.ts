import { expect, test } from "bun:test";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import { extractNativePlanContent } from "./AgentNativeTab.helpers";

function message(parts: NativeMessagePart[]): NativeMessage {
  return {
    id: "plan",
    role: "assistant",
    content: "",
    parts,
    createdAt: "2026-10-31T10:00:00.000Z",
  };
}

const write: NativeMessagePart = {
  type: "tool-invocation",
  content: "Write",
  toolName: "Write",
  toolArgs: { file_path: "/home/u/.claude/plans/feature-plan.md", content: "Full plan" },
};

test("plan extraction ignores deferred previews, including nested tool groups", () => {
  expect(extractNativePlanContent([message([write])])).toBe("Full plan");
  const preview = { ...write, toolArgsDetailRef: "deferred-plan" };
  expect(extractNativePlanContent([message([preview])])).toBeUndefined();
  expect(
    extractNativePlanContent([message([{ type: "tool-group", content: "", parts: [preview] }])]),
  ).toBeUndefined();
  // A later preview must not replace a complete plan already available.
  expect(extractNativePlanContent([message([write, preview])])).toBe("Full plan");
});
