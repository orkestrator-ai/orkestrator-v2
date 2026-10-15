import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
// Type-only: loading the service itself needs Bun's SQLite, which Node lacks.
import type { DesignService } from "../apps/backend/src/core/design-service";
import {
  DESIGN_SERVICE_METHODS,
  REPLY_PREFIX,
  type DesignHostReply,
  type DesignHostRequest,
  type DesignServiceMethod,
} from "./design-service-protocol";

type HostedMethods = {
  [K in DesignServiceMethod]: (
    ...args: Parameters<DesignService[K]>
  ) => Promise<Awaited<ReturnType<DesignService[K]>>>;
};

export type DesignServiceHost = HostedMethods & {
  /** Runs a design command handler, as the gateway would for the renderer. */
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  /** Runs an agent design action for the fixture environment. */
  action(action: string, input: Record<string, unknown>): Promise<unknown>;
  /** Closes the service and waits for the host to exit. */
  close(): Promise<void>;
};

/**
 * Starts a real design service for the fixture environment in a Bun child
 * process (`design-service-host.ts`). Playwright runs specs under Node, which
 * cannot load the service's `bun:sqlite` storage. Results and errors cross as
 * JSON, as they do through the gateway; an error keeps only its message.
 */
export function startDesignServiceHost(dataDir: string, worktree: string): DesignServiceHost {
  const child = spawn(
    "bun",
    [join(import.meta.dirname, "design-service-host.ts"), dataDir, worktree],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let exitError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitError = new Error(`Design service host exited (${signal ?? code})`);
      for (const request of pending.values()) request.reject(exitError);
      pending.clear();
      resolve();
    });
  });
  child.once("error", (error) => {
    exitError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith(REPLY_PREFIX)) return;
    const reply = JSON.parse(line.slice(REPLY_PREFIX.length)) as DesignHostReply;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.result);
    else request.reject(new Error(reply.message));
  });

  const send = (kind: DesignHostRequest["kind"], name: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (exitError) return reject(exitError);
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ id, kind, name, args } satisfies DesignHostRequest)}\n`,
      );
    });

  const methods = Object.fromEntries(
    DESIGN_SERVICE_METHODS.map((name) => [
      name,
      (...args: unknown[]) => send("service", name, args),
    ]),
  ) as HostedMethods;
  return {
    ...methods,
    invoke: (command, args) => send("invoke", command, [args]),
    action: (action, input) => send("action", action, [input]),
    close: async () => {
      if (!exitError) {
        await send("close", "", []).catch(() => undefined);
        child.stdin.end();
      }
      // A host that will not exit must not outlive its spec.
      const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(kill);
    },
  };
}
