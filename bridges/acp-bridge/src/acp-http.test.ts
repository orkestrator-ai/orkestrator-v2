import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { commandBindingRevision } from "@orkestrator/protocol/agent-command-catalogue";
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import {
  BRIDGE_STARTUP_TIMEOUT_MS,
  here,
  nativeFetch,
  NativeAbortController,
  ONE_PIXEL_PNG,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";
import {
  AUTH_SECRET_CANARIES,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
} from "../../../tests/helpers/auth-secret-canaries.js";

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

  test.each(["XAI_API_KEY", "GROK_AUTH_PROVIDER_COMMAND", "GROK_HOME"])(
    "admits Grok credentials supplied only through provider env (%s)",
    async (key) => {
      const directory = await temporaryDirectory();
      const childHome = resolve(directory, "child-home");
      await fs.mkdir(childHome);
      await fs.writeFile(resolve(childHome, "auth.json"), "{}");
      const value =
        key === "GROK_HOME" ? childHome : key === "XAI_API_KEY" ? "xai-test" : "/bin/true";
      const { base, headers } = await spawnBridge({
        env: {
          ACP_PROVIDER: "grok",
          GROK_HOME: resolve(directory, "empty-home"),
          GROK_AUTH_FILE: undefined,
          XAI_API_KEY: undefined,
          GROK_AUTH_PROVIDER_COMMAND: undefined,
          GROK_AUTH_METHOD_ID: undefined,
          ACP_PROVIDER_CONFIG: JSON.stringify({
            id: "grok",
            name: "Grok fixture",
            executable: resolve(here, "testing/fake-agent.ts"),
            argv: [],
            env: { [key]: value },
            requiresAuthenticate: false,
            modeMap: { agent: "build" },
            extensionPrefixes: ["x.ai/"],
            acknowledgedExtensionMethods: [],
            modelUpdateMethods: ["x.ai/models/update"],
            sessionUpdateMethods: ["x.ai/session/update"],
          }),
        },
      });
      const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const status = (await nativeFetch(`${base}/session/${id}/status`, { headers }).then((r) =>
        r.json(),
      )) as { readiness?: unknown; resumableSessionId?: string };
      expect(status.readiness).toBeUndefined();
      expect(status.resumableSessionId).toBeTruthy();
      expect(
        await nativeFetch(`${base}/global/auth`, { headers }).then((r) => r.json()),
      ).toMatchObject({ state: "signed-in" });
      const prompt = await nativeFetch(`${base}/session/${id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "DIRECT:child login", requestId: "child-login" }),
      });
      expect(prompt.status).toBe(202);
    },
  );

  test("concurrent attach and prompt create one deferred Grok session", async () => {
    const directory = await temporaryDirectory();
    const credential = resolve(directory, "auth.json");
    const requests = resolve(directory, "requests.jsonl");
    const releaseFile = resolve(directory, "release-new");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: credential,
        XAI_API_KEY: undefined,
        GROK_AUTH_PROVIDER_COMMAND: undefined,
        GROK_AUTH_METHOD_ID: undefined,
        FAKE_ACP_SESSION_REQUEST_FILE: requests,
        FAKE_ACP_NEW_RELEASE_FILE: releaseFile,
      },
    });
    const { id } = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (r) => r.json(),
    )) as { id: string };
    await fs.writeFile(credential, "{}");
    // Start attach first, then wait until its session/new is in flight before
    // the prompt joins it. This exercises shared startup rather than a warm child.
    const attach = nativeFetch(`${base}/session/${id}/attach`, { method: "POST", headers });
    await waitFor(
      () => fs.readFile(requests, "utf8").catch(() => ""),
      (value) => value.includes("session/new"),
    );
    const prompt = nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:once", requestId: "concurrent-login" }),
    });
    // An empty config read returns 409 only once the prompt owns admission.
    await waitFor(
      () =>
        nativeFetch(`${base}/session/${id}/config`, { method: "POST", headers, body: "{}" }).then(
          (r) => r.status,
        ),
      (value) => value === 409,
    );
    await fs.writeFile(releaseFile, "release");
    const [attached, accepted] = await Promise.all([attach, prompt]);
    expect(attached.status).toBe(200);
    expect(accepted.status).toBe(202);
    const calls = (await fs.readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/load")).toHaveLength(0);
  });

  test("retains a deferred session created before configuration fails and reloads it on retry", async () => {
    const directory = await temporaryDirectory();
    const credential = resolve(directory, "auth.json");
    const requests = resolve(directory, "requests.jsonl");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: credential,
        XAI_API_KEY: undefined,
        GROK_AUTH_PROVIDER_COMMAND: undefined,
        GROK_AUTH_METHOD_ID: undefined,
        FAKE_ACP_SESSION_REQUEST_FILE: requests,
        FAKE_ACP_FAIL_MODEL_ONCE_FILE: resolve(directory, "failed-model"),
      },
    });
    const { id } = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "grok-composer-2.5-fast" }),
    }).then((r) => r.json())) as { id: string };
    await fs.writeFile(credential, "{}");
    const failed = await nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:recover", requestId: "retry-startup" }),
    });
    expect(failed.status).toBe(500);
    const snapshot = (await nativeFetch(`${base}/session/${id}/status`, { headers }).then((r) =>
      r.json(),
    )) as { resumableSessionId?: string; status: string };
    expect(snapshot.resumableSessionId).toBeTruthy();
    expect(snapshot.status).toBe("idle");
    // The same request id remains usable: session/new is not prompt dispatch.
    expect(
      await nativeFetch(`${base}/session/${id}/dispatch?requestId=retry-startup`, { headers }).then(
        (r) => r.json(),
      ),
    ).toMatchObject({ dispatch: "unknown" });
    const retry = await nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:recover", requestId: "retry-startup" }),
    });
    expect(retry.status).toBe(202);
    await waitFor(
      () =>
        nativeFetch(`${base}/session/${id}/status`, { headers }).then((r) => r.json()) as Promise<{
          status: string;
        }>,
      (value) => value.status === "idle",
    );
    const calls = (await fs.readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    expect(calls.map((call) => call.method)).toEqual(["session/new", "session/load"]);
  });

  test("opens a Grok tab with no login as a deferred session until a login exists", async () => {
    const credential = resolve(await temporaryDirectory(), "auth.json");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: credential,
        XAI_API_KEY: undefined,
        GROK_AUTH_PROVIDER_COMMAND: undefined,
        GROK_AUTH_METHOD_ID: undefined,
      },
    });
    const status = async (id: string) =>
      (await nativeFetch(`${base}/session/${id}/status`, { headers }).then((response) =>
        response.json(),
      )) as { status: string; error?: string; readiness?: unknown; resumableSessionId?: string };
    const message = "Grok Build isn't signed in. Run grok login in a terminal to keep working.";

    // Grok's `authenticate` would wait on an interactive sign-in here; the
    // session is created without starting it.
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(created.ok).toBe(true);
    const { id } = (await created.json()) as { id: string };
    expect(await status(id)).toMatchObject({
      status: "idle",
      readiness: {
        state: "authentication-required",
        message,
        signIn: { kind: "terminal", hint: "Open a terminal and run grok login." },
      },
    });
    expect((await status(id)).resumableSessionId).toBeUndefined();

    const refused = await nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "hello", requestId: "before-login" }),
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: message, kind: "authentication-required" });

    await fs.writeFile(credential, "{}");
    expect((await status(id)).readiness).toBeUndefined();
    const accepted = await nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:signed in", requestId: "after-login" }),
    });
    expect(accepted.status).toBe(202);
    const settled = await waitFor(
      () => status(id),
      (value) => value.status === "idle" && value.resumableSessionId !== undefined,
    );
    expect(settled.error).toBeUndefined();
  });

  test("starts a deferred Grok session on the model chosen while signed out", async () => {
    const credential = resolve(await temporaryDirectory(), "auth.json");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: credential,
        XAI_API_KEY: undefined,
        GROK_AUTH_PROVIDER_COMMAND: undefined,
        GROK_AUTH_METHOD_ID: undefined,
      },
    });
    const status = async (id: string) =>
      (await nativeFetch(`${base}/session/${id}/status`, { headers }).then((response) =>
        response.json(),
      )) as {
        status: string;
        resumableSessionId?: string;
        composer: { selectedModelId?: string };
      };
    const { id } = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "grok-build" }),
    }).then((response) => response.json())) as { id: string };
    // A change made before a login exists is recorded without starting Grok.
    const configured = await nativeFetch(`${base}/session/${id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ modelId: "grok-composer-2.5-fast" }),
    });
    expect(configured.ok).toBe(true);
    expect((await status(id)).composer.selectedModelId).toBe("grok-composer-2.5-fast");

    await fs.writeFile(credential, "{}");
    await nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:signed in", requestId: "after-login" }),
    });
    const started = await waitFor(
      () => status(id),
      (value) => value.status === "idle" && value.resumableSessionId !== undefined,
    );
    expect(started.composer.selectedModelId).toBe("grok-composer-2.5-fast");
  });

  test("runtime health uses the shared envelope and answers unknown sessions in band", async () => {
    const { base, headers } = await spawnBridge();
    const missing = await nativeFetch(`${base}/session/missing/runtime-health`, { headers });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({
      summary: {},
      notices: [],
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
    });

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    });
    const session = (await created.json()) as { id: string };
    const health = await nativeFetch(`${base}/session/${session.id}/runtime-health`, { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      summary: expect.any(Object),
      notices: [],
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
    });
  });

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
    const stateDirectory = await temporaryDirectory();
    const commandsFile = resolve(workspace, "commands.json");
    const blocksFile = resolve(workspace, "prompt-blocks.log");
    const lifecycleFile = resolve(workspace, "lifecycle.log");
    if (options.commands) await fs.writeFile(commandsFile, JSON.stringify(options.commands));
    const env = {
      ACP_PROVIDER: "grok",
      CWD: workspace,
      FAKE_ACP_COMMANDS_FILE: commandsFile,
      FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_IMAGE_CAPABILITY: "true",
    };
    const bridge = await spawnBridge({ stateDirectory, env });
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
      stateDirectory,
      env,
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
      prompt: `/REVIEW  ${argumentsText}`,
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
    const messages = (await bridge.request("/messages").then((response) => response.json())) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(messages.messages.find((message) => message.role === "user")?.content).toBe(
      body.prompt.trim(),
    );

    const refresh = await bridge.request("/commands/refresh", { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ outcome: "reread" });
    // Refreshing never restarts the agent to make it announce again.
    expect(await bridge.starts()).toBe(1);
  });

  test("a restored selected command attaches and revalidates before dispatch", async () => {
    const bridge = await commandBridge({ commands: [review] });
    const initial = await waitFor(bridge.catalogue, (value) => value.status === "ready");
    await stopChild(bridge.child);
    const restarted = await spawnBridge({ stateDirectory: bridge.stateDirectory, env: bridge.env });
    const session = `${restarted.base}/session/${bridge.created.id}`;
    const request = (path: string, init: RequestInit = {}) =>
      nativeFetch(`${session}${path}`, { ...init, headers: restarted.headers });
    expect(await request("/commands").then((response) => response.json())).toMatchObject({
      status: "stale",
    });
    const response = await request("/prompt", {
      method: "POST",
      body: JSON.stringify({
        prompt: "/review src/a.ts",
        requestId: "restored-command-1",
        command: {
          id: "grok:review",
          name: "/review",
          executionKind: "provider-prompt",
          bindingRevision: initial.commands[0]!.bindingRevision,
          arguments: "src/a.ts",
        },
      }),
    });
    expect(response.status).toBe(202);
    await waitFor(
      () => request("").then((result) => result.json() as Promise<{ status: string }>),
      (value) => value.status === "idle",
    );
    expect((await bridge.blocks()).at(-1)).toEqual([{ type: "text", text: "/review src/a.ts" }]);
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

  // A backend from before the version-1 catalogue (ff4026b4e^, before #827)
  // talking to this bridge. Nested so it reuses `commandBridge`.
  describe("mixed-version: old backend, current bridge", () => {
    const LEGACY_SOURCES = new Set([
      "builtin",
      "project",
      "user",
      "plugin",
      "skill",
      "template",
      "extension",
      "orkestrator",
    ]);

    /**
     * The row reader of `HttpBridgeCatalogAdapter.slashCommands` at
     * `ff4026b4e^:apps/backend/src/core/http-bridge-catalog.ts:72-110`, minus
     * its byte truncation. It read `payload.commands` only, ignored unknown
     * fields, and prefixed a missing leading `/`.
     */
    function legacyReadCommands(payload: unknown) {
      const record = (value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      const commands = record(payload)?.commands;
      if (!Array.isArray(commands)) return [];
      const read = new Map<string, Record<string, unknown>>();
      for (const candidate of commands.slice(0, 512)) {
        const command = typeof candidate === "string" ? { name: candidate } : record(candidate);
        const rawName = typeof command?.name === "string" ? command.name : "";
        if (!rawName) continue;
        const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
        read.set(name, {
          name,
          source: LEGACY_SOURCES.has(command?.source as string) ? command!.source : "unknown",
          ...(typeof command?.description === "string" ? { description: command.description } : {}),
          ...(typeof command?.argumentHint === "string"
            ? { argumentHint: command.argumentHint }
            : {}),
          ...(Array.isArray(command?.aliases)
            ? { aliases: command.aliases.filter((alias) => typeof alias === "string") }
            : {}),
          ...(command?.scope === "global" || command?.scope === "session"
            ? { scope: command.scope }
            : {}),
        });
      }
      return [...read.values()];
    }

    test("an unknown session answers in band where the old fallback would have thrown", async () => {
      const bridge = await commandBridge();
      const read = (path: string) =>
        nativeFetch(`${bridge.base}${path}`, { headers: bridge.headers }).then(
          async (response) => ({
            status: response.status,
            body: (await response.json()) as unknown,
          }),
        );
      // Neither global route ever existed on ACP: pre-#827 they fell through
      // to the same `Not found` answer (ff4026b4e^:bridges/acp-bridge/src/acp-http.ts:184).
      expect(await read("/plugins/commands")).toEqual({
        status: 404,
        body: { error: "Not found" },
      });
      expect(await read("/global/slash-commands")).toEqual({
        status: 404,
        body: { error: "Not found" },
      });

      // Pre-#827 an unknown session's `/commands` was 404 `Session not found`
      // (acp-http.ts:192 there); the old reader then fell back to
      // `/plugins/commands`, got 404 again and `assertOk` threw. In band, the
      // same reader now gets an empty list instead of an error.
      const missing = await read("/session/missing/commands");
      expect(missing.status).toBe(200);
      expect(missing.body).toMatchObject({ status: "missing", commands: [] });
      expect(legacyReadCommands(missing.body)).toEqual([]);

      // The snapshot keeps its 404, which the old reader maps to `missing`.
      expect((await read("/session/missing/status")).status).toBe(404);
    });

    test("the enhanced session catalogue still reads as the old command list", async () => {
      const bridge = await commandBridge({
        commands: [
          review,
          { name: "/commit", description: "Commit" },
          { name: "plan" },
          { name: "legacy", description: "Old spelling", inputHint: "<legacy>" },
        ],
      });
      const response = await bridge.request("/commands");
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Catalogue;
      expect(payload.status).toBe("ready");

      // The envelope is additive: the rows alone read exactly the same.
      expect(Array.isArray(payload.commands)).toBe(true);
      expect(Object.keys(payload).sort()).toEqual([
        "catalogueVersion",
        "commands",
        "freshness",
        "generation",
        "revision",
        "status",
        "truncated",
      ]);
      expect(legacyReadCommands({ commands: payload.commands })).toEqual(
        legacyReadCommands(payload),
      );

      for (const row of payload.commands) {
        // Already `/`-prefixed, so the old reader's prefixing is a no-op and
        // the name it keys on is the one this bridge sends.
        expect(row.name).toEqual(expect.stringMatching(/^\/\S+$/));
        expect(LEGACY_SOURCES.has(row.source as string) || row.source === "unknown").toBe(true);
        for (const field of ["description", "argumentHint"] as const) {
          if (field in row) expect(typeof row[field]).toBe("string");
        }
        if ("aliases" in row) {
          expect((row.aliases as unknown[]).every((alias) => typeof alias === "string")).toBe(true);
        }
        expect(["global", "session", undefined]).toContain(row.scope as string | undefined);
      }

      // What the old backend now shows. Differences from the pre-#827 bridge
      // (ff4026b4e^:bridges/acp-bridge/src/acp-session.ts:959-980): source was
      // `builtin` and is `unknown`; a missing description no longer defaults
      // to the name; the hint now prefers standard ACP `input.hint` over
      // `inputHint`, so `/review` shows `<path>` where it showed `legacy hint`.
      expect(legacyReadCommands(payload)).toEqual([
        {
          name: "/review",
          source: "unknown",
          description: "Review changes",
          argumentHint: "<path>",
          scope: "session",
        },
        { name: "/commit", source: "unknown", description: "Commit", scope: "session" },
        { name: "/plan", source: "unknown", scope: "session" },
        {
          name: "/legacy",
          source: "unknown",
          description: "Old spelling",
          argumentHint: "<legacy>",
          scope: "session",
        },
      ]);
    });

    test("the session snapshot keeps the legacy keys and revision the old reader used", async () => {
      const bridge = await commandBridge({ commands: [review] });
      await waitFor(bridge.catalogue, (value) => value.status === "ready");
      type Snapshot = Record<string, unknown> & {
        revision: number;
        commandRevision: number;
        composer: Record<string, unknown>;
      };
      const snapshot = async () => {
        const status = (await bridge
          .request("/status")
          .then((response) => response.json())) as Snapshot;
        const session = (await bridge.request("").then((response) => response.json())) as {
          revision: number;
        };
        return { status, sessionRevision: session.revision };
      };
      // The checks the old Grok/ACP snapshot readers made
      // (ff4026b4e^:apps/backend/src/core/http-bridge-provider.ts:705-715 and
      // http-bridge-progressive.ts, which prefers `messageRevision` over
      // `revision` as the provider revision).
      const expectLegacyShape = (status: Snapshot) => {
        expect(["idle", "running", "error"]).toContain(status.status as string);
        expect(Number.isSafeInteger(status.revision)).toBe(true);
        expect(Array.isArray(status.composer.models)).toBe(true);
        expect(Array.isArray(status.composer.modes)).toBe(true);
        expect(typeof status.runtime).toBe("object");
        if ("error" in status) expect(typeof status.error).toBe("string");
        expect(status).not.toHaveProperty("messageRevision");
        expect(Number.isSafeInteger(status.commandRevision)).toBe(true);
      };

      const before = await snapshot();
      expectLegacyShape(before.status);
      // `revision` is still the session revision, not the command counter.
      expect(before.status.revision).toBe(before.sessionRevision);

      await fs.writeFile(bridge.commandsFile, "[]");
      expect((await bridge.prompt({ prompt: "COMMANDS_UPDATE" })).status).toBe(202);
      await bridge.idle();
      const after = await snapshot();
      expectLegacyShape(after.status);
      expect(after.status.commandRevision).toBe(before.status.commandRevision + 1);
      expect(after.status.revision).toBe(after.sessionRevision);
      // A push advanced `revision` before #827 too (acp-session.ts:977 there).
      expect(after.status.revision).toBeGreaterThan(before.status.revision);
    });

    test("an old backend's prompt body is sent to the agent as typed", async () => {
      const bridge = await commandBridge({ commands: [review] });
      await waitFor(bridge.catalogue, (value) => value.status === "ready");
      // No `allowProviderCommands`, no `command`: the old sender's body. It
      // means "interpret", and the bridge forwards the text unchanged — no
      // canonicalization, and no 422 for a name the inventory lacks (the old
      // sender would surface a 422 as a rejected prompt).
      for (const [requestId, prompt] of [
        ["legacy-command-1", "/REVIEW  src/a.ts"],
        ["legacy-command-2", "/unlisted do it"],
      ] as const) {
        expect((await bridge.prompt({ prompt, requestId })).status).toBe(202);
        await bridge.idle();
      }
      expect(await bridge.blocks()).toEqual([
        [{ type: "text", text: "/REVIEW  src/a.ts" }],
        [{ type: "text", text: "/unlisted do it" }],
      ]);
    });
  });

  describe("the shared compact action", () => {
    const compact = { name: "compact", description: "Compact the conversation" };
    const postCompact = (
      bridge: Awaited<ReturnType<typeof commandBridge>>,
      body?: Record<string, unknown>,
    ) =>
      bridge.request("/compact", {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    test("runs the agent's own /compact as a selected command, journaled once", async () => {
      const bridge = await commandBridge({ commands: [review, compact] });
      await waitFor(bridge.catalogue, (value) => value.status === "ready");

      // The backend sends no body; a caller may add a request id.
      expect((await postCompact(bridge)).status).toBe(202);
      await bridge.idle();
      expect((await postCompact(bridge, { requestId: "compact-1" })).status).toBe(202);
      await bridge.idle();
      const retry = await postCompact(bridge, { requestId: "compact-1" });
      expect(retry.status).toBe(202);
      expect(await retry.json()).toMatchObject({ duplicate: true });
      expect(
        await bridge.request("/dispatch?requestId=compact-1").then((response) => response.json()),
      ).toMatchObject({ dispatch: "dispatched" });

      expect(await bridge.blocks()).toEqual([
        [{ type: "text", text: "/compact" }],
        [{ type: "text", text: "/compact" }],
      ]);
      const messages = (await bridge.request("/messages").then((response) => response.json())) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(messages.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "/compact"],
        ["assistant", "ran:/compact"],
        ["user", "/compact"],
        ["assistant", "ran:/compact"],
      ]);
    });

    test("keeps compact journal outcomes after the live command is removed", async () => {
      const bridge = await commandBridge({ commands: [compact] });
      await waitFor(bridge.catalogue, (value) => value.status === "ready");
      expect((await postCompact(bridge, { requestId: "compact-removed" })).status).toBe(202);
      await bridge.idle();
      await fs.writeFile(bridge.commandsFile, "[]");
      expect((await bridge.prompt({ prompt: "COMMANDS_UPDATE" })).status).toBe(202);
      await bridge.idle();
      expect(await bridge.catalogue()).toMatchObject({ status: "ready", commands: [] });
      const before = await bridge.blocks();

      const retry = await postCompact(bridge, { requestId: "compact-removed" });
      expect(retry.status).toBe(202);
      expect(await retry.json()).toEqual({ accepted: true, duplicate: true });
      expect((await postCompact(bridge, { requestId: "compact-new" })).status).toBe(422);
      expect(await bridge.request("/dispatch?requestId=compact-new").then((r) => r.json())).toEqual(
        { dispatch: "unknown" },
      );
      expect(await bridge.blocks()).toEqual(before);

      // Simulate a process that accepted a compact turn but lost its outcome.
      await stopChild(bridge.child);
      const path = resolve(bridge.stateDirectory, "state.json");
      const saved = JSON.parse(await fs.readFile(path, "utf8"));
      const session = saved.sessions.find(
        (entry: { id: string }) => entry.id === bridge.created.id,
      );
      session.promptJournal.push({
        requestId: "compact-lost",
        state: "accepted",
        acceptedAt: Date.now(),
      });
      await fs.writeFile(path, JSON.stringify(saved));
      const restarted = await spawnBridge({
        stateDirectory: bridge.stateDirectory,
        env: bridge.env,
      });
      const request = (suffix: string, init: RequestInit = {}) =>
        nativeFetch(`${restarted.base}/session/${bridge.created.id}${suffix}`, {
          ...init,
          headers: restarted.headers,
        });
      // Attach to obtain an authoritative empty live inventory after restart.
      expect((await request("/attach", { method: "POST" })).status).toBe(200);
      await waitFor(
        () => request("/commands").then((r) => r.json()) as Promise<Catalogue>,
        (value) => value.status === "ready" && value.commands.length === 0,
      );
      const lost = await request("/compact", {
        method: "POST",
        body: JSON.stringify({ requestId: "compact-lost" }),
      });
      expect(lost.status).toBe(410);
      expect(await lost.json()).toMatchObject({ kind: "dispatch-outcome-lost" });
      expect(await request("/dispatch?requestId=compact-lost").then((r) => r.json())).toEqual({
        dispatch: "lost",
      });
      expect(await bridge.blocks()).toEqual(before);
    });

    test("is refused before journaling when the live inventory has no /compact", async () => {
      const bridge = await commandBridge({ commands: [review] });
      await waitFor(bridge.catalogue, (value) => value.status === "ready");
      const refused = await postCompact(bridge, { requestId: "compact-missing" });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({
        error: "Grok does not offer /compact in this session",
        kind: "command-unavailable",
      });
      expect(
        await bridge
          .request("/dispatch?requestId=compact-missing")
          .then((response) => response.json()),
      ).toEqual({ dispatch: "unknown" });
      expect(await bridge.blocks()).toEqual([]);
    });

    test("after a restart attaches and revalidates against the re-reported list", async () => {
      const bridge = await commandBridge({ commands: [compact] });
      await waitFor(bridge.catalogue, (value) => value.status === "ready");
      await stopChild(bridge.child);
      const restarted = await spawnBridge({
        stateDirectory: bridge.stateDirectory,
        env: bridge.env,
      });
      const session = `${restarted.base}/session/${bridge.created.id}`;
      const request = (path: string, init: RequestInit = {}) =>
        nativeFetch(`${session}${path}`, { ...init, headers: restarted.headers });
      expect(await request("/commands").then((response) => response.json())).toMatchObject({
        status: "stale",
      });

      // Restored rows never authorize a command: the agent dropped it while
      // the bridge was down, so the action is refused once it re-reports.
      await fs.writeFile(bridge.commandsFile, "[]");
      const refused = await request("/compact", { method: "POST" });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ kind: "command-unavailable" });

      await fs.writeFile(bridge.commandsFile, JSON.stringify([compact]));
      await stopChild(restarted.child);
      const again = await spawnBridge({ stateDirectory: bridge.stateDirectory, env: bridge.env });
      const accepted = await nativeFetch(`${again.base}/session/${bridge.created.id}/compact`, {
        method: "POST",
        headers: again.headers,
      });
      expect(accepted.status).toBe(202);
      await waitFor(
        () =>
          nativeFetch(`${again.base}/session/${bridge.created.id}`, {
            headers: again.headers,
          }).then((response) => response.json() as Promise<{ status: string }>),
        (value) => value.status === "idle",
      );
      expect((await bridge.blocks()).at(-1)).toEqual([{ type: "text", text: "/compact" }]);
    });
  });
});

