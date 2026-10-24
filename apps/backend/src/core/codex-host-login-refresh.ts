import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { jwtExpiryMs } from "@orkestrator/protocol/login-snapshots";
import type { CommandContext } from "./commands-context.js";
import { resolveCodexBinary } from "./commands-agent-support.js";
import { readCodexAuthFile } from "./agent-accounts-homes.js";
import { INHERITED_CREDENTIAL_ENV } from "./agent-accounts-login.js";

const REFRESH_LEAD_MS = 5 * 60_000;
const RETRY_MS = 60_000;

/** Serialize per owning home and re-read inside the lock before spending a refresh token. */
export function createCodexLoginRefresher(
  context: CommandContext,
  refresh: (home: string) => Promise<void> = (home) => refreshHostCodexLogin(context, home),
  now = Date.now,
): (home: string) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  const attempts = new Map<string, { expiry: number | undefined; at: number }>();
  return (home) => {
    if (context.runtimeFlavor === "agent-test") return Promise.resolve();
    const key = path.resolve(home);
    const pending = running.get(key);
    if (pending) return pending;
    const task = (async () => {
      const raw = await readCodexAuthFile(key);
      let expiry: number | undefined;
      try {
        const auth = JSON.parse(raw ?? "");
        if (auth.OPENAI_API_KEY || !auth.tokens?.refresh_token?.trim()) return;
        expiry = jwtExpiryMs(auth.tokens?.access_token ?? "");
        if (expiry !== undefined && expiry - now() > REFRESH_LEAD_MS) return;
      } catch {
        return;
      }
      const previous = attempts.get(key);
      if (previous && previous.expiry === expiry && now() - previous.at < RETRY_MS) return;
      attempts.set(key, { expiry, at: now() });
      // Output from authentication must never reach logs or the renderer.
      await refresh(key).catch(() => undefined);
    })().finally(() => running.delete(key));
    running.set(key, task);
    return task;
  };
}

/**
 * Ask Codex's managed-auth implementation to renew the login in its own home.
 * account/read with refreshToken performs no model turn and persists the rotated
 * login itself. No renewable credentials are copied into a coordinator home.
 */
export async function refreshHostCodexLogin(
  context: CommandContext,
  home: string,
  spawnImpl: typeof spawn = spawn,
): Promise<void> {
  if (context.runtimeFlavor === "agent-test") return;
  const cwd = path.join(context.storage.getDataDir(), "codex-login-refresh");
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  for (const key of INHERITED_CREDENTIAL_ENV) delete env[key];
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(
      resolveCodexBinary(context),
      ["-c", 'cli_auth_credentials_store="file"', "app-server", "--listen", "stdio://"],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let done = false;
    let buffer = "";
    let bytes = 0;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (ok) resolve();
      else reject(new Error("Host Codex login refresh failed"));
    };
    const timer = setTimeout(() => finish(false), 30_000);
    timer.unref();
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
    child.stdin?.on("error", () => finish(false));
    child.stderr?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish(false);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return finish(false);
      buffer += chunk;
      let end: number;
      while (!done && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && !message.method) {
            if (message.error) return finish(false);
            send({ method: "initialized" });
            send({ id: 2, method: "account/read", params: { refreshToken: true } });
          } else if (message.id === 2 && !message.method) {
            finish(!message.error && message.result?.account?.type === "chatgpt");
          } else if (message.id !== undefined && message.method) {
            // A refresh has no interactive work; never approve unsolicited requests.
            send({ id: message.id, error: { code: -32601, message: "Unsupported request" } });
          }
        } catch {
          finish(false);
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "orkestrator_login_refresh", version: "1" },
      },
    });
  });
}
