import { describe, expect, test } from "bun:test";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
  ProviderUnreachableError,
  readProviderStatus,
} from "./native-agent-provider.js";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  httpProvider,
} from "./agent-provider-test-support.js";

describe("HTTP bridge provider", () => {
  const operations = {
    create: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.createSession("build", "Build task"),
    send: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.send("session-1", "Build it", { requestId: "request-1" }),
    status: (provider: ReturnType<typeof httpProvider>["provider"]) => provider.status("session-1"),
    messages: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.messages("session-1"),
    structured: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.structured("session-1", "request-1"),
    abort: (provider: ReturnType<typeof httpProvider>["provider"]) => provider.abort("session-1"),
  };

  test("creates sessions with authenticated, agent-specific payloads", async () => {
    const { provider, requests } = httpProvider(() => Response.json({ sessionId: "session-1" }));

    await expect(provider.createSession("build", "Build task")).resolves.toBe("session-1");
    const request = requests[0]!;
    expect(request.url).toBe("http://claude.test/session/create");
    expect(new Headers(request.init.headers).get("X-Orkestrator-Claude-Token")).toBe("test-token");
    expect(JSON.parse(String(request.init.body))).toEqual({ title: "Build task" });
  });

  test.each([
    ["cursor" as const, cursorConnection],
    ["grok" as const, grokConnection],
  ])("lists and resumes %s ACP sessions through the bridge", async (_agent, connection) => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/session/list")) {
        return Response.json({
          sessions: [
            {
              id: "opaque-session",
              title: "Previous work",
              updatedAt: "2026-08-14T20:00:00.000Z",
              messageCount: 7,
            },
          ],
        });
      }
      if (url.endsWith("/session/resume")) {
        return Response.json({ sessionId: "bridge-session" }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }, connection);

    await expect(provider.listResumableSessions?.()).resolves.toEqual([
      {
        sessionId: "opaque-session",
        title: "Previous work",
        updatedAt: "2026-08-14T20:00:00.000Z",
        detail: "7 messages",
      },
    ]);
    await expect(
      provider.resumeSession?.("opaque-session", {
        modelId: "model-a",
        reasoningId: "high",
        mode: "plan",
        fastMode: true,
      }),
    ).resolves.toBe("bridge-session");

    expect(requests.map((request) => [request.url, request.init.method ?? "GET"])).toEqual([
      [`${connection.baseUrl}/session/list`, "GET"],
      [`${connection.baseUrl}/session/resume`, "POST"],
    ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      sessionId: "opaque-session",
      modelId: "model-a",
      reasoningId: "high",
      mode: "plan",
      fastMode: true,
    });
  });

  for (const [agent, connection] of [
    ["cursor" as const, cursorConnection],
    ["grok" as const, grokConnection],
  ] as const) {
    test(`rejects malformed ${agent} ACP session responses`, async () => {
      const malformedList = httpProvider(
        (url) =>
          url.endsWith("/session/list")
            ? Response.json({ sessions: "not-an-array" })
            : new Response(null, { status: 404 }),
        connection,
      );
      await expect(malformedList.provider.listResumableSessions?.()).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );

      const malformedResume = httpProvider(
        (url) =>
          url.endsWith("/session/resume")
            ? Response.json({ status: "idle" }, { status: 201 })
            : new Response(null, { status: 404 }),
        connection,
      );
      await expect(
        malformedResume.provider.resumeSession?.("opaque-session"),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    });

    test(`surfaces why ${agent} cannot list its own ACP sessions`, async () => {
      const { provider } = httpProvider(
        (url) =>
          url.endsWith("/session/list")
            ? Response.json(
                { error: `${agent} cannot list resumable ACP sessions` },
                { status: 410 },
              )
            : new Response(null, { status: 404 }),
        connection,
      );

      // A bare "HTTP 410" tells the user nothing actionable; the bridge's own
      // explanation has to survive the hop.
      await expect(provider.listResumableSessions?.()).rejects.toThrow(
        `${agent} cannot list resumable ACP sessions`,
      );
    });
  }

  test("treats a successful empty structured result as pending", async () => {
    const { provider } = httpProvider(() => Response.json({ structuredOutput: null }));

    await expect(provider.structured("session-1", "request-1")).resolves.toBeNull();
  });

  test("does not disguise structured-output transport failures as pending", async () => {
    for (const status of [404, 429, 500]) {
      const { provider } = httpProvider(() => new Response(null, { status }));
      const promise = provider.structured("session-1", "request-1");
      if (status >= 429) {
        await expect(promise).rejects.toBeInstanceOf(ProviderUnavailableError);
      } else {
        await expect(promise).rejects.toThrow(`failed (HTTP ${status})`);
      }
    }
  });

  for (const status of [408, 425, 429, 500]) {
    test(`classifies HTTP ${status} as transient for every operation`, async () => {
      for (const operation of Object.values(operations)) {
        const { provider } = httpProvider(() => new Response(null, { status }));
        await expect(operation(provider)).rejects.toBeInstanceOf(ProviderUnavailableError);
      }
    });
  }

  test("keeps semantic 4xx responses out of reconnect recovery", async () => {
    const missing = httpProvider(() => new Response(null, { status: 404 }));
    await expect(missing.provider.status("session-1")).resolves.toBe("missing");

    const rejected = httpProvider(() => new Response(null, { status: 400 }));
    await expect(
      rejected.provider.send("session-1", "Build it", {
        requestId: "request-1",
      }),
    ).rejects.toBeInstanceOf(PromptRejectedError);

    for (const operation of [
      operations.create,
      operations.messages,
      operations.structured,
      operations.abort,
    ]) {
      const { provider } = httpProvider(() => new Response(null, { status: 400 }));
      let caught: unknown;
      try {
        await operation(provider);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test("maps prompt rejection separately from a transient dispatch failure", async () => {
    const rejected = httpProvider(() => new Response(null, { status: 400 }));
    await expect(rejected.provider.send("s", "prompt", { requestId: "r" })).rejects.toBeInstanceOf(
      PromptRejectedError,
    );

    const unavailable = httpProvider(() => new Response(null, { status: 503 }));
    await expect(
      unavailable.provider.send("s", "prompt", { requestId: "r" }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    for (const status of [404, 409]) {
      const raced = httpProvider(() => new Response(null, { status }));
      await expect(raced.provider.send("s", "prompt", { requestId: "r" })).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    }

    const ambiguous = httpProvider(() => {
      throw new Error("socket closed");
    });
    await expect(ambiguous.provider.send("s", "prompt", { requestId: "r" })).rejects.toBeInstanceOf(
      AmbiguousPromptDispatchError,
    );
  });

  test("keeps a bridge that was never reached out of the ambiguous bucket", async () => {
    // Bun reports both a refused connection and a failed DNS lookup this way;
    // Node/undici wraps a POSIX code on `cause`. Neither wrote a byte, so the
    // turn provably did not run and parking it for the user would be wrong.
    for (const failure of [
      Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" }),
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      }),
    ]) {
      const unreachable = httpProvider(() => {
        throw failure;
      });
      const send = unreachable.provider.send("s", "prompt", { requestId: "r" });
      await expect(send).rejects.toBeInstanceOf(ProviderUnreachableError);
      await expect(send).rejects.not.toBeInstanceOf(AmbiguousPromptDispatchError);
    }
  });

  test("keeps an aborted in-flight dispatch ambiguous", async () => {
    // The opposite case, and the reason the split has to be conservative: the
    // request was written, so the bridge may well have accepted it.
    const timedOut = httpProvider(() => {
      throw Object.assign(new Error("The operation timed out."), {
        name: "TimeoutError",
      });
    });
    await expect(timedOut.provider.send("s", "prompt", { requestId: "r" })).rejects.toBeInstanceOf(
      AmbiguousPromptDispatchError,
    );
  });

  test.each([
    ["cursor" as const, cursorConnection],
    ["grok" as const, grokConnection],
  ])(
    "attaches a %s session before dispatch and tolerates older bridges",
    async (_agent, connection) => {
      const attached = httpProvider(() => Response.json({ attached: true }), connection);
      await attached.provider.prepareDispatch?.("session-1");
      expect(attached.requests.map((request) => [request.url, request.init.method])).toEqual([
        [`${connection.baseUrl}/session/session-1/attach`, "POST"],
      ]);

      // A bridge that predates the route must not fail the dispatch that follows:
      // the prompt request performs the same work and answers authoritatively.
      const older = httpProvider(() => new Response(null, { status: 404 }), connection);
      await expect(older.provider.prepareDispatch?.("session-1")).resolves.toBeUndefined();

      const broken = httpProvider(() => new Response(null, { status: 500 }), connection);
      await expect(broken.provider.prepareDispatch?.("session-1")).rejects.toThrow();
    },
  );

  test("does not attach agents whose prompt route has no cold start", async () => {
    for (const connection of [claudeConnection, codexConnection]) {
      const { provider, requests } = httpProvider(() => Response.json({}), connection);
      await provider.prepareDispatch?.("session-1");
      expect(requests).toEqual([]);
    }
  });

  test("reads dispatch status and treats every non-positive answer as unknown", async () => {
    const dispatched = httpProvider(() => Response.json({ dispatch: "dispatched" }));
    await expect(dispatched.provider.dispatchStatus?.("s/1", "r/1")).resolves.toBe("dispatched");
    expect(dispatched.requests[0]!.url).toBe(
      "http://claude.test/session/s%2F1/dispatch?requestId=r%2F1",
    );

    // A bridge with no such route, an unknown session, an unparseable body and
    // an explicit `unknown` are all the same fact: no evidence it ran.
    const unknown = [
      () => Response.json({ dispatch: "unknown" }),
      () => new Response(null, { status: 404 }),
      () => new Response("not json", { status: 200 }),
      () => Response.json({}),
    ];
    for (const handler of unknown) {
      const { provider } = httpProvider(handler);
      await expect(provider.dispatchStatus?.("s", "r")).resolves.toBe("unknown");
    }
  });

  test("returns only the newest messages a bounded read asked for", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/messages")) {
        return Response.json({
          messages: [{ id: "a" }, { id: "b" }, { id: "c" }],
        });
      }
      return Response.json({});
    });

    // The bridge route has no tail parameter, so a caller that asked for the
    // newest entry must not be handed the whole transcript to compare or retain.
    await expect(provider.messages("session-1", { limit: 1 })).resolves.toEqual([{ id: "c" }]);
    expect(requests[0]!.url).toBe("http://claude.test/session/session-1/messages");
    expect(requests[0]!.url.includes("limit")).toBe(false);
    await expect(provider.messages("session-1", { limit: 2 })).resolves.toEqual([
      { id: "b" },
      { id: "c" },
    ]);
    // A limit above the transcript length is satisfied by the whole transcript.
    await expect(provider.messages("session-1", { limit: 10 })).resolves.toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
    await expect(provider.messages("session-1", {})).resolves.toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
    // A nonsensical bound fails loudly rather than silently reading everything.
    await expect(provider.messages("session-1", { limit: 0 })).rejects.toThrow(RangeError);
    await expect(provider.messages("session-1", { limit: -1 })).rejects.toThrow(RangeError);
    await expect(provider.messages("session-1", { limit: 1.5 })).rejects.toThrow(RangeError);
  });

  test("a bounded messages read still fails when the full wire body is oversized", async () => {
    const oversized = new Uint8Array(1);
    Object.defineProperty(oversized, "byteLength", { value: 16 * 1024 * 1024 + 1 });
    const { provider } = httpProvider(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized);
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );

    // limit trims after the transport bound, so an oversized /messages body
    // cannot be hidden by asking for the newest entry only.
    await expect(provider.messages("session-1", { limit: 1 })).rejects.toThrow(
      "transcript read is oversized",
    );
  });

  test("reads status and messages, dispatches prompts, and aborts sessions", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/session/session%2F1")) {
        return Response.json({ status: "running" });
      }
      if (url.endsWith("/messages")) {
        return Response.json({ messages: [{ role: "assistant" }] });
      }
      return Response.json({});
    });

    await expect(provider.status("session/1")).resolves.toBe("running");
    await expect(provider.messages("session/1")).resolves.toEqual([{ role: "assistant" }]);
    await provider.send("session/1", "Build it", {
      requestId: "request-1",
      fastMode: true,
      images: [{ filename: "screen.webp", data: "AA==" }],
    });
    await provider.abort("session/1");

    expect(requests.map((request) => request.url)).toEqual([
      "http://claude.test/session/session%2F1",
      "http://claude.test/session/session%2F1/messages",
      "http://claude.test/session/session%2F1/prompt",
      "http://claude.test/session/session%2F1/abort",
    ]);
    // Every bridge validator requires `path`: the Claude route rejects the whole
    // request without one and the Codex route silently drops the entry. So a
    // base64 image is staged into the workspace and attached by path.
    expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
      prompt: "Build it",
      requestId: "request-1",
      fastMode: true,
      permissionMode: "bypassPermissions",
      attachments: [
        {
          type: "image",
          path: "/workspace/.orkestrator/initial-prompt/screen.webp",
          filename: "screen.webp",
          dataUrl: "data:image/webp;base64,AA==",
        },
      ],
    });
  });

  test("projects Claude's authoritative plan mode in the interactive snapshot", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({ status: "idle", title: "Claude's title", planMode: true });
    });

    await expect(provider.interactiveSnapshot?.("session-1")).resolves.toMatchObject({
      status: "idle",
      title: "Claude's title",
      controls: { mode: "plan" },
    });
  });

  test("bounds Claude launch correlation metadata at the bridge boundary", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({
        status: "idle",
        backgroundTasks: {
          valid: {
            status: "running",
            description: "Run validation",
            toolUseId: "tool-launch-1",
          },
          oversized: {
            status: "paused",
            toolUseId: "x".repeat(513),
          },
        },
      });
    });

    const snapshot = await provider.interactiveSnapshot!("session-1");

    expect(snapshot.backgroundTasks).toEqual([
      {
        id: "valid",
        status: "running",
        description: "Run validation",
        toolUseId: "tool-launch-1",
      },
      {
        id: "oversized",
        status: "paused",
      },
    ]);
  });

  test("carries a terminal task's settle position and withholds a live one's", async () => {
    /*
     * `settledAt` is the position a finished card holds in the transcript, so it
     * is the backend's answer to "where does this belong" rather than a detail.
     * A live task has no position — it belongs at the bottom until it stops —
     * and a stale edge left on one that was revived would drag its card back up
     * the conversation.
     */
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({
        status: "idle",
        backgroundTasks: {
          finished: {
            status: "completed",
            endedAt: Date.parse("2026-08-17T10:30:00.000Z"),
          },
          revived: {
            status: "running",
            endedAt: Date.parse("2026-08-17T10:00:00.000Z"),
          },
          unstamped: { status: "failed" },
        },
      });
    });

    const snapshot = await provider.interactiveSnapshot!("session-1");

    expect(snapshot.backgroundTasks).toEqual([
      {
        id: "finished",
        status: "completed",
        settledAt: "2026-08-17T10:30:00.000Z",
      },
      { id: "revived", status: "running" },
      { id: "unstamped", status: "failed" },
    ]);
  });

  test("withholds a settle position the bridge's clock cannot express", async () => {
    /*
     * `endedAt` crosses a process boundary, so a value that is not a real epoch
     * has to be survivable: `new Date(...).toISOString()` throws on one, and
     * this runs inside snapshot normalization for every task in the session. No
     * position is the right answer anyway — the card stays in its launch row
     * rather than being placed by a number nothing vouches for.
     */
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({
        status: "idle",
        backgroundTasks: {
          "out-of-range": { status: "completed", endedAt: 1e300, startedAt: 1e300 },
          "not-a-number": { status: "completed", endedAt: Number.NaN },
          "wrong-type": {
            status: "failed",
            endedAt: "2026-08-17T10:30:00.000Z",
            startedAt: "2026-08-17T10:00:00.000Z",
          },
        },
      });
    });

    const snapshot = await provider.interactiveSnapshot!("session-1");

    expect(snapshot.backgroundTasks).toEqual([
      { id: "out-of-range", status: "completed" },
      { id: "not-a-number", status: "completed" },
      { id: "wrong-type", status: "failed" },
    ]);
  });

  test("carries a task's launch clock whatever its lifecycle", async () => {
    /*
     * Unlike the settle position, this is meaningful while the task runs: it is
     * the only clock the card for a task with no transcript row has of its own,
     * and a tab that resumes into a running task has the snapshot before it has
     * any row to borrow one from.
     */
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({
        status: "idle",
        backgroundTasks: {
          live: { status: "running", startedAt: Date.parse("2026-08-17T10:00:00.000Z") },
          done: {
            status: "completed",
            startedAt: Date.parse("2026-08-17T10:00:00.000Z"),
            endedAt: Date.parse("2026-08-17T10:30:00.000Z"),
          },
        },
      });
    });

    const snapshot = await provider.interactiveSnapshot!("session-1");

    expect(snapshot.backgroundTasks).toEqual([
      { id: "live", status: "running", startedAt: "2026-08-17T10:00:00.000Z" },
      {
        id: "done",
        status: "completed",
        startedAt: "2026-08-17T10:00:00.000Z",
        settledAt: "2026-08-17T10:30:00.000Z",
      },
    ]);
  });

  test("reads the ACP snapshot as a small status plus a bounded transcript", async () => {
    /*
     * The whole-session route returned composer, runtime and the entire
     * transcript in one body, so metadata competed with messages for the same
     * byte budget and a large transcript failed the read outright. Status now
     * comes from its own small response and the messages from the bounded
     * transcript route.
     */
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/messages")) {
        return Response.json({
          messages: [{ id: "m-1", role: "assistant", content: "from transcript", parts: [] }],
          messageWindow: { truncated: false },
        });
      }
      return Response.json({
        status: "idle",
        revision: 7,
        composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
        // A status body that still carried messages must not be the source: it
        // is the transcript route that applies the byte ceiling.
        messages: [{ id: "stale", role: "assistant", content: "from status", parts: [] }],
      });
    }, cursorConnection);

    const snapshot = await provider.interactiveSnapshot!("cursor-1");

    expect(requests.map((request) => request.url).sort()).toEqual([
      "http://cursor.test/session/cursor-1/messages",
      "http://cursor.test/session/cursor-1/status",
    ]);
    expect(snapshot.messages).toEqual([
      { id: "m-1", role: "assistant", content: "from transcript", parts: [] },
    ]);
    expect(snapshot.providerRevision).toBe(7);
    expect(snapshot.notices).toBeUndefined();
  });

  test("keeps ACP transcript messages paired with their own status revision", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) {
        return Response.json({
          messages: [{ id: "m-2", role: "assistant", content: "latest", parts: [] }],
          messageWindow: { truncated: false },
          status: "running",
          revision: 8,
        });
      }
      return Response.json({
        // This response was captured one revision earlier than the transcript.
        status: "idle",
        revision: 7,
        error: "stale failure",
        composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
      });
    }, cursorConnection);

    const snapshot = await provider.interactiveSnapshot!("cursor-1");

    expect(snapshot.status).toBe("running");
    expect(snapshot.providerRevision).toBe(8);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.messages).toEqual([
      { id: "m-2", role: "assistant", content: "latest", parts: [] },
    ]);
  });

  test("advertises gzip on ACP transcript reads and still decodes the body", async () => {
    // Server-to-server fetch does not negotiate compression on its own, and the
    // transcript body is the largest thing this bridge hop ever moves.
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/messages")) {
        return Response.json({ messages: [], messageWindow: { truncated: false } });
      }
      return Response.json({
        status: "idle",
        revision: 1,
        composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
      });
    }, cursorConnection);

    await provider.interactiveSnapshot!("cursor-1");

    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("Accept-Encoding")).toBe("gzip");
    }
  });

  test("surfaces a warning notice when the ACP bridge truncated the transcript", async () => {
    // A silently shortened transcript reads as a complete one. The tab has to
    // be told that earlier content exists but was not transported.
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) {
        return Response.json({
          messages: [{ id: "m-9", role: "assistant", content: "tail", parts: [] }],
          messageWindow: { truncated: true, omittedMessages: 12 },
        });
      }
      return Response.json({
        status: "idle",
        revision: 3,
        composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
      });
    }, cursorConnection);

    const snapshot = await provider.interactiveSnapshot!("cursor-1");

    expect(snapshot.notices).toEqual([
      {
        kind: "warning",
        message:
          "Earlier transcript content was omitted to stay within the 16 MiB transport limit.",
      },
    ]);
  });

  test("reports a missing ACP session without reading its transcript as content", async () => {
    const { provider } = httpProvider(
      (url) =>
        url.endsWith("/messages")
          ? Response.json({ error: "Session not found" }, { status: 404 })
          : Response.json({ error: "Session not found" }, { status: 404 }),
      cursorConnection,
    );

    const snapshot = await provider.interactiveSnapshot!("cursor-1");

    expect(snapshot).toEqual({ status: "missing", messages: [] });
  });

  test("routes Claude background-task stop and prompt-suggestion dismissal", async () => {
    const { provider, requests } = httpProvider(() => new Response(null, { status: 204 }));

    await provider.stopBackgroundTask?.("session/1", "task/1");
    await provider.dismissSuggestedPrompt?.("session/1");

    expect(requests.map((request) => [request.url, request.init.method])).toEqual([
      ["http://claude.test/session/session%2F1/tasks/task%2F1/stop", "POST"],
      ["http://claude.test/session/session%2F1/prompt-suggestion", "DELETE"],
    ]);
  });

  test.each([
    ["claude" as const, claudeConnection],
    ["codex" as const, codexConnection],
  ])("reads %s activity from one dedicated observation request", async (_agent, connection) => {
    for (const state of ["idle", "working", "waiting", "missing"] as const) {
      const { provider, requests } = httpProvider(
        () => Response.json({ activity: state }),
        connection,
      );

      await expect(provider.activity?.("session/1")).resolves.toBe(state);
      // One request, and specifically not the tab-facing status or
      // pending-input routes: those refresh the bridge's liveness clocks, which
      // a two-second poll would use to pin every transcript in memory forever.
      expect(requests.map((request) => request.url)).toEqual([
        `${connection.baseUrl}/session/session%2F1/activity`,
      ]);
    }
  });

  test.each([
    ["claude" as const, claudeConnection],
    ["codex" as const, codexConnection],
  ])("rejects a malformed %s activity snapshot", async (_agent, connection) => {
    for (const body of [{}, { activity: "busy" }, { activity: null }]) {
      const { provider } = httpProvider(() => Response.json(body), connection);
      // Coercing an unrecognized token to `idle` would retire the indicator on
      // a turn that is still running.
      await expect(provider.activity?.("session-1")).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    }
  });

  test.each([
    ["claude" as const, 404, false, claudeConnection],
    ["claude" as const, 400, false, claudeConnection],
    ["claude" as const, 503, true, claudeConnection],
    ["codex" as const, 404, false, codexConnection],
    ["codex" as const, 400, false, codexConnection],
    ["codex" as const, 503, true, codexConnection],
  ])(
    "surfaces a non-success %s activity read (HTTP %i)",
    async (_agent, status, isUnavailable, connection) => {
      const { provider } = httpProvider(() => new Response(null, { status }), connection);

      let caught: unknown;
      try {
        await provider.activity?.("session-1");
      } catch (error) {
        caught = error;
      }
      // 404 must throw rather than resolve to `missing`. The route reports an
      // unknown session in-band, so a 404 means the route is absent — an older
      // bridge — and resolving it as `missing` would delete a live mapping.
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof ProviderUnavailableError).toBe(isUnavailable);
    },
  );

  test("defaults sessions to build mode and accepts an explicit override", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession("review", "Prepare", { mode: "build" });
    await provider.createSession("review", "Discover", { mode: "plan" });
    await provider.createSession("review", "Unspecified");

    expect(requests.map((request) => JSON.parse(String(request.init.body)).mode)).toEqual([
      "build",
      "plan",
      "build",
    ]);
  });

  test("refuses base64 images when nothing can stage them", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      claudeConnection,
      { stageImages: false },
    );

    // Silently dropping the image would leave a prompt that references a picture
    // the agent was never given.
    await expect(
      provider.send("session-1", "Look", {
        requestId: "request-1",
        images: [{ filename: "screen.png", data: "AA==" }],
      }),
    ).rejects.toBeInstanceOf(PromptRejectedError);
    expect(requests).toHaveLength(0);
  });

  test("forwards per-prompt Claude options ahead of the connection defaults", async () => {
    const { provider, requests } = httpProvider(() => new Response(null, { status: 204 }), {
      ...claudeConnection,
      model: "connection-model",
      effort: "low",
    });

    await provider.send("session-1", "Ship it", {
      requestId: "request-1",
      model: "prompt-model",
      effort: "high",
      subAgent: "reviewer",
      includeLocalSettings: true,
      promptSuggestions: false,
    });

    // A queued prompt carries the model, sub-agent and settings the user chose;
    // falling back to the connection default would silently change the model.
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      model: "prompt-model",
      effort: "high",
      agent: "reviewer",
      includeLocalSettings: true,
      promptSuggestions: false,
    });
  });

  test("attaches already-staged attachments without restaging them", async () => {
    const { provider, requests, staged } = httpProvider(() => new Response(null, { status: 204 }));

    await provider.send("session-1", "Review this", {
      requestId: "request-1",
      attachments: [
        {
          type: "image",
          path: "/workspace/shot.png",
          filename: "shot.png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
    });

    expect(staged).toEqual([]);
    expect(JSON.parse(String(requests[0]!.init.body)).attachments).toEqual([
      {
        type: "image",
        path: "/workspace/shot.png",
        filename: "shot.png",
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });

  test("keeps queued Claude plan turns in plan permission mode", async () => {
    const { provider, requests } = httpProvider(() => new Response(null, { status: 204 }));

    await provider.send("session-1", "Inspect only", {
      requestId: "request-plan",
      mode: "plan",
    });

    expect(JSON.parse(String(requests[0]!.init.body)).permissionMode).toBe("plan");
  });

  test("rejects malformed session creation responses", async () => {
    const { provider } = httpProvider(() => Response.json({}));
    await expect(provider.createSession("build", "Build task")).rejects.toThrow(
      "malformed session",
    );
  });

  test("forwards session idempotency and per-session codex model settings", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession("build", "Build task", {
      clientSessionKey: "pipeline:task:attempt",
      model: "gpt-override",
      effort: "medium",
    });

    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      title: "Build task",
      model: "gpt-override",
      modelReasoningEffort: "medium",
      mode: "build",
      clientSessionKey: "pipeline:task:attempt",
    });
  });

  test("forwards an HTTP structured schema and omits an empty attachment list", async () => {
    const { provider, requests } = httpProvider(() => new Response(null, { status: 204 }));
    const schema = { type: "object", properties: {} } as const;

    await provider.send("session-1", "Review it", {
      requestId: "request-1",
      schema,
    });

    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body.outputSchema).toEqual(schema);
    expect(body.attachments).toBeUndefined();
  });

  test("maps every valid HTTP status and malformed status to the provider contract", async () => {
    for (const [wireStatus, expected] of [
      ["running", "running"],
      ["idle", "idle"],
      ["error", "error"],
      ["unknown", "error"],
      [undefined, "error"],
    ] as const) {
      const { provider } = httpProvider(() => Response.json({ status: wireStatus }));
      await expect(provider.status("session-1")).resolves.toBe(expected);
    }
  });

  test("preserves the bridge failure detail from an errored session", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          status: "error",
          error: "stream disconnected before completion",
        }),
      codexConnection,
    );

    await expect(provider.status("session-1")).rejects.toThrow(
      "The codex session failed: stream disconnected before completion",
    );
  });

  test("preserves the session failure detail from the claude session route", async () => {
    const { provider } = httpProvider(() =>
      Response.json({
        status: "error",
        error: "claude declined mid-turn",
      }),
    );

    await expect(provider.status("session-1")).rejects.toThrow(
      "The claude session failed: claude declined mid-turn",
    );
  });

  test("readProviderStatus reports a failed turn as data instead of a throw", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          status: "error",
          error: "Selected model is at capacity. Please try a different model.",
        }),
      codexConnection,
    );

    await expect(readProviderStatus(provider, "session-1")).resolves.toEqual({
      status: "error",
      error: "Selected model is at capacity. Please try a different model.",
    });
  });

  test("readProviderStatus still rejects a transport fault", async () => {
    const { provider } = httpProvider(() => new Response("boom", { status: 500 }), codexConnection);

    await expect(readProviderStatus(provider, "session-1")).rejects.toThrow();
  });

  test("falls back to a plain error status when the session failure detail is empty", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json({
          status: "error",
          error: "   ",
        }),
      codexConnection,
    );

    await expect(provider.status("session-1")).resolves.toBe("error");
  });

  test("maps missing and malformed HTTP transcripts to an empty list", async () => {
    const missing = httpProvider(() => new Response(null, { status: 404 }));
    await expect(missing.provider.messages("session-1")).resolves.toEqual([]);

    const malformed = httpProvider(() => Response.json({ messages: "invalid" }));
    await expect(malformed.provider.messages("session-1")).resolves.toEqual([]);
  });

  test("returns successful structured output and escapes its request id", async () => {
    const result = {
      ok: true,
      provider: "claude",
      requestId: "request/1",
      value: { complete: true },
    } as const;
    const { provider, requests } = httpProvider(() => Response.json({ structuredOutput: result }));

    await expect(provider.structured("session/1", "request/1")).resolves.toEqual(result);
    expect(requests[0]!.url).toBe(
      "http://claude.test/session/session%2F1/structured-output?requestId=request%2F1",
    );
  });

  test("aborts a bridge request after the configured deadline", async () => {
    const { provider } = httpProvider(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    await expect(provider.status("session-1")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
