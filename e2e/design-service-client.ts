import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
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
  return createDesignServiceClient(child);
}

/** Adapts an owned host process; the deadline includes its close RPC and exit. */
export function createDesignServiceClient(
  child: ChildProcessByStdio<Writable, Readable, null>,
  shutdownTimeoutMs = 10_000,
): DesignServiceHost {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let exitError: Error | undefined;
  let closing: Promise<void> | undefined;
  const fail = (error: Error) => {
    exitError ??= error;
    for (const request of pending.values()) request.reject(exitError);
    pending.clear();
  };
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      fail(new Error(`Design service host exited (${signal ?? code})`));
    });
    // Unlike exit, close also fires when spawning failed before a PID existed.
    child.once("close", () => resolve());
  });
  child.once("error", fail);
  child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.startsWith(REPLY_PREFIX)) return;
    let reply: DesignHostReply;
    try {
      const value = JSON.parse(line.slice(REPLY_PREFIX.length));
      if (
        !value ||
        !Number.isSafeInteger(value.id) ||
        typeof value.ok !== "boolean" ||
        (!value.ok && typeof value.message !== "string")
      ) {
        throw new Error("Invalid reply shape");
      }
      reply = value;
    } catch {
      fail(new Error("Malformed design service host reply"));
      return;
    }
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.result);
    else request.reject(new Error(reply.message));
  });

  const send = (kind: DesignHostRequest["kind"], name: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (exitError) return reject(exitError);
      if (closing && kind !== "close") return reject(new Error("Design service host is closing"));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(
          `${JSON.stringify({ id, kind, name, args } satisfies DesignHostRequest)}\n`,
          (error) => {
            if (error) fail(error);
          },
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
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
    close: () =>
      (closing ??= (async () => {
        // Arm before asking the service to close: that request can itself hang.
        const kill = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
        try {
          if (!exitError) {
            await Promise.race([send("close", "", []).catch(() => undefined), exited]);
          }
          child.stdin.end();
          await exited;
        } finally {
          clearTimeout(kill);
          lines.close();
        }
      })()),
  };
}
