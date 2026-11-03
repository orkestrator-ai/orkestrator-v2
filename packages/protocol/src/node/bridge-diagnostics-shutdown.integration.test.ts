import { expect, test } from "bun:test";
import { bridgeDiagnosticPayloads } from "../testing/bridge-diagnostic-lines.js";

test.each(["SIGTERM", "SIGINT"] as const)(
  "%s flushes the final batch and preserves signal termination without another listener",
  async (signal) => {
    const modulePath = new URL("./bridge-diagnostics.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { createBufferedDebugLogger } from ${JSON.stringify(modulePath)};
      import { configureLogger } from ${JSON.stringify(new URL("../logger.ts", import.meta.url).pathname)};
      configureLogger({ level: "debug" });
      const logger = createBufferedDebugLogger("claude", new Set(["result"]), () => true);
      logger.record("result", { durationMs: 4 });
      if (process.listenerCount(${JSON.stringify(signal)}) !== 1) process.exit(2);
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, ORKESTRATOR_LOG_FORMAT: "text" } },
    );
    const reader = child.stdout.getReader();
    let output = "";
    const drain = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (output.includes("ready\n") && !output.includes("signalled")) {
          output += "signalled\n";
          child.kill(signal);
        }
      }
    })();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child.exited;
      await drain;
      expect(await new Response(child.stderr).text()).toBe("");
      expect(child.signalCode).toBe(signal);
      const snapshots = bridgeDiagnosticPayloads(output.split("\n"));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        event: "debug-events",
        events: [
          { event: "result", count: 1, metrics: { durationMs: { n: 1, min: 4, max: 4, sum: 4 } } },
        ],
      });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  },
  10_000,
);
