import { describe, expect, test } from "bun:test";
import type { BridgeConnection } from "./native-agent-provider.js";
import {
  ACP_BRIDGE_MAX_BODY_BYTES,
  httpProvider,
  declineResolution,
} from "./agent-provider-test-support.js";

describe("HTTP bridge provider (ACP)", () => {
  const cursorConnection: BridgeConnection = {
    agent: "cursor",
    baseUrl: "http://cursor.test",
    authToken: "cursor-token",
    requestTimeoutMs: 25,
  };

  test("uses bearer auth and exposes ACP permissions to the fail-closed monitor", async () => {
    let pending = true;
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const { provider, requests } = httpProvider((url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer cursor-token");
      if (url.endsWith("/approvals/approval-1")) {
        expect(JSON.parse(String(init.body))).toEqual({ decision: "deny" });
        pending = false;
        return Response.json({ resolved: true });
      }
      if (url.endsWith("/approvals")) {
        return Response.json({
          approvals: pending
            ? [
                {
                  approvalId: "approval-1",
                  kind: "permissions",
                  permissions: { fileSystem: true },
                  actionable: true,
                  requestedAt,
                  expiresAt,
                },
              ]
            : [],
        });
      }
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      return Response.json({ sessionId: "cursor-1" });
    }, cursorConnection);

    await provider.createSession("review", "Cursor review");
    const snapshot = await provider.interactions!.listPendingInteractions("cursor-1");
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.requests[0]).toMatchObject({ provider: "cursor", kind: "permission" });
    const outcome = await provider.interactions!.resolveInteraction(
      "cursor-1",
      snapshot.requests[0]!.id,
      declineResolution(snapshot.requests[0]!),
    );
    expect(outcome.result).toBe("applied");
    expect(requests[0]?.url).toBe("http://cursor.test/session/create");
  });

  test("passes the ACP bridge's usage and runtime through to the projection", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          status: "idle",
          messages: [],
          revision: 4,
          composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
          contextUsage: {
            usedTokens: 15_675,
            inputTokens: 15_639,
            outputTokens: 36,
            cacheReadTokens: 5_888,
            reasoningTokens: 31,
            apiDurationMs: 1_448,
            durationMs: 3_925,
            modelId: "grok-4.6",
            source: "provider",
            updatedAt: "2026-08-14T18:25:46.435Z",
          },
          runtime: {
            mcpServers: 1,
            commands: 41,
            version: "1.0.3",
            state: "idle",
            // Not part of the summary contract, and must not reach the renderer.
            secretPath: "/Users/someone/.grok/auth.json",
          },
        }),
      cursorConnection,
    );

    const snapshot = await provider.interactiveSnapshot!("cursor-1");

    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 15_675,
      cacheReadTokens: 5_888,
      apiDurationMs: 1_448,
      modelId: "grok-4.6",
      source: "provider",
    });
    expect(snapshot.runtime).toEqual({
      mcpServers: 1,
      commands: 41,
      version: "1.0.3",
      state: "idle",
    });
  });

  test("omits ACP usage and runtime the bridge did not report", async () => {
    // Cursor reports no token counts at all. The panel must be told nothing
    // rather than be handed a zeroed meter to render.
    const { provider } = httpProvider(
      () =>
        Response.json({
          status: "idle",
          messages: [],
          revision: 1,
          composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
          runtime: {},
        }),
      cursorConnection,
    );

    const snapshot = await provider.interactiveSnapshot!("cursor-1");

    expect(snapshot.contextUsage).toBeUndefined();
    expect(snapshot.runtime).toBeUndefined();
  });

  test("forwards ACP composer options on session creation and prompt dispatch", async () => {
    const { provider, requests } = httpProvider(
      (url) =>
        url.endsWith("/session/create")
          ? Response.json({ sessionId: "cursor-1" })
          : Response.json({ accepted: true }, { status: 202 }),
      cursorConnection,
    );

    await provider.createSession("build", "Configured Cursor", {
      clientSessionKey: "env-1:tab-1",
      model: "composer-2.5",
      effort: "high",
      mode: "plan",
      fastMode: true,
    });
    await provider.send("cursor-1", "Do the work", {
      requestId: "request-1",
      model: "gpt-5.5",
      effort: "medium",
      mode: "build",
      fastMode: false,
    });

    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      title: "Configured Cursor",
      clientSessionKey: "env-1:tab-1",
      model: "composer-2.5",
      reasoningEffort: "high",
      mode: "plan",
      fastMode: true,
    });
    expect(requests[1]?.url).toBe("http://cursor.test/session/cursor-1/prompt");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      prompt: "Do the work",
      requestId: "request-1",
      fastMode: false,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      mode: "build",
    });
  });

  test("stages and forwards image attachments to the ACP prompt route", async () => {
    const { provider, requests } = httpProvider(
      (url) =>
        url.endsWith("/session/create")
          ? Response.json({ sessionId: "cursor-1" })
          : Response.json({ accepted: true }, { status: 202 }),
      cursorConnection,
    );

    await provider.createSession("build", "Cursor");
    // Both ACP agents read inline image content blocks, so an attachment is
    // dispatched like any other provider's rather than refused here.
    await provider.send("cursor-1", "Look at this", {
      requestId: "request-1",
      attachments: [{ type: "image", path: "/workspace/shot.png", filename: "shot.png" }],
      images: [{ filename: "pasted.png", data: "AA==" }],
    });

    // Exact, not partial: the staged `dataUrl` must be gone. The ACP bridge
    // reads the workspace file itself and ignores it, and its request body is
    // capped, so forwarding a copy only costs that budget.
    expect(JSON.parse(String(requests[1]?.init.body)).attachments).toEqual([
      { type: "image", path: "/workspace/shot.png", filename: "shot.png" },
      {
        type: "image",
        path: "/workspace/.orkestrator/initial-prompt/pasted.png",
        filename: "pasted.png",
      },
    ]);
  });

  test("keeps a staged image out of the ACP prompt body", async () => {
    const { provider, requests } = httpProvider(
      (url) =>
        url.endsWith("/session/create")
          ? Response.json({ sessionId: "cursor-1" })
          : Response.json({ accepted: true }, { status: 202 }),
      cursorConnection,
    );

    await provider.createSession("build", "Cursor");
    // 3MB of image data: inside the ACP bridge's 8MB per-image ceiling, and far
    // outside its request-body limit if the data URL travelled alongside the
    // path. A screenshot this size used to come back as a terminal HTTP 413.
    await provider.send("cursor-1", "Look at this", {
      requestId: "request-1",
      images: [{ filename: "pasted.png", data: "A".repeat(4 * 1024 * 1024) }],
    });

    const body = String(requests[1]?.init.body);
    expect(Buffer.byteLength(body)).toBeLessThan(ACP_BRIDGE_MAX_BODY_BYTES);
    expect(JSON.parse(body).attachments).toEqual([
      {
        type: "image",
        path: "/workspace/.orkestrator/initial-prompt/pasted.png",
        filename: "pasted.png",
      },
    ]);
  });

  test("gives Cursor, Grok, and Pi enough time for cold session creation", async () => {
    const timeouts: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ((ms: number) => {
      timeouts.push(ms);
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;
    try {
      for (const agent of ["cursor", "grok", "pi"] as const) {
        timeouts.length = 0;
        const { provider } = httpProvider(
          () => Response.json({ sessionId: `${agent}-1` }, { status: 201 }),
          { agent, baseUrl: `http://${agent}.test`, authToken: `${agent}-token` },
        );
        await provider.createSession("build", `${agent} session`);
        expect(timeouts).toEqual([75_000]);
      }

      timeouts.length = 0;
      const { provider } = httpProvider(
        () => Response.json({ sessionId: "claude-1" }, { status: 201 }),
        { agent: "claude", baseUrl: "http://claude.test", authToken: "claude-token" },
      );
      await provider.createSession("build", "Claude session");
      expect(timeouts).toEqual([30_000]);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  test("surfaces the bounded ACP session-creation error detail", async () => {
    const { provider } = httpProvider(
      () => Response.json({ error: "Authentication required" }, { status: 500 }),
      cursorConnection,
    );

    await expect(provider.createSession("build", "Cursor")).rejects.toThrow(
      "cursor session creation is temporarily unavailable (HTTP 500): Authentication required",
    );
  });
});