describe("ACP session titles", () => {
  test("session_info_update names the session on every route and survives a restart", async () => {
    const workspace = await temporaryDirectory();
    const stateDirectory = await temporaryDirectory();
    const env = { ACP_PROVIDER: "grok", CWD: workspace };
    const first = await spawnBridge({ stateDirectory, env });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
    }).then((response) => response.json())) as { id: string };
    const routes = (bridge: { base: string; headers: Record<string, string> }) => {
      const read = (path: string) =>
        nativeFetch(`${bridge.base}/session/${created.id}${path}`, {
          headers: bridge.headers,
        }).then((response) => response.json() as Promise<Record<string, unknown>>);
      return {
        prompt: async (info: Record<string, unknown>) => {
          const response = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
            method: "POST",
            headers: bridge.headers,
            body: JSON.stringify({ prompt: `SESSION_INFO:${JSON.stringify(info)}` }),
          });
          expect(response.status).toBe(202);
          await waitFor(
            () => read(""),
            (session) => session.status === "idle",
          );
        },
        titles: async () => ({
          status: (await read("/status")).title,
          session: (await read("")).title,
          transcript: ((await read("/transcript?version=2")).value as Record<string, unknown>)
            .title,
        }),
      };
    };
    const live = routes(first);
    expect(await live.titles()).toEqual({
      status: undefined,
      session: undefined,
      transcript: undefined,
    });

    // One bounded line: control characters and whitespace runs fold to spaces.
    await live.prompt({ title: "  Fix\nlogin\t\u0000 flow  ", updatedAt: "2026-10-23T10:00:00Z" });
    const named = {
      status: "Fix login flow",
      session: "Fix login flow",
      transcript: "Fix login flow",
    };
    expect(await live.titles()).toEqual(named);
    // An update without a title, or with a malformed one, renames nothing.
    await live.prompt({ updatedAt: "2026-10-23T11:00:00Z" });
    await live.prompt({ title: 42 });
    expect(await live.titles()).toEqual(named);

    await stopChild(first.child);
    const second = await spawnBridge({ stateDirectory, env });
    const restored = routes(second);
    expect(await restored.titles()).toEqual(named);

    await restored.prompt({ title: "x".repeat(2_000) });
    expect((await restored.titles()).status).toBe("x".repeat(512));
    // `null` is ACP's explicit clear.
    await restored.prompt({ title: null });
    expect(await restored.titles()).toEqual({
      status: undefined,
      session: undefined,
      transcript: undefined,
    });
    await stopChild(second.child);
  });
});

