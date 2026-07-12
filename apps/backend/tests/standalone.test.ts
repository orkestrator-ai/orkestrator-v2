import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

const root = path.resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];
const processes: Bun.Subprocess[] = [];

afterAll(async () => {
  for (const process of processes) process.kill("SIGTERM");
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startBackend(): Promise<{ url: string; token: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-standalone-test-"));
  temporaryDirectories.push(dataDir);
  const rendererRoot = path.join(dataDir, "renderer");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), "<!doctype html><title>Orkestrator</title>");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  const child = Bun.spawn([
    process.execPath,
    path.join(root, "apps/backend/dist/main.js"),
    "--host", "127.0.0.1",
    "--port", String(port),
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
        const message = JSON.parse(line) as { type?: string; url?: string; token?: string };
        if (message.type === "orkestrator-backend-ready" && message.url && message.token) {
          return { url: message.url, token: message.token };
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
    const { url, token } = await startBackend();
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
});
