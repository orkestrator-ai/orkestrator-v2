import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  HOST_NETWORK_ENV,
  REVIEW_VALIDATION_ENV,
  canIsolateNetwork,
  classifyIsolationProbe,
  freeLoopbackPort,
  loopbackNamespacePlan,
  parseLoopbackArgs,
  portsToAssign,
} from "../../scripts/loopback-network";

const root = path.resolve(import.meta.dir, "../..");
const script = path.join(root, "scripts/loopback-network.ts");
const command = ["bunx", "playwright", "test", "--config", "e2e/playwright.config.ts"];

describe("loopbackNamespacePlan", () => {
  test("wraps the command in an unprivileged user and network namespace on Linux", () => {
    const plan = loopbackNamespacePlan(command, {
      platform: "linux",
      env: {},
      probe: () => ({ ok: true }),
    });
    expect(plan.isolated).toBe(true);
    expect(plan.command).toBe("unshare");
    expect(plan.args).toEqual([
      "--user",
      "--map-root-user",
      "--net",
      "sh",
      "-c",
      'ip link set lo up && exec "$@"',
      "sh",
      ...command,
    ]);
  });

  test("runs the command as it is where the host cannot isolate it, and says why", () => {
    const plan = loopbackNamespacePlan(command, {
      platform: "linux",
      env: {},
      probe: () => ({ ok: false, reason: "`ip` (iproute2) is not installed" }),
    });
    expect(plan).toMatchObject({ command: "bunx", args: command.slice(1), isolated: false });
    expect(plan.reason).toBe("`ip` (iproute2) is not installed");
  });

  test("leaves other platforms on the host network without a notice or a probe", () => {
    const plan = loopbackNamespacePlan(command, {
      platform: "darwin",
      env: {},
      probe: () => {
        throw new Error("probed");
      },
    });
    expect(plan).toEqual({ command: "bunx", args: command.slice(1), isolated: false });
  });

  test("the opt-out keeps the host network without probing", () => {
    const plan = loopbackNamespacePlan(command, {
      platform: "linux",
      env: { [HOST_NETWORK_ENV]: "1" },
      probe: () => {
        throw new Error("probed");
      },
    });
    expect(plan.isolated).toBe(false);
    expect(plan.reason).toBe(`${HOST_NETWORK_ENV}=1`);
  });

  test("refuses an empty command", () => {
    expect(() =>
      loopbackNamespacePlan([], { platform: "linux", env: {}, probe: () => ({ ok: true }) }),
    ).toThrow("Usage");
  });
});

describe("classifyIsolationProbe", () => {
  test("a clean exit isolates", () => {
    expect(classifyIsolationProbe({ status: 0, stderr: "" })).toEqual({ ok: true });
  });

  test("names the missing prerequisite", () => {
    const missingUnshare = Object.assign(new Error("spawnSync unshare ENOENT"), { code: "ENOENT" });
    expect(classifyIsolationProbe({ status: null, error: missingUnshare })).toEqual({
      ok: false,
      reason: "`unshare` is not installed",
    });
    // util-linux's own message when `ip` is missing.
    expect(
      classifyIsolationProbe({
        status: 127,
        stderr: "unshare: failed to execute ip: No such file or directory\n",
      }),
    ).toEqual({ ok: false, reason: "`ip` (iproute2) is not installed" });
  });

  test("passes the kernel's refusal through, bounded to one line", () => {
    const refused = classifyIsolationProbe({
      status: 1,
      stderr: `unshare: unshare failed: Operation not permitted\n${"x".repeat(500)}`,
    });
    expect(refused).toEqual({
      ok: false,
      reason:
        "this host refused an unprivileged user and network namespace (unshare: unshare failed: Operation not permitted)",
    });
    const long = classifyIsolationProbe({ status: 2, stderr: "y".repeat(500) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason.length).toBeLessThan(260);
    expect(classifyIsolationProbe({ status: 1, stderr: "" })).toEqual({
      ok: false,
      reason: "this host refused an unprivileged user and network namespace (exit 1)",
    });
  });

  test("a probe that times out does not isolate", () => {
    const timedOut = Object.assign(new Error("spawnSync unshare ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(classifyIsolationProbe({ status: null, error: timedOut })).toEqual({
      ok: false,
      reason: "the namespace probe did not finish within 5 s",
    });
    expect(classifyIsolationProbe({ status: null, error: timedOut, signal: "SIGTERM" })).toEqual({
      ok: false,
      reason: "the namespace probe did not finish within 5 s",
    });
  });

  test("names non-timeout spawn failures", () => {
    const denied = Object.assign(new Error("spawnSync unshare EACCES"), { code: "EACCES" });
    expect(classifyIsolationProbe({ status: null, error: denied })).toEqual({
      ok: false,
      reason: "the namespace probe failed (EACCES)",
    });
  });

  test("names terminating signals without assuming a timeout", () => {
    for (const signal of ["SIGSYS", "SIGKILL"] as const) {
      expect(classifyIsolationProbe({ status: null, signal })).toEqual({
        ok: false,
        reason: `the namespace probe was terminated by ${signal}`,
      });
    }
  });
});

// Review validation on the host network failed before any test ran when port
// 1422 was already taken (another checkout's fixture server, a dev server).
describe("a review validation run's own port", () => {
  test("reads repeatable --free-port options ahead of the command", () => {
    expect(
      parseLoopbackArgs(["--free-port", "A_PORT", "--free-port", "B_PORT", "--", ...command]),
    ).toEqual({ freePorts: ["A_PORT", "B_PORT"], command });
    expect(parseLoopbackArgs(["--", ...command])).toEqual({ freePorts: [], command });
    expect(parseLoopbackArgs(command)).toEqual({ freePorts: [], command });
    expect(() => parseLoopbackArgs(["--free-port", "--", ...command])).toThrow(
      "--free-port needs an environment variable name",
    );
  });

  test("assigns ports only to review validation on the host network, never over a chosen one", () => {
    const review = { [REVIEW_VALIDATION_ENV]: "1" };
    expect(portsToAssign(["A_PORT", "A_PORT"], { isolated: false, env: review })).toEqual([
      "A_PORT",
    ]);
    // A private namespace has every port free.
    expect(portsToAssign(["A_PORT"], { isolated: true, env: review })).toEqual([]);
    // A person's run keeps the default so it can reuse a server left running.
    expect(portsToAssign(["A_PORT"], { isolated: false, env: {} })).toEqual([]);
    expect(
      portsToAssign(["A_PORT"], { isolated: false, env: { ...review, A_PORT: "5000" } }),
    ).toEqual([]);
  });

  test("hands out a loopback port nothing listens on", async () => {
    const port = await freeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });

  test("the script sets the variable for the command it runs", () => {
    const result = spawnSync(
      "bun",
      [script, "--free-port", "ORK_TEST_FREE_PORT", "--", "sh", "-c", 'echo "$ORK_TEST_FREE_PORT"'],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          [HOST_NETWORK_ENV]: "1",
          [REVIEW_VALIDATION_ENV]: "1",
          ORK_TEST_FREE_PORT: "",
        },
      },
    );
    expect(result.status).toBe(0);
    const port = Number(result.stdout.trim());
    expect(Number.isSafeInteger(port) && port > 0).toBe(true);
    expect(result.stderr).toContain(
      `[loopback-network] review validation: ORK_TEST_FREE_PORT=${port} for this run`,
    );
  });
});

