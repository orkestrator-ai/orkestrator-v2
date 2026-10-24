import { afterEach, beforeEach, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { CommandContext } from "./commands-context.js";
import { beginCursorSdkLogin } from "./cursor-sdk-bridge.js";

let root: string;
let context: CommandContext;
let entrypoint: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-cursor-login-")));
  entrypoint = path.join(root, "index.js");
  await fs.writeFile(entrypoint, "");
  context = { storage: { getDataDir: () => root } } as unknown as CommandContext;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A login child that prints its URL and records the environment it was given. */
function fakeSpawn(seen: NodeJS.ProcessEnv[]): typeof spawn {
  return ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    seen.push(options.env);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() =>
      child.stdout.write(`${JSON.stringify({ loginUrl: "https://cursor.example/login" })}\n`),
    );
    return child;
  }) as unknown as typeof spawn;
}

test("a client that opens the link itself keeps the browser on this machine closed", async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const handle = await beginCursorSdkLogin(context, {
    bridgeEntrypoint: entrypoint,
    runtime: "bun",
    spawnImpl: fakeSpawn(seen),
    openBrowser: false,
  });
  expect(handle.loginUrl).toBe("https://cursor.example/login");
  expect(seen[0]?.NO_OPEN_BROWSER).toBe("1");

  await beginCursorSdkLogin(context, {
    bridgeEntrypoint: entrypoint,
    runtime: "bun",
    spawnImpl: fakeSpawn(seen),
  });
  expect(seen[1]?.NO_OPEN_BROWSER).toBe(process.env.NO_OPEN_BROWSER);
});

test("the pinned SDK completes approval from another client and stores the key only on the selected leaf", async () => {
  // Real SDK and real login child, backed by a local approval service. No
  // external accounts, credentials or browser are involved.
  const { createHash } = await import("node:crypto");
  const { spawn: spawnReal } = await import("node:child_process");
  const { cursorSdkCredentialPath } = await import("./cursor-sdk-bridge.js");
  const browserMarker = path.join(root, "browser-opened");
  const bin = path.join(root, "bin");
  const leafHome = path.join(root, "leaf-home");
  await fs.mkdir(bin);
  await fs.mkdir(leafHome);
  for (const name of ["open", "xdg-open"]) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\ntouch '${browserMarker}'\n`, {
      mode: 0o700,
    });
  }
  let approve!: (response: Response) => void;
  let challenge = "";
  let uuid = "";
  let pollSeen!: () => void;
  const poll = new Promise<void>((resolve) => {
    pollSeen = resolve;
  });
  const requests: string[] = [];
  const service = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/auth/poll") {
        const body = (await request.json()) as { uuid: string; verifier: string };
        uuid = body.uuid;
        challenge = createHash("sha256").update(body.verifier).digest("base64url");
        const response = new Promise<Response>((resolve) => {
          approve = resolve;
        });
        pollSeen();
        return response;
      }
      if (url.pathname === "/loginDeepControl") {
        if (
          url.searchParams.get("uuid") !== uuid ||
          url.searchParams.get("challenge") !== challenge
        )
          return new Response("Invalid challenge", { status: 400 });
        approve(Response.json({ accessToken: "fake-session", refreshToken: "discarded-session" }));
        return new Response("Approved");
      }
      // Connect unary protobuf: CreateUserApiKeyResponse.api_key is field 1.
      if (url.pathname.endsWith("/CreateUserApiKey")) {
        const key = Buffer.from("local-test-api-key");
        return new Response(Buffer.concat([Buffer.from([10, key.length]), key]), {
          headers: { "content-type": "application/proto" },
        });
      }
      return new Response(new Uint8Array(), { headers: { "content-type": "application/proto" } });
    },
  });
  const loginCli = path.resolve(
    import.meta.dir,
    "../../../..",
    "bridges/cursor-bridge/src/login-cli.ts",
  );
  await fs.writeFile(
    entrypoint,
    `import { runLogin } from ${JSON.stringify(loginCli)}; process.exit(await runLogin((line) => console.log(line)));`,
  );
  const commandContext = {
    storage: { getDataDir: () => path.join(root, "command-node") },
  } as unknown as CommandContext;
  let handle: Awaited<ReturnType<typeof beginCursorSdkLogin>> | undefined;
  try {
    const spawnImpl = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) =>
      spawnReal(command, args, {
        ...options,
        env: {
          ...options?.env,
          HOME: leafHome,
          SSH_CONNECTION: "",
          SSH_CLIENT: "",
          SSH_TTY: "",
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          CURSOR_BACKEND_URL: service.url.origin,
          CURSOR_WEBSITE_URL: service.url.origin,
        },
      })) as typeof spawnReal;
    handle = await beginCursorSdkLogin(context, {
      bridgeEntrypoint: entrypoint,
      runtime: process.execPath,
      openBrowser: false,
      spawnImpl,
    });
    await poll;
    const loginUrl = new URL(handle.loginUrl);
    expect(loginUrl.searchParams.get("uuid")).toBe(uuid);
    // A separate HTTP client approves, as a browser on the command machine does.
    expect((await fetch(loginUrl)).status).toBe(200);
    await handle.completion;
    const stored = JSON.parse(await fs.readFile(cursorSdkCredentialPath(context), "utf8"));
    expect(stored.apiKey).toBe("local-test-api-key");
    expect(JSON.stringify(stored)).not.toContain("fake-session");
    expect(await fs.stat(cursorSdkCredentialPath(commandContext)).catch(() => null)).toBeNull();
    expect(
      await fs.stat(path.join(leafHome, ".cursor/sdk/auth.json")).catch(() => null),
    ).toBeNull();
    expect(await fs.stat(browserMarker).catch(() => null)).toBeNull();
    expect(requests.some((route) => route.endsWith("/CreateUserApiKey"))).toBe(true);
  } finally {
    handle?.cancel();
    service.stop(true);
  }
}, 15_000);
