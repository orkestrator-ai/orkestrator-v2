import { expect, test } from "bun:test";
import { bridgeDiagnosticPayloads } from "../testing/bridge-diagnostic-lines.js";

const diagnosticsPath = new URL("./bridge-diagnostics.ts", import.meta.url).pathname;
const loggerPath = new URL("../logger.ts", import.meta.url).pathname;

async function runChild(before: string, after: string, signal?: "SIGTERM" | "SIGINT") {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      import { createBufferedDebugLogger } from ${JSON.stringify(diagnosticsPath)};
      import { configureLogger } from ${JSON.stringify(loggerPath)};
      configureLogger({ level: "debug" });
      ${before}
      const logger = createBufferedDebugLogger("claude", new Set(["result"]), () => true);
      logger.record("result", { durationMs: 4 });
      ${after}
    `,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ORKESTRATOR_LOG_FORMAT: "text" } },
  );
  const reader = child.stdout.getReader();
  let output = "";
  let signalled = false;
  const drain = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (signal && output.includes("ready\n") && !signalled) {
        signalled = true;
        child.kill(signal);
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await child.exited;
    await drain;
    expect(await stderr).toBe("");
    const snapshots = bridgeDiagnosticPayloads(output.split("\n"));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      event: "debug-events",
      events: [
        { event: "result", count: 1, metrics: { durationMs: { n: 1, min: 4, max: 4, sum: 4 } } },
      ],
    });
    return { output, exitCode: child.exitCode, signalCode: child.signalCode };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

test.each(["SIGTERM", "SIGINT"] as const)(
  "%s flushes the final batch and preserves signal termination without another listener",
  async (signal) => {
    const result = await runChild(
      "",
      `
      if (process.listenerCount(${JSON.stringify(signal)}) !== 1) process.exit(2);
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
      `,
      signal,
    );
    expect(result.signalCode).toBe(signal);
  },
  10_000,
);

test.each(["SIGTERM", "SIGINT"] as const)(
  "%s respects an earlier once handler's asynchronous cleanup and chosen exit status",
  async (signal) => {
    const result = await runChild(
      `
      process.once(${JSON.stringify(signal)}, async () => {
        await Bun.sleep(50);
        process.stdout.write("cleanup-complete\\n");
        process.exit(37);
      });
      `,
      `
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
      `,
      signal,
    );
    expect(result.output).toContain("cleanup-complete\n");
    expect(result.exitCode).toBe(37);
    expect(result.signalCode).toBeNull();
  },
  10_000,
);

test.each(["drained loop", "process.exit"] as const)(
  "%s flushes exactly one final batch without waiting for the minute timer",
  async (exit) => {
    const result = await runChild("", exit === "process.exit" ? "process.exit(23);" : "");
    expect(result.exitCode).toBe(exit === "process.exit" ? 23 : 0);
    expect(result.signalCode).toBeNull();
  },
  10_000,
);
