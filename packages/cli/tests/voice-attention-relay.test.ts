import { describe, expect, test } from "bun:test";
import type { PublicAttentionItem } from "@orkestrator/protocol/public-api-resources";
import {
  attentionPageFromResponse,
  attentionSentence,
  runRelay,
} from "../examples/voice-attention-relay.js";

const APPROVAL: PublicAttentionItem = {
  kind: "interaction",
  at: "2026-10-24T10:00:00.000Z",
  sessionId: "ses_abc",
  environmentId: "env-1",
  environmentName: "auth-fix",
  agent: "claude",
  interactionId: "approval-1",
  interactionKind: "command-approval",
  revision: 2,
  blocking: true,
  title: "Run rm -rf dist",
};

function toolResponse(items: PublicAttentionItem[], cursor: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "1",
    result: {
      structuredContent: {
        ok: true,
        action: "attention.list",
        result: { items, more: 0, counts: { interactions: 1, runs: 0, setups: 0 }, cursor },
      },
    },
  });
}

describe("voice attention relay", () => {
  test("polls attention.list with the cursor and emits each item once", async () => {
    const cursors: unknown[] = [];
    let polls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer relay-token");
        const body = (await request.json()) as {
          params: { name: string; arguments: { action: string; input: { cursor?: string } } };
        };
        expect(body.params).toMatchObject({
          name: "run_action",
          arguments: { action: "attention.list" },
        });
        cursors.push(body.params.arguments.input.cursor);
        polls += 1;
        return new Response(toolResponse([APPROVAL], `att1-${polls}`), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    try {
      await runRelay({
        url: `http://127.0.0.1:${server.port}/mcp`,
        token: "relay-token",
        intervalMs: 5,
        signal: controller.signal,
        emit: (record) => {
          emitted.push(record);
        },
        // Stop once the same item has come back on a later poll.
        onPoll: () => {
          if (polls >= 3) controller.abort();
        },
      });
    } finally {
      server.stop(true);
    }
    expect(emitted).toEqual([
      { type: "attention", say: "claude in auth-fix is asking: Run rm -rf dist", item: APPROVAL },
    ]);
    expect(cursors.slice(0, 3)).toEqual([undefined, "att1-1", "att1-2"]);
  });

  test("parses JSON and SSE responses and words every item kind", async () => {
    const page = attentionPageFromResponse(toolResponse([APPROVAL], "att1-x"), "application/json");
    expect(page.cursor).toBe("att1-x");
    const sse = attentionPageFromResponse(
      `event: message\ndata: ${toolResponse([], "att1-y")}\n\n`,
      "text/event-stream",
    );
    expect(sse.cursor).toBe("att1-y");
    expect(() =>
      attentionPageFromResponse(
        JSON.stringify({ result: { structuredContent: { ok: false, error: { code: "busy" } } } }),
        "application/json",
      ),
    ).toThrow("busy");
    expect(attentionSentence(APPROVAL)).toBe("claude in auth-fix is asking: Run rm -rf dist");
    expect(
      attentionSentence({
        kind: "setup",
        at: APPROVAL.at,
        environmentId: "env-1",
        environmentName: "auth-fix",
        phase: "failed",
      }),
    ).toBe("auth-fix setup failed");
    expect(
      attentionSentence({
        kind: "run",
        at: APPROVAL.at,
        operationId: "op-1",
        action: "session.prompt",
        state: "succeeded",
        sessionId: null,
        environmentId: null,
        errorCode: null,
      }),
    ).toBe("session.prompt finished");
  });
});
