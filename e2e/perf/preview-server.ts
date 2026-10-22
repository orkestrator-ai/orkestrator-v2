import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stopProcessGroup, withCleanup } from "../process-cleanup";

async function assertPortAvailable(port: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

function matchesBuild(url: string, identity: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 256) request.destroy();
      });
      response.on("end", () => resolve(response.statusCode === 200 && body === identity));
      response.on("error", () => resolve(false));
    });
    // An absolute deadline also bounds a listener that accepts but never responds.
    const timer = setTimeout(() => request.destroy(), timeoutMs);
    request.on("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

/** A port probe rejects existing listeners; a per-launch marker fences the bind race. */
export async function startOwnedPreview(options: {
  command: string[];
  cwd: string;
  outDir: string;
  port: number;
  timeoutMs?: number;
}) {
  await assertPortAvailable(options.port);
  const identity = randomUUID();
  const marker = `orkestrator-perf-${identity}.txt`;
  const markerPath = path.join(options.outDir, marker);
  await writeFile(markerPath, identity);
  const child = spawn(options.command[0]!, options.command.slice(1), {
    cwd: options.cwd,
    stdio: "ignore",
    detached: true,
  });
  let failure: Error | undefined;
  child.once("error", (error) => (failure = error));
  child.once("exit", (code, signal) => {
    failure = new Error(`Fixture preview exited before measurement (${code ?? signal})`);
  });
  const url = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const matches = await matchesBuild(
        `${url}/${marker}`,
        identity,
        Math.max(1, Math.min(1_000, deadline - Date.now())),
      );
      if (failure) throw failure;
      if (matches) {
        await rm(markerPath, { force: true });
        if (failure) throw failure;
        return { url, process: child };
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Fixture server did not start: ${url}`);
  } catch (error) {
    await withCleanup(async () => {
      throw error;
    }, [() => stopProcessGroup(child), () => rm(markerPath, { force: true })]);
    throw error;
  }
}
