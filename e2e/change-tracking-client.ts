import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export async function startChangeTrackingHost() {
  const child = spawn("bun", [join(import.meta.dirname, "change-tracking-host.ts")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  let startupTimer: ReturnType<typeof setTimeout>;
  const port = await new Promise<number>((resolve, reject) => {
    startupTimer = setTimeout(() => {
      child.stdin.end();
      reject(new Error("Change fixture startup deadline"));
    }, 30_000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Change fixture exited before startup")));
    lines.on("line", (line) => {
      if (line.startsWith("CHANGES_PORT:")) resolve(Number(line.slice(13)));
    });
  }).finally(() => clearTimeout(startupTimer));
  return {
    async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        body: JSON.stringify({ command, args }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as { result?: unknown };
      if (!response.ok) throw new Error("Change fixture command failed");
      return body.result;
    },
    async close() {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      await exited;
      lines.close();
    },
  };
}
