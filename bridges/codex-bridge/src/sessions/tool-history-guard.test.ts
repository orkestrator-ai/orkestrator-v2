import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLLOUT_CHUNK_BYTES } from "../rollout-reader.js";
import {
  MAX_TOOL_HISTORY_LINEAGE_DEPTH,
  TOOL_HISTORY_MARKER,
  rolloutDeclaresToolHistory,
  threadToolHistoryVerdict,
} from "./tool-history-guard.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tool-history-guard-"));
  roots.push(root);
  return root;
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const meta = (payload: Record<string, unknown> = {}) =>
  line({ type: "session_meta", payload: { id: "t", ...payload } });
/** The record codex 0.164 writes with `incremental_tools` on. */
const declared = line({
  type: "response_item",
  payload: { type: "additional_tools", tools: [{ name: "exec", description: "web__run" }] },
});
const said = (text: string) =>
  line({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });

describe("tool history guard", () => {
  test("finds a tool declaration anywhere in a rollout, across read boundaries", async () => {
    const root = await dir();
    const path = join(root, "rollout.jsonl");
    // Puts the marker across the first chunk boundary.
    const padding = said("x".repeat(ROLLOUT_CHUNK_BYTES - 40));
    await writeFile(path, meta() + padding + declared);
    expect(declared).toContain(TOOL_HISTORY_MARKER);
    expect(await rolloutDeclaresToolHistory(path)).toBe(true);
    // Not within the prefix a fork inherited.
    expect(await rolloutDeclaresToolHistory(path, meta().length)).toBe(false);
  });

  test("text that quotes the marker is not a declaration", async () => {
    const root = await dir();
    const path = join(root, "rollout.jsonl");
    await writeFile(path, meta() + said(TOOL_HISTORY_MARKER));
    expect(await threadToolHistoryVerdict(path, async () => null)).toBe("clean");
  });

  test("follows a fork's history to its ancestor, up to the forked offset", async () => {
    const root = await dir();
    const parent = join(root, "parent.jsonl");
    const child = join(root, "child.jsonl");
    const parentHead = meta();
    await writeFile(parent, parentHead + said("hello") + declared);
    const fork = (end: number) =>
      writeFile(child, meta({ history_base: { thread_id: "parent", end_byte_offset: end } }));
    const resolve = async (id: string) => (id === "parent" ? parent : null);

    await fork(parentHead.length);
    expect(await threadToolHistoryVerdict(child, resolve)).toBe("clean");
    await fork(parentHead.length + said("hello").length + declared.length);
    expect(await threadToolHistoryVerdict(child, resolve)).toBe("declares");
  });

  test("an ancestor that cannot be found or read is unknown, never clean", async () => {
    const root = await dir();
    const child = join(root, "child.jsonl");
    await writeFile(child, meta({ history_base: { thread_id: "gone" } }));
    expect(await threadToolHistoryVerdict(child, async () => null)).toBe("unknown");
    expect(await threadToolHistoryVerdict(join(root, "missing.jsonl"), async () => null)).toBe(
      "unknown",
    );
    const broken = join(root, "broken.jsonl");
    await writeFile(broken, '{"type":"session_meta","payload":\n');
    expect(await threadToolHistoryVerdict(broken, async () => null)).toBe("unknown");
  });

  test("a lineage longer than the bound is unknown", async () => {
    const root = await dir();
    const path = join(root, "loop.jsonl");
    // A fork that names itself would otherwise never end.
    await writeFile(path, meta({ history_base: { thread_id: "loop" } }));
    expect(MAX_TOOL_HISTORY_LINEAGE_DEPTH).toBeGreaterThan(0);
    expect(await threadToolHistoryVerdict(path, async () => path)).toBe("unknown");
  });
});
