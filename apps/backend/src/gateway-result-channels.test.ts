import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");

test("minimal bandwidth CLI keeps all stdout parseable as its JSON report", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "apps/backend/scripts/remote-bandwidth-baseline.ts",
      "--workloads",
      "quiet",
      "--transports",
      "body",
      "--clients",
      "1",
      "--no-slow-client",
      "--duration-ms",
      "20",
      "--idle-ms",
      "0",
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, error: code === 0 ? "" : stderr }).toEqual({ code: 0, error: "" });
    const report = JSON.parse(stdout);
    expect(report.results).toHaveLength(1);
    expect(stderr).toContain("[gateway]");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 20_000);

for (const entry of [
  { path: "apps/backend/scripts/sse-route-probe.ts", args: ["serve", "--port", "0"], signal: true },
  { path: "apps/backend/src/preview-baseline-harness.ts", args: [], signal: false },
  { path: "e2e/fixture/data-saving-gateway-server.ts", args: [], signal: false },
  { path: "e2e/fixture/sse-gzip-gateway-server.ts", args: [], signal: false },
]) {
  test(`${entry.path} emits only its JSON readiness record on stdout`, async () => {
    const child = Bun.spawn([process.execPath, entry.path, ...entry.args], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let stdout = "";
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (!stdout.includes("\n")) {
            const next = await reader.read();
            if (next.done) throw new Error("Harness exited before readiness");
            stdout += new TextDecoder().decode(next.value);
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Harness readiness timed out")), 10_000);
        }),
      ]);
      clearTimeout(deadline);
      const ready = JSON.parse(stdout.trim());
      expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      if (entry.signal) child.kill("SIGTERM");
      else child.stdin.end();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        stdout += new TextDecoder().decode(next.value);
      }
      expect(await child.exited).toBe(0);
      expect(JSON.parse(stdout)).toEqual(ready);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(await stderr).toContain("[gateway]");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill();
      await child.exited;
      await stderr;
      reader.releaseLock();
    }
  }, 20_000);
}
