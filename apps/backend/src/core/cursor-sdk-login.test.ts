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
