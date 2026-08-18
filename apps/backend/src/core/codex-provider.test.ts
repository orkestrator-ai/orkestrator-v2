import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "./native-agent-provider.js";
import { codexConnection, httpProvider, waitUntil } from "./agent-provider-test-support.js";

describe("HTTP bridge provider (codex)", () => {
  test("authenticates with the codex header and its own session payload", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession("review", "Review Session");

    const [request] = requests;
    expect(request!.url).toBe("http://codex.test/session/create");
    const headers = new Headers(request!.init.headers);
    expect(headers.get("X-Orkestrator-Codex-Token")).toBe("codex-token");
    expect(headers.get("X-Orkestrator-Claude-Token")).toBeNull();
    expect(JSON.parse(String(request!.init.body))).toEqual({
      title: "Review Session",
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
      mode: "build",
    });
  });

  test.each([
    ["build", "build"],
    ["review", "build"],
    ["verify", "build"],
    ["fix", "build"],
    ["pr", "build"],
    ["resolve-conflicts", "build"],
  ] as const)("runs the %s stage in %s mode", async (phase, mode) => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession(phase, "Session");

    expect(JSON.parse(String(requests[0]!.init.body)).mode).toBe(mode);
  });

  test("reads status from the codex-specific endpoint", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ status: "running" }),
      codexConnection,
    );

    expect(await provider.status("codex-1")).toBe("running");
    // Claude answers status from /session/:id; codex has a dedicated route, and
    // asking the wrong one returns a body with no status at all.
    expect(requests[0]!.url).toBe("http://codex.test/session/codex-1/status");
  });

  test("projects Codex's authoritative session config in the interactive snapshot", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/config")) {
        return Response.json({
          model: "gpt-5.6",
          modelReasoningEffort: "high",
          mode: "plan",
          fastMode: true,
          durable: true,
        });
      }
      if (url.endsWith("/runtime-health")) {
        return Response.json({
          engine: { state: "ready", codexVersion: "0.145.0" },
          mcp: { data: [{ name: "docs" }] },
          skills: { data: [{ skills: [{ name: "review" }] }] },
          hooks: { data: [{ hooks: [{ eventName: "preTurn" }] }] },
          notices: [{ message: "Using fallback config" }],
        });
      }
      return Response.json({
        status: "idle",
        title: "Codex's title",
        phase: "idle",
        engineGeneration: 2,
        messageRevision: 7,
      });
    }, codexConnection);

    await expect(provider.interactiveSnapshot?.("codex-1")).resolves.toMatchObject({
      status: "idle",
      title: "Codex's title",
      controls: {
        modelId: "gpt-5.6",
        reasoningId: "high",
        mode: "plan",
        fastMode: true,
      },
      runtime: {
        mcpServers: 1,
        skills: 1,
        hooks: 1,
        state: "ready",
        version: "0.145.0",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://codex.test/session/codex-1/status",
      "http://codex.test/session/codex-1/messages",
      "http://codex.test/session/codex-1/config",
      "http://codex.test/session/codex-1/runtime-health",
    ]);
  });

  test("does not hold a Codex transcript behind expired runtime inventory", async () => {
    let message = "old transcript";
    let runtimeReads = 0;
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const { provider } = httpProvider(async (url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [message] });
      if (url.endsWith("/config")) {
        return Response.json({ mode: "build", fastMode: false, durable: true });
      }
      if (url.endsWith("/runtime-health")) {
        runtimeReads += 1;
        if (runtimeReads > 1) await runtimeGate;
        return Response.json({
          engine: { state: runtimeReads > 1 ? "refreshed" : "ready" },
          mcp: { data: [] },
          skills: { data: [] },
          hooks: { data: [] },
          notices: [],
        });
      }
      return Response.json({ status: "idle", phase: "idle", messageRevision: 1 });
    }, codexConnection);

    const first = await provider.interactiveSnapshot?.("codex-1");
    expect(first?.runtime?.state).toBe("ready");
    const metadata = (
      provider as unknown as {
        interactiveMetadata: Map<string, { expiresAt: number }>;
      }
    ).interactiveMetadata.get("codex-1");
    expect(metadata).toBeDefined();
    metadata!.expiresAt = 0;
    message = "latest transcript";

    const second = await Promise.race([
      provider.interactiveSnapshot!("codex-1"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Transcript waited for runtime inventory")), 100);
      }),
    ]);
    expect(second.messages).toEqual(["latest transcript"]);
    expect(second.runtime?.state).toBe("ready");
    expect(runtimeReads).toBe(2);

    releaseRuntime();
    const refreshes = (
      provider as unknown as {
        codexRuntimeMetadataRefreshes: Map<string, Promise<void>>;
      }
    ).codexRuntimeMetadataRefreshes;
    await waitUntil(() => refreshes.size === 0);

    const third = await provider.interactiveSnapshot?.("codex-1");
    expect(third?.runtime?.state).toBe("refreshed");
    expect(runtimeReads).toBe(2);
  });

  test("retains Codex runtime metadata after a malformed background response", async () => {
    let runtimeReads = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/config")) {
        return Response.json({ mode: "build", fastMode: false, durable: true });
      }
      if (url.endsWith("/runtime-health")) {
        runtimeReads += 1;
        if (runtimeReads === 2) return Response.json(null);
        return Response.json({
          engine: { state: runtimeReads === 1 ? "ready" : "recovered" },
          mcp: { data: [] },
          skills: { data: [] },
          hooks: { data: [] },
          notices: [],
        });
      }
      return Response.json({ status: "idle", phase: "idle", messageRevision: 1 });
    }, codexConnection);

    const first = await provider.interactiveSnapshot?.("codex-1");
    expect(first?.runtime?.state).toBe("ready");
    const internals = provider as unknown as {
      interactiveMetadata: Map<
        string,
        {
          expiresAt: number;
          runtime?: { state?: string };
        }
      >;
      codexRuntimeMetadataRefreshes: Map<string, Promise<void>>;
    };
    const retained = internals.interactiveMetadata.get("codex-1");
    expect(retained).toBeDefined();
    retained!.expiresAt = 0;

    const stale = await provider.interactiveSnapshot?.("codex-1");
    expect(stale?.runtime?.state).toBe("ready");
    await waitUntil(() => internals.codexRuntimeMetadataRefreshes.size === 0);
    expect(internals.interactiveMetadata.get("codex-1")).toBe(retained);
    expect(retained!.runtime?.state).toBe("ready");
    expect(retained!.expiresAt).toBeGreaterThan(Date.now());

    retained!.expiresAt = 0;
    const retrying = await provider.interactiveSnapshot?.("codex-1");
    expect(retrying?.runtime?.state).toBe("ready");
    await waitUntil(() => internals.codexRuntimeMetadataRefreshes.size === 0);
    const recovered = await provider.interactiveSnapshot?.("codex-1");
    expect(recovered?.runtime?.state).toBe("recovered");
    expect(runtimeReads).toBe(3);
  });

  test("drops a background Codex runtime refresh an explicit catalog refresh superseded", async () => {
    let runtimeReads = 0;
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const { provider } = httpProvider(async (url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/config")) {
        return Response.json({ mode: "build", fastMode: false, durable: true });
      }
      if (url.endsWith("/runtime-health")) {
        runtimeReads += 1;
        if (runtimeReads === 2) await runtimeGate;
        return Response.json({
          engine: {
            state:
              runtimeReads === 1 ? "ready" : runtimeReads === 2 ? "superseded" : "rediscovered",
          },
          mcp: { data: [] },
          skills: { data: [] },
          hooks: { data: [] },
          notices: [],
        });
      }
      return Response.json({ status: "idle", phase: "idle", messageRevision: 1 });
    }, codexConnection);

    const first = await provider.interactiveSnapshot?.("codex-1");
    expect(first?.runtime?.state).toBe("ready");
    const internals = provider as unknown as {
      interactiveMetadata: Map<
        string,
        {
          expiresAt: number;
          runtime?: { state?: string };
        }
      >;
      codexRuntimeMetadataRefreshes: Map<string, Promise<void>>;
    };
    internals.interactiveMetadata.get("codex-1")!.expiresAt = 0;

    // Parks the background refresh on the gate, so it is still in flight when
    // the user asks for an explicit re-discovery.
    const stale = await provider.interactiveSnapshot?.("codex-1");
    expect(stale?.runtime?.state).toBe("ready");
    expect(runtimeReads).toBe(2);

    provider.refreshCatalog?.();
    expect(internals.interactiveMetadata.size).toBe(0);

    releaseRuntime();
    await waitUntil(() => internals.codexRuntimeMetadataRefreshes.size === 0);
    // The superseded read describes the inventory the refresh just dropped, so
    // it must not repopulate the map the picker is waiting to re-read.
    expect(internals.interactiveMetadata.has("codex-1")).toBe(false);

    const rediscovered = await provider.interactiveSnapshot?.("codex-1");
    expect(rediscovered?.runtime?.state).toBe("rediscovered");
    expect(runtimeReads).toBe(3);
  });

  test("sends codex attachments as data URLs without claude-only options", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      codexConnection,
    );

    await provider.send("codex-1", "Build it", {
      requestId: "request-1",
      fastMode: false,
      images: [{ filename: "shot.jpeg", data: "AAAA" }],
    });

    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body.attachments).toEqual([
      {
        type: "image",
        path: "/workspace/.orkestrator/initial-prompt/shot.jpeg",
        filename: "shot.jpeg",
        dataUrl: "data:image/jpeg;base64,AAAA",
      },
    ]);
    expect(body.fastMode).toBe(false);
    // permissionMode/model/effort are claude prompt options; codex takes its
    // model at session creation and would reject them here.
    expect(body.permissionMode).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.effort).toBeUndefined();
  });

  test("switches an idle codex review session to build mode before addressing", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          model: "gpt-5-codex",
          modelReasoningEffort: "high",
          mode: "plan",
          fastMode: false,
          durable: true,
        });
      }
      if (url.endsWith("/config")) {
        return Response.json({ status: "updated", durable: true });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await provider.send("review-1", "Address the findings", {
      requestId: "request-address",
      mode: "build",
    });
    await provider.send("review-1", "Continue addressing", {
      requestId: "request-continue",
      mode: "build",
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://codex.test/session/review-1/config",
      "http://codex.test/session/review-1/config",
      "http://codex.test/session/review-1/prompt",
      "http://codex.test/session/review-1/prompt",
    ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
      mode: "build",
      fastMode: false,
    });
    expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
      prompt: "Address the findings",
      requestId: "request-address",
    });
    // A successful durable reconciliation becomes authoritative local state;
    // repeating the same mode must not pay another config read/write round trip.
    expect(JSON.parse(String(requests[3]!.init.body))).toMatchObject({
      prompt: "Continue addressing",
      requestId: "request-continue",
    });
  });

  test("sends immediately when a newly created codex session keeps its mode", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/session/create")) {
        return Response.json({ sessionId: "build-1" });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    const sessionId = await provider.createSession("build", "Build");
    await provider.send(sessionId, "Implement it", {
      requestId: "request-build",
      mode: "build",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/create",
      "http://codex.test/session/build-1/prompt",
    ]);
    expect(requests.some(({ url }) => url.endsWith("/config"))).toBe(false);
  });

  test("skips a durable mode update when the codex session already matches", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/config")) {
        return Response.json({
          model: "gpt-5-codex",
          modelReasoningEffort: "high",
          mode: "build",
          fastMode: false,
          durable: true,
        });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await provider.send("review-1", "Address the findings", {
      requestId: "request-address",
      mode: "build",
    });

    expect(requests.map(({ url, init }) => [url, init.method ?? "GET"])).toEqual([
      ["http://codex.test/session/review-1/config", "GET"],
      ["http://codex.test/session/review-1/prompt", "POST"],
    ]);
  });

  test("retries the same durable request id after reconciling codex mode", async () => {
    let promptAttempts = 0;
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/config")) {
        return Response.json({
          mode: "build",
          fastMode: false,
          durable: true,
        });
      }
      promptAttempts += 1;
      if (promptAttempts === 1) {
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    const options = {
      requestId: "request-address",
      mode: "build" as const,
    };
    await expect(provider.send("review-1", "Address the findings", options)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(
      provider.send("review-1", "Address the findings", options),
    ).resolves.toBeUndefined();

    const promptBodies = requests
      .filter(({ url }) => url.endsWith("/prompt"))
      .map(({ init }) => JSON.parse(String(init.body)));
    expect(promptBodies).toHaveLength(2);
    expect(promptBodies.map(({ requestId }) => requestId)).toEqual([
      "request-address",
      "request-address",
    ]);
  });

  test("updates a matching but non-durable codex config and suppresses the prompt when persistence fails", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          mode: "build",
          fastMode: true,
          durable: false,
        });
      }
      if (url.endsWith("/config")) {
        return Response.json({ status: "updated", durable: false });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await expect(
      provider.send("review-1", "Address the findings", {
        requestId: "request-address",
        mode: "build",
      }),
    ).rejects.toThrow("not durably persisted");

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/review-1/config",
      "http://codex.test/session/review-1/config",
    ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      mode: "build",
      fastMode: true,
    });
  });

  test.each([
    [
      "invalid JSON",
      () =>
        new Response("{", {
          headers: { "Content-Type": "application/json" },
        }),
      SyntaxError,
    ],
    ["missing durability", () => Response.json({ status: "updated" }), ProviderUnavailableError],
  ] as const)(
    "rejects a codex config update with %s and suppresses the prompt",
    async (_case, updateResponse, errorType) => {
      const { provider, requests } = httpProvider((url, init) => {
        if (url.endsWith("/config") && init.method !== "POST") {
          return Response.json({
            mode: "plan",
            fastMode: false,
            durable: true,
          });
        }
        return updateResponse();
      }, codexConnection);

      await expect(
        provider.send("review-1", "Address", {
          requestId: "request-address",
          mode: "build",
        }),
      ).rejects.toBeInstanceOf(errorType);
      expect(requests).toHaveLength(2);
      expect(requests.some(({ url }) => url.endsWith("/prompt"))).toBe(false);
    },
  );

  test.each([[404], [409], [408], [425], [429], [500]])(
    "treats codex config-read HTTP %i as retryable and does not dispatch",
    async (status) => {
      const { provider, requests } = httpProvider(
        () => new Response(null, { status }),
        codexConnection,
      );

      await expect(
        provider.send("review-1", "Address", {
          requestId: "request-address",
          mode: "build",
        }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requests.map(({ url }) => url)).toEqual(["http://codex.test/session/review-1/config"]);
    },
  );

  test("keeps a semantic codex config-read failure out of retry recovery", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 400 }),
      codexConnection,
    );

    const promise = provider.send("review-1", "Address", {
      requestId: "request-address",
      mode: "build",
    });
    await expect(promise).rejects.toThrow("Codex config read failed (HTTP 400)");
    await expect(promise).rejects.not.toBeInstanceOf(ProviderUnavailableError);
    expect(requests).toHaveLength(1);
  });

  test.each([[404], [409], [408], [425], [429], [500]])(
    "treats codex config-update HTTP %i as retryable and does not dispatch",
    async (status) => {
      const { provider, requests } = httpProvider((url, init) => {
        if (url.endsWith("/config") && init.method !== "POST") {
          return Response.json({
            mode: "plan",
            fastMode: false,
            durable: true,
          });
        }
        return new Response(null, { status });
      }, codexConnection);

      await expect(
        provider.send("review-1", "Address", {
          requestId: "request-address",
          mode: "build",
        }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requests.map(({ url }) => url)).toEqual([
        "http://codex.test/session/review-1/config",
        "http://codex.test/session/review-1/config",
      ]);
    },
  );

  test("keeps a semantic codex config-update failure out of retry recovery", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          mode: "plan",
          fastMode: false,
          durable: true,
        });
      }
      return new Response(null, { status: 400 });
    }, codexConnection);

    const promise = provider.send("review-1", "Address", {
      requestId: "request-address",
      mode: "build",
    });
    await expect(promise).rejects.toThrow("Codex config update failed (HTTP 400)");
    await expect(promise).rejects.not.toBeInstanceOf(ProviderUnavailableError);
    expect(requests).toHaveLength(2);
  });

  test.each([
    ["mode", { mode: "invalid", fastMode: false, durable: true }],
    ["fastMode", { mode: "build", fastMode: "false", durable: true }],
    ["durable", { mode: "build", fastMode: false, durable: "true" }],
    ["model", { mode: "build", model: 42, fastMode: false, durable: true }],
    [
      "modelReasoningEffort",
      {
        mode: "build",
        modelReasoningEffort: 42,
        fastMode: false,
        durable: true,
      },
    ],
  ] as const)("rejects malformed codex config field %s before dispatch", async (_field, body) => {
    const { provider, requests } = httpProvider(() => Response.json(body), codexConnection);

    await expect(
      provider.send("review-1", "Address", {
        requestId: "request-address",
        mode: "build",
      }),
    ).rejects.toThrow("malformed session config");
    expect(requests).toHaveLength(1);
  });

  test("rejects invalid codex config JSON before dispatch", async () => {
    const { provider, requests } = httpProvider(
      () =>
        new Response("{", {
          headers: { "Content-Type": "application/json" },
        }),
      codexConnection,
    );

    await expect(
      provider.send("review-1", "Address", {
        requestId: "request-address",
        mode: "build",
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(requests).toHaveLength(1);
  });

  test.each(["read", "update"] as const)(
    "maps a codex config %s network failure to unavailable and suppresses dispatch",
    async (failurePoint) => {
      const { provider, requests } = httpProvider((url, init) => {
        if (failurePoint === "update" && url.endsWith("/config") && init.method !== "POST") {
          return Response.json({
            mode: "plan",
            fastMode: false,
            durable: true,
          });
        }
        throw new Error("socket closed");
      }, codexConnection);

      await expect(
        provider.send("review-1", "Address", {
          requestId: "request-address",
          mode: "build",
        }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requests).toHaveLength(failurePoint === "read" ? 1 : 2);
      expect(requests.some(({ url }) => url.endsWith("/prompt"))).toBe(false);
    },
  );

  test("escapes the session id in codex config reconciliation and prompt routes", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          mode: "plan",
          fastMode: false,
          durable: true,
        });
      }
      if (url.endsWith("/config")) {
        return Response.json({ durable: true });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await provider.send("codex/../admin", "Address", {
      requestId: "request-address",
      mode: "build",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/codex%2F..%2Fadmin/config",
      "http://codex.test/session/codex%2F..%2Fadmin/config",
      "http://codex.test/session/codex%2F..%2Fadmin/prompt",
    ]);
  });

  test.each([
    ["shot.png", "image/png"],
    ["shot.jpg", "image/jpeg"],
    ["shot.jpeg", "image/jpeg"],
    ["shot.gif", "image/gif"],
    ["shot.webp", "image/webp"],
    ["no-extension", "image/png"],
  ])("maps %s to %s", async (filename, mime) => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      codexConnection,
    );

    await provider.send("codex-1", "Build it", {
      requestId: "request-1",
      images: [{ filename, data: "AAAA" }],
    });

    expect(JSON.parse(String(requests[0]!.init.body)).attachments[0].dataUrl).toBe(
      `data:${mime};base64,AAAA`,
    );
  });

  test("escapes session ids in every codex route", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ messages: [], activity: "idle", structuredOutput: null }),
      codexConnection,
    );

    await provider.messages("codex/../admin");
    // The activity route is polled for every session in every environment, so
    // it is the route most likely to be reached with an id no bridge vetted.
    await provider.activity?.("codex/../admin");
    await provider.structured("codex/../admin", "request-1");

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/codex%2F..%2Fadmin/messages",
      "http://codex.test/session/codex%2F..%2Fadmin/activity",
      "http://codex.test/session/codex%2F..%2Fadmin/structured-output?requestId=request-1",
    ]);
  });
});
