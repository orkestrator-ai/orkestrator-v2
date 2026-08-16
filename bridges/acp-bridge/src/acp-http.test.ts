import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  here,
  nativeFetch,
  spawnBridge,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";


describe("ACP bridge", () => {



  // The fake agent records its own argv, so these assert the exact command line
  // the bridge builds. They cannot prove the real CLIs accept those flags —
  // `docs/upgrade-agents.md` carries that as a manual step for version bumps.
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
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase())
      .toContain("x-orkestrator-acp-token");

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
    const session = await created.json() as { id: string };

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
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_HANG_INITIALIZE: "1",
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      ACP_RPC_TIMEOUT_MS: "100",
    } });
    const controller = new AbortController();
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
    await waitFor(async () => {
      try {
        process.kill(agentPid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    expect(lifecycle.match(/^start:/gm)).toHaveLength(1);
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
  });



  test("bounds one oversized response without failing the session", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "OVERSIZED", requestId: "oversized-1" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; error?: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThan(8 * 1024 * 1024);
    // Bounded, and the cut is announced in the transcript the user reads.
    expect(session.messages[1]?.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
  });



  test("announces overflow when earlier stream chunks leave no room for the marker", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "STREAMOVERFLOW: cross the cap in two chunks" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
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
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CLOSESTDIN", requestId: "closed-input-1" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, { method: "POST", headers });
      expect(cancelled.status).toBe(202);
      await Bun.sleep(20);
    }

    expect(child.exitCode).toBe(null);
    expect((await nativeFetch(`${base}/global/health`)).ok).toBe(true);
    expect((await nativeFetch(`${base}/session/${created.id}`, { headers })).status).toBe(200);
  });

});
