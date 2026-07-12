import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];
const processes: Bun.Subprocess[] = [];

afterAll(async () => {
  for (const process of processes) process.kill("SIGTERM");
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startBackend(): Promise<{
  url: string;
  token: string;
  readyMessage: Record<string, unknown>;
  child: Bun.Subprocess;
}> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-standalone-test-"));
  temporaryDirectories.push(dataDir);
  const rendererRoot = path.join(dataDir, "renderer");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), "<!doctype html><title>Orkestrator</title>");
  const child = Bun.spawn([
    process.execPath,
    path.join(root, "apps/backend/dist/main.js"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--unsafe-allow-non-tailscale-bind",
    "--data-dir", dataDir,
    "--app-root", root,
    "--resource-root", root,
    "--renderer-root", rendererRoot,
  ], { stdout: "pipe", stderr: "pipe" });
  processes.push(child);

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const timeout = Date.now() + 10_000;
  while (Date.now() < timeout) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`Backend exited during startup: ${await new Response(child.stderr).text()}`);
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (
          message.type === "orkestrator-backend-ready"
          && typeof message.url === "string"
          && typeof message.authFile === "string"
        ) {
          const auth = JSON.parse(await readFile(message.authFile, "utf8")) as { token?: unknown };
          if (typeof auth.token !== "string") throw new Error("Backend auth file is missing its token");
          return { url: message.url, token: auth.token, readyMessage: message, child };
        }
      } catch {
        // Human-readable gateway logs precede the machine-readable ready line.
      }
    }
  }
  child.kill();
  throw new Error("Timed out waiting for standalone backend");
}

describe("standalone backend service", () => {
  test("serves the web app and invokes backend commands without Electron", async () => {
    const { url, token, readyMessage } = await startBackend();
    expect(readyMessage).not.toHaveProperty("token");
    expect(JSON.stringify(readyMessage)).not.toContain(token);
    const authorization = { authorization: `Bearer ${token}` };
    const invokeResponse = await Bun.fetch(new URL("/__orkestrator/invoke", url), {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ command: "greet", args: { name: "standalone" } }),
    });
    expect(invokeResponse.status).toBe(200);
    expect(await invokeResponse.json()).toEqual({
      result: "Hello, standalone! You've been greeted from the Orkestrator backend!",
    });

    const webResponse = await Bun.fetch(url, { headers: authorization });
    expect(webResponse.status).toBe(200);
    expect(webResponse.headers.get("content-type")).toContain("text/html");
  });

  test("stops cleanly when a service manager sends SIGTERM", async () => {
    const { child } = await startBackend();
    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);
  });
});
