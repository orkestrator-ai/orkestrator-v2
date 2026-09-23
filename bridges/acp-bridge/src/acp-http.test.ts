import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { commandBindingRevision } from "@orkestrator/protocol/agent-command-catalogue";
import {
  BRIDGE_STARTUP_TIMEOUT_MS,
  here,
  nativeFetch,
  NativeAbortController,
  ONE_PIXEL_PNG,
  spawnBridge,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";

describe("ACP bridge", () => {
  test("reports Grok auth and the configured control MCP without exposing its token", async () => {
    const missingCredential = resolve(await temporaryDirectory(), "missing-auth.json");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: missingCredential,
        ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4321/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "private-test-token",
      },
    });
    const auth = await nativeFetch(`${base}/global/auth`, { headers });
    expect(auth.status).toBe(200);
    expect(await auth.json()).toMatchObject({
      state: "needs-auth",
      signIn: { kind: "terminal" },
      signOut: false,
    });

    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    const payload = await nativeFetch(`${base}/session/${created.id}/mcp`, { headers }).then(
      (response) => response.text(),
    );
    expect(payload).toContain("orkestrator");
    expect(payload).not.toContain("private-test-token");
  });

  test("runtime health uses the shared envelope and answers unknown sessions in band", async () => {
    const { base, headers } = await spawnBridge();
    const missing = await nativeFetch(`${base}/session/missing/runtime-health`, { headers });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ summary: {}, notices: [] });

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    });
    const session = (await created.json()) as { id: string };
    const health = await nativeFetch(`${base}/session/${session.id}/runtime-health`, { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ summary: expect.any(Object), notices: [] });
  });

  // The fake agent records its own argv, so these assert the exact command line
  // the bridge builds. They cannot prove the real CLIs accept those flags —
  // `docs/development/upgrade-agents.md` carries that as a manual step for version bumps.
  async function readAgentArgs(env: NodeJS.ProcessEnv): Promise<string[]> {
    const argsFile = resolve(await temporaryDirectory(), "args.log");
    const { base, headers } = await spawnBridge({
      env: { ...env, FAKE_ACP_ARGS_FILE: argsFile },
    });

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    });
    expect(created.status).toBe(201);

    const recorded = await waitFor(
      async () => fs.readFile(argsFile, "utf8").catch(() => ""),
      (value) => value.trim().length > 0,
    );
    // One session spawns one agent. A second line would mean the child was
    // restarted, which should fail as itself rather than as a JSON parse error
    // on two concatenated records.
    const lines = recorded.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as string[];
  }

  test("allows authenticated renderer requests from trusted local origins", async () => {
    const { base } = await spawnBridge();
    const origin = "http://127.0.0.1:1420";
    const preflight = await nativeFetch(`${base}/session/create`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-orkestrator-acp-token, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-orkestrator-acp-token",
    );

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers: {
        origin,
        "x-orkestrator-acp-token": "integration-test-token",
        "content-type": "application/json",
      },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("access-control-allow-origin")).toBe(origin);
    const session = (await created.json()) as { id: string };

    // Packaged Electron renderers use an opaque origin. They still have to
    // prove possession of the bridge credential, but must not be rejected by
    // the browser-origin boundary before authentication runs.
    const opaqueOrigin = await nativeFetch(`${base}/session/${session.id}`, {
      headers: {
        origin: "null",
        "x-orkestrator-acp-token": "integration-test-token",
      },
    });
    expect(opaqueOrigin.status).toBe(200);
    expect(opaqueOrigin.headers.get("access-control-allow-origin")).toBe("null");

    const rejected = await nativeFetch(`${base}/global/health`, {
      headers: { origin: "https://attacker.invalid" },
    });
    expect(rejected.status).toBe(403);
  });

  test("withholds CORS and private-network access from the unauthenticated health route", async () => {
    const { base } = await spawnBridge();

    // `/global/health` answers before the token check. Any public page can mint
    // an opaque origin through a sandboxed iframe, so reflecting that origin
    // here — or granting Private Network Access for it — would hand the open
    // web a readable loopback probe. The route stays reachable for the
    // backend's non-browser prober; a browser just cannot read the body.
    const opaque = await nativeFetch(`${base}/global/health`, {
      headers: { origin: "null" },
    });
    expect(opaque.status).toBe(200);
    expect(opaque.headers.get("access-control-allow-origin")).toBeNull();

    const loopback = await nativeFetch(`${base}/global/health`, {
      headers: { origin: "http://127.0.0.1:1420" },
    });
    expect(loopback.status).toBe(200);
    expect(loopback.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await nativeFetch(`${base}/global/health`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-private-network")).toBeNull();

    // The backend probes without an Origin header at all, which must keep
    // working — that is the only client this route exists for.
    const prober = await nativeFetch(`${base}/global/health`);
    expect(prober.status).toBe(200);
    expect(await prober.json()).toMatchObject({ ok: true });

    // Authenticated data routes still get their preflight, including the
    // private-network opt-in a packaged renderer needs.
    const dataPreflight = await nativeFetch(`${base}/session/create`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "POST" },
    });
    expect(dataPreflight.status).toBe(204);
    expect(dataPreflight.headers.get("access-control-allow-private-network")).toBe("true");
  });

  test("reaps a session process when the creating HTTP client disconnects", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "lifecycle.log");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_HANG_INITIALIZE: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        ACP_RPC_TIMEOUT_MS: "100",
      },
    });
    const controller = new NativeAbortController();
    const request = nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: "{}",
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => contents.includes("start:"),
    );
    controller.abort();
    await request;
    const lifecycle = await fs.readFile(lifecycleFile, "utf8");
    const agentPid = Number(/^start:(\d+)$/m.exec(lifecycle)?.[1]);
    expect(Number.isSafeInteger(agentPid)).toBe(true);
    await waitFor(
      async () => {
        try {
          process.kill(agentPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      Boolean,
      BRIDGE_STARTUP_TIMEOUT_MS,
    );
    expect(lifecycle.match(/^start:/gm)).toHaveLength(1);
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
  });

  test("bounds one oversized response without failing the session", async () => {
    const { base, headers } = await spawnBridge();
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "OVERSIZED", requestId: "oversized-1" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string; error?: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThan(8 * 1024 * 1024);
    // Bounded, and the cut is announced in the transcript the user reads.
    expect(session.messages[1]?.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
  });

  test("announces overflow when earlier stream chunks leave no room for the marker", async () => {
    const { base, headers } = await spawnBridge();
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "STREAMOVERFLOW: cross the cap in two chunks" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ content: string; parts: Array<{ type: string; content: string }> }>;
        }>,
      (value) => value.status === "idle",
    );

    const assistant = session.messages[1]!;
    const textPart = assistant.parts.find((part) => part.type === "text")!;
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(assistant.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(textPart.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(assistant.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
    expect(textPart.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
    expect(assistant.content).not.toContain("�");
    expect(textPart.content).not.toContain("�");
  });

  test("keeps serving when writes go to an agent that stopped reading", async () => {
    // The agent answers, then closes its read end and stays alive, so every
    // later write lands on a pipe nobody drains while the bridge still has the
    // child attached. Writing there must never escape into the request handler
    // or take the bridge down with all of its other sessions.
    const { base, headers, child } = await spawnBridge();
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CLOSESTDIN", requestId: "closed-input-1" }),
    });
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, {
        method: "POST",
        headers,
      });
      expect(cancelled.status).toBe(202);
      await Bun.sleep(20);
    }

    expect(child.exitCode).toBe(null);
    expect((await nativeFetch(`${base}/global/health`)).ok).toBe(true);
    expect((await nativeFetch(`${base}/session/${created.id}`, { headers })).status).toBe(200);
  });
});