describe("Grok sign-in routes carry no credential", () => {
  test("neither answers nor logs the key or the stored login", async () => {
    const directory = await temporaryDirectory();
    const credential = resolve(directory, "auth.json");
    await fs.writeFile(
      credential,
      JSON.stringify({
        access_token: AUTH_SECRET_CANARIES.accessToken,
        refresh_token: AUTH_SECRET_CANARIES.refreshToken,
      }),
    );
    const { child, base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: credential,
        XAI_API_KEY: AUTH_SECRET_CANARIES.xaiApiKey,
        GROK_AUTH_PROVIDER_COMMAND: undefined,
        GROK_AUTH_METHOD_ID: undefined,
      },
    });
    const output: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const read = async (path: string, method = "GET") => {
      const response = await nativeFetch(`${base}${path}`, { method, headers });
      return { status: response.status, body: (await response.json()) as unknown };
    };

    const status = await read("/global/auth");
    expect(status.status).toBe(200);
    expectAuthStatusShape(status.body);
    expect(status.body).toMatchObject({ state: "signed-in" });
    // A session start hands the planted key and login to the Grok child.
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const session = await read(`/session/${id}/status`);
    const login = await read("/global/auth/login", "POST");
    const logout = await read("/global/auth/logout", "POST");
    expect([login.status, logout.status]).toEqual([405, 405]);
    await stopChild(child);

    for (const [where, body] of [
      ["auth status", status.body],
      ["session status", session.body],
      ["sign-in refusal", login.body],
      ["sign-out refusal", logout.body],
    ] as const) {
      expectNoCanary(body, `Grok ${where}`);
    }
    expectNothingSecretLogged(output.join(""), "Grok bridge");
  });
});