describe("the loopback-network script", () => {
  test.skipIf(process.platform !== "linux")(
    "prints the fallback cause and runs the command",
    () => {
      const bin = mkdtempSync(path.join(tmpdir(), "ork-loopback-fallback-"));
      try {
        const unshare = path.join(bin, "unshare");
        writeFileSync(
          unshare,
          "#!/bin/sh\nprintf 'unshare: unshare failed: Operation not permitted\\n' >&2\nexit 1\n",
        );
        chmodSync(unshare, 0o700);
        const result = spawnSync(
          process.execPath,
          [script, "--", process.execPath, "-e", "process.exit(7)"],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, PATH: bin, [HOST_NETWORK_ENV]: "" },
          },
        );
        expect(result.status).toBe(7);
        expect(result.stderr).toContain(
          "[loopback-network] running on the host network (this host refused an unprivileged user and network namespace (unshare: unshare failed: Operation not permitted))",
        );
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("passes the command's exit status through", () => {
    const result = spawnSync("bun", [script, "--", "sh", "-c", "exit 7"], { encoding: "utf8" });
    expect(result.status).toBe(7);
  });

  test.skipIf(process.platform !== "linux" || !canIsolateNetwork())(
    "gives the command a raised loopback and no other interface",
    () => {
      const result = spawnSync(
        "bun",
        [script, "--", "sh", "-c", "ip -o link | cut -d: -f2 | tr -d ' '; ip -o addr show lo"],
        { encoding: "utf8", env: { ...process.env, [HOST_NETWORK_ENV]: "" } },
      );
      expect(result.status).toBe(0);
      const [interfaces, ...addresses] = result.stdout.trim().split("\n");
      expect(interfaces).toBe("lo");
      expect(addresses.join("\n")).toContain("127.0.0.1");
    },
  );
});

describe("loopback wrapper failure and signal paths", () => {
  test("reports spawn failure as exit 127", () => {
    const result = spawnSync("bun", [script, "--", "/nonexistent-orkestrator-test-command"], {
      encoding: "utf8",
      env: { ...process.env, [HOST_NETWORK_ENV]: "1" },
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("[loopback-network]");
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test.skipIf(process.platform === "win32")(`forwards and re-raises ${signal}`, async () => {
      // This child is created by this test; readiness proves the forwarding handlers are installed.
      const wrapper = spawn(
        "bun",
        [
          script,
          "--",
          process.execPath,
          "-e",
          // The handler writes synchronously: it re-raises the signal at once,
          // so a buffered write could die with the process.
          `process.on("${signal}", () => { require("node:fs").writeSync(1, "forwarded\\n"); process.removeAllListeners("${signal}"); process.kill(process.pid, "${signal}"); }); console.log("ready"); setInterval(() => {}, 1000);`,
        ],
        {
          env: { ...process.env, [HOST_NETWORK_ENV]: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      // "close", not "exit": the child's `forwarded` line travels on the stdout
      // pipe, which is read independently of the process exit. Only "close"
      // follows the end of both, so the output is complete once it fires.
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          wrapper.on("error", reject);
          wrapper.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      try {
        // Wait for the readiness line itself. An early wrapper exit fails the
        // wait at once; otherwise the test's budget is only the hang watchdog.
        await new Promise<void>((resolve, reject) => {
          wrapper.stdout!.on("data", (chunk) => {
            output += chunk.toString();
            if (output.includes("ready")) resolve();
          });
          void exited.then(() => reject(new Error("wrapper exited before the child was ready")));
        });
        wrapper.kill(signal);
        const result = await exited;
        expect(output).toContain("forwarded");
        expect(result).toEqual({ code: null, signal });
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGTERM");
      }
    });
  }
});