describe("ACP provider commands", () => {
  type Catalogue = {
    catalogueVersion?: number;
    status: string;
    revision?: number;
    generation?: string;
    freshness?: string;
    truncated?: boolean;
    commands: Array<Record<string, unknown>>;
  };

  async function commandBridge(options: { commands?: unknown[] } = {}) {
    const workspace = await temporaryDirectory();
    const commandsFile = resolve(workspace, "commands.json");
    const blocksFile = resolve(workspace, "prompt-blocks.log");
    const lifecycleFile = resolve(workspace, "lifecycle.log");
    if (options.commands) await fs.writeFile(commandsFile, JSON.stringify(options.commands));
    const bridge = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        CWD: workspace,
        FAKE_ACP_COMMANDS_FILE: commandsFile,
        FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_IMAGE_CAPABILITY: "true",
      },
    });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    const session = `${bridge.base}/session/${created.id}`;
    const request = (path: string, init: RequestInit = {}) =>
      nativeFetch(`${session}${path}`, { ...init, headers: bridge.headers });
    const catalogue = () =>
      request("/commands").then((response) => response.json() as Promise<Catalogue>);
    const prompt = (body: Record<string, unknown>) =>
      request("/prompt", { method: "POST", body: JSON.stringify(body) });
    const idle = () =>
      waitFor(
        () => request("").then((response) => response.json() as Promise<{ status: string }>),
        (value) => value.status === "idle",
      );
    const blocks = async () =>
      (await fs.readFile(blocksFile, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Array<Record<string, unknown>>);
    const starts = async () =>
      ((await fs.readFile(lifecycleFile, "utf8").catch(() => "")).match(/^start:/gm) ?? []).length;
    return {
      ...bridge,
      workspace,
      commandsFile,
      created,
      request,
      catalogue,
      prompt,
      idle,
      blocks,
      starts,
    };
  }

  const review = {
    name: "review",
    description: "Review changes",
    input: { hint: "<path>" },
    inputHint: "legacy hint",
  };

  test("serves the pushed inventory and sends a selected command exactly once", async () => {
    const bridge = await commandBridge({
      commands: [review, { name: "commit", description: "Commit" }],
    });
    await fs.writeFile(resolve(bridge.workspace, "shot.png"), ONE_PIXEL_PNG);
    // Announced straight after `session/new` answered, before the bridge had a
    // handler for the session: it must not be lost.
    const catalogue = await waitFor(bridge.catalogue, (value) => value.status === "ready");
    expect(catalogue).toMatchObject({
      catalogueVersion: 1,
      freshness: "push",
      truncated: false,
      generation: expect.stringMatching(/^grok:/),
    });
    expect(catalogue.revision).toBeGreaterThanOrEqual(1);
    expect(catalogue.commands[0]).toEqual({
      name: "/review",
      id: "grok:review",
      executionKind: "provider-prompt",
      source: "unknown",
      scope: "session",
      description: "Review changes",
      argumentHint: "<path>",
      bindingRevision: commandBindingRevision(["grok", "review"]),
    });

    const argumentsText = "src/a.ts\n\n  keep   spacing  ";
    const body = {
      prompt: `/review ${argumentsText}`,
      requestId: "command-1",
      allowProviderCommands: true,
      attachments: [{ type: "image", path: "shot.png", filename: "shot.png" }],
      command: {
        id: "grok:review",
        name: "/review",
        executionKind: "provider-prompt",
        bindingRevision: catalogue.commands[0]!.bindingRevision,
        arguments: argumentsText,
      },
    };
    expect((await bridge.prompt(body)).status).toBe(202);
    await bridge.idle();
    // A retry under the same id is a duplicate, not a second command.
    const retry = await bridge.prompt(body);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ duplicate: true });

    expect(await bridge.blocks()).toEqual([
      [
        { type: "text", text: `/review ${argumentsText}` },
        { type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG.toString("base64") },
      ],
    ]);

    const refresh = await bridge.request("/commands/refresh", { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ outcome: "reread" });
    // Refreshing never restarts the agent to make it announce again.
    expect(await bridge.starts()).toBe(1);
  });

  test("a removed or changed command is refused before journaling, never sent as a prompt", async () => {
    const bridge = await commandBridge({ commands: [review] });
    const first = await waitFor(bridge.catalogue, (value) => value.status === "ready");
    const selection = {
      id: "grok:review",
      name: "/review",
      executionKind: "provider-prompt",
      bindingRevision: first.commands[0]!.bindingRevision,
      arguments: "",
    };

    // An empty announcement is a known empty list, not a missing one.
    await fs.writeFile(bridge.commandsFile, "[]");
    expect((await bridge.prompt({ prompt: "COMMANDS_UPDATE" })).status).toBe(202);
    await bridge.idle();
    const emptied = await bridge.catalogue();
    expect(emptied).toMatchObject({ status: "ready", commands: [] });
    expect(emptied.revision).toBeGreaterThan(first.revision!);

    const removed = await bridge.prompt({
      prompt: "/review",
      requestId: "removed-1",
      command: selection,
    });
    expect(removed.status).toBe(422);
    expect(await removed.json()).toMatchObject({ kind: "command-unavailable" });
    expect(
      await bridge.request("/dispatch?requestId=removed-1").then((response) => response.json()),
    ).toEqual({ dispatch: "unknown" });

    await fs.writeFile(bridge.commandsFile, JSON.stringify([review]));
    expect((await bridge.prompt({ prompt: "COMMANDS_UPDATE" })).status).toBe(202);
    await bridge.idle();
    const changed = await bridge.prompt({
      prompt: "/review",
      requestId: "changed-1",
      command: { ...selection, bindingRevision: "0000000000000000" },
    });
    expect(changed.status).toBe(422);

    // Only the two inventory prompts ever reached the agent.
    expect((await bridge.blocks()).map((prompt) => prompt[0]?.text)).toEqual([
      "COMMANDS_UPDATE",
      "COMMANDS_UPDATE",
    ]);
  });

  test("malformed command fields are caller errors and literal text passes unchanged", async () => {
    const bridge = await commandBridge({ commands: [review] });
    const ready = await waitFor(bridge.catalogue, (value) => value.status === "ready");
    const selection = {
      id: "grok:review",
      name: "/review",
      executionKind: "provider-prompt",
      bindingRevision: ready.commands[0]!.bindingRevision,
      arguments: "",
    };
    for (const body of [
      { prompt: "hello", allowProviderCommands: "yes" },
      { prompt: "hello", command: { id: "grok:review" } },
      { prompt: "/review", allowProviderCommands: false, command: selection },
      { prompt: "/review", command: selection, outputSchema: { type: "object" } },
    ]) {
      const response = await bridge.prompt({ ...body, requestId: "bad-1" });
      expect(response.status).toBe(400);
    }
    expect(
      await bridge.request("/dispatch?requestId=bad-1").then((response) => response.json()),
    ).toEqual({ dispatch: "unknown" });

    // ACP cannot suppress command interpretation, so literal text is sent as
    // typed; the backend is what refuses a literal that names a command.
    expect(
      (
        await bridge.prompt({
          prompt: "/review but literally",
          requestId: "literal-1",
          allowProviderCommands: false,
        })
      ).status,
    ).toBe(202);
    await bridge.idle();
    expect((await bridge.blocks()).at(-1)).toEqual([
      { type: "text", text: "/review but literally" },
    ]);
  });

  test("status and session reads carry the inventory revision a push advances", async () => {
    const bridge = await commandBridge({ commands: [review] });
    const readRevisions = async () => {
      const status = (await bridge.request("/status").then((response) => response.json())) as {
        commandRevision?: number;
      };
      const session = (await bridge.request("").then((response) => response.json())) as {
        commandRevision?: number;
      };
      return { status: status.commandRevision, session: session.commandRevision };
    };
    const first = await waitFor(bridge.catalogue, (value) => value.status === "ready");
    expect(await readRevisions()).toEqual({ status: first.revision, session: first.revision });

    await fs.writeFile(bridge.commandsFile, "[]");
    expect((await bridge.prompt({ prompt: "COMMANDS_UPDATE" })).status).toBe(202);
    await bridge.idle();
    const pushed = await bridge.catalogue();
    expect(pushed.revision).toBe(first.revision! + 1);
    expect(await readRevisions()).toEqual({ status: pushed.revision, session: pushed.revision });
    // Reading it spawned nothing: still the one agent the session started with.
    expect(await bridge.starts()).toBe(1);
  });

  test("no announcement yet is stale, not empty, and refresh says it cannot help", async () => {
    const bridge = await commandBridge();
    // No inventory known: no revision to compare against.
    expect(await bridge.request("/status").then((response) => response.json())).not.toHaveProperty(
      "commandRevision",
    );
    expect(await bridge.request("").then((response) => response.json())).not.toHaveProperty(
      "commandRevision",
    );
    expect(await bridge.catalogue()).toMatchObject({
      catalogueVersion: 1,
      status: "stale",
      revision: 0,
      freshness: "push",
      commands: [],
    });
    const refresh = await bridge.request("/commands/refresh", { method: "POST" });
    expect(await refresh.json()).toMatchObject({ outcome: "unsupported" });
    expect(await bridge.starts()).toBe(1);

    const selected = await bridge.prompt({
      prompt: "/review",
      requestId: "none-1",
      command: {
        id: "grok:review",
        name: "/review",
        executionKind: "provider-prompt",
        arguments: "",
      },
    });
    expect(selected.status).toBe(422);
    expect(await bridge.blocks()).toEqual([]);

    const missing = await nativeFetch(`${bridge.base}/session/missing/commands`, {
      headers: bridge.headers,
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({
      catalogueVersion: 1,
      status: "missing",
      commands: [],
    });
    const missingRefresh = await nativeFetch(`${bridge.base}/session/missing/commands/refresh`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(missingRefresh.status).toBe(200);
    expect(await missingRefresh.json()).toMatchObject({ outcome: "failed" });

    // The global route no longer claims a refresh it did not perform.
    const global = await nativeFetch(`${bridge.base}/global/refresh-catalog`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(global.status).toBe(200);
    expect(await global.json()).toMatchObject({
      refreshed: false,
      commands: { outcome: "unsupported" },
    });
  });
});
