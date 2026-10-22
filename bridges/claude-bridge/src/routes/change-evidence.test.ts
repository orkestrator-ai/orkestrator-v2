import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ChangeEvidenceReadResponse } from "@orkestrator/protocol/change-evidence";
import {
  claudeChangeEvidence,
  recordClaudeToolResult,
  recordClaudeToolUse,
  resetClaudeChangeEvidenceForTesting,
} from "../services/change-evidence.js";

// The composition root, without a port; auth is enabled with a known token so
// these routes are proven to sit behind the same middleware as the transcript.
process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
const { app, __testing } = await import("../index.js");
const TOKEN = "change-evidence-test-token";
__testing.setBridgeAuthForTesting(TOKEN);
afterAll(() => __testing.setBridgeAuthForTesting());

const authorized = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  resetClaudeChangeEvidenceForTesting({ executor: "host-worker" });
});

function recordEdit(): void {
  recordClaudeToolUse("session-routes", {
    callId: "toolu_route",
    toolName: "Edit",
    input: { file_path: "/w/a.ts", old_string: "a\n", new_string: "b\n" },
  });
  recordClaudeToolResult("toolu_route", false);
}

describe("change-evidence routes", () => {
  test("require the bridge token", async () => {
    for (const [method, path] of [
      ["GET", "/change-evidence"],
      ["GET", "/change-evidence/body?id=x"],
      ["POST", "/change-evidence/ack"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(401);
    }
  });

  test("read returns the spool, bodies resolve, and an ack releases them", async () => {
    recordEdit();
    const read = (await (
      await app.request("/change-evidence", { headers: authorized })
    ).json()) as ChangeEvidenceReadResponse;
    expect(read.runtimeEpoch).toBe(claudeChangeEvidence().spool.runtimeEpoch);
    expect(read.entries).toHaveLength(2);
    expect(read.capabilities).toHaveLength(1);
    expect(read.nextCursor).toBe(read.entries.at(-1)!.seq);

    const frame = read.entries[0]!.type === "frame" ? read.entries[0]!.frame : undefined;
    const update = frame?.event.kind === "tool" ? frame.event.evidence[0] : undefined;
    const evidence = update?.kind === "replace" ? update.evidence : undefined;
    const before = evidence?.kind === "replacement" ? evidence.before : undefined;
    if (before?.state !== "present") throw new Error("expected a retained before side");
    const body = (await (
      await app.request(`/change-evidence/body?id=${encodeURIComponent(before.body.id)}`, {
        headers: authorized,
      })
    ).json()) as { state: string; base64: string };
    expect(body.state).toBe("available");
    expect(Buffer.from(body.base64, "base64").toString("utf8")).toBe("a\n");

    const ack = await app.request("/change-evidence/ack", {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({
        runtimeEpoch: read.runtimeEpoch,
        upTo: read.nextCursor,
        retainedBodyIds: [before.body.id],
        unavailableBodyIds: [],
      }),
    });
    expect(await ack.json()).toEqual({ ok: true, released: 2 });
    const after = (await (
      await app.request(`/change-evidence?cursor=0`, { headers: authorized })
    ).json()) as ChangeEvidenceReadResponse;
    expect(after.entries).toEqual([]);
    expect(claudeChangeEvidence().spool.readBody(before.body.id)).toBeNull();
  });

  test("an unknown body is answered in band, never 404", async () => {
    const response = await app.request("/change-evidence/body?id=sha256:nope", {
      headers: authorized,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "sha256:nope", state: "missing" });
  });

  test("a malformed ack is refused and releases nothing", async () => {
    recordEdit();
    const response = await app.request("/change-evidence/ack", {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ upTo: "all" }),
    });
    expect(response.status).toBe(400);
    expect(claudeChangeEvidence().spool.stats().entries).toBe(2);
  });
});
