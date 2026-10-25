/**
 * The pinned Cursor SDK's login skips its browser launch under
 * `NO_OPEN_BROWSER`.
 *
 * A sign-in started from another machine's Settings runs the login child on
 * this machine with `NO_OPEN_BROWSER=1` (`cursor_sdk_login_start
 * { openBrowser: false }`), and the client opens the link instead. The bridge
 * still asks the SDK to open a browser (`login-cli.ts`), so whether a browser
 * appears on this machine's desktop rests entirely on the SDK's own check.
 *
 * Each case runs the real SDK in a child process whose PATH starts with a
 * fake opener (`open` on macOS, `xdg-open` on Linux) that records its call,
 * and whose backend is a closed local port, so nothing leaves the machine.
 * The control case, without the variable, proves the fake opener is reached.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const opener =
  process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;

const LOGIN_SCRIPT = `
import { Cursor } from "@cursor/sdk";
const controller = new AbortController();
let published = false;
const login = Cursor.auth.login({
  openBrowser: true,
  backendUrl: "http://127.0.0.1:9",
  websiteUrl: "http://127.0.0.1:9",
  store: null,
  signal: controller.signal,
  onLoginUrl: () => { published = true; },
}).catch(() => undefined);
// The opener is spawned right after the URL is published, before polling.
await new Promise((done) => setTimeout(done, 1500));
controller.abort();
await Promise.race([login, new Promise((done) => setTimeout(done, 2000))]);
console.log(JSON.stringify({ published }));
process.exit(0);
`;

let dir: string;
const bridgeDir = resolve(import.meta.dir, "..");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-no-open-browser-"));
  if (!opener) return;
  const fake = join(dir, opener);
  writeFileSync(fake, `#!/bin/sh\ntouch "${join(dir, "opened")}"\n`);
  chmodSync(fake, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runLogin(extraEnv: Record<string, string>): Promise<{ published: boolean }> {
  rmSync(join(dir, "opened"), { force: true });
  const env: Record<string, string> = {
    PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: dir,
    ...extraEnv,
  };
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["-e", LOGIN_SCRIPT], {
      cwd: bridgeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        done(JSON.parse(line) as { published: boolean });
      } catch {
        fail(new Error(`login child exited ${code}: ${stderr}`));
      }
    });
  });
}

describe.skipIf(!opener)("Cursor SDK login browser launch", () => {
  test("opens the system browser when nothing forbids it", async () => {
    const result = await runLogin({});
    expect(result.published).toBe(true);
    // The control: without it the next test would pass with any opener.
    expect(existsSync(join(dir, "opened"))).toBe(true);
  }, 15_000);

  test("skips the launch under NO_OPEN_BROWSER and still publishes the URL", async () => {
    const result = await runLogin({ NO_OPEN_BROWSER: "1" });
    expect(result.published).toBe(true);
    expect(existsSync(join(dir, "opened"))).toBe(false);
  }, 15_000);
});
