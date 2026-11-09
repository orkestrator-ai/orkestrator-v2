import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {
  HOST_NETWORK_ENV,
  canIsolateNetwork,
  classifyIsolationProbe,
  loopbackNamespacePlan,
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

  test("a probe that times out or is killed does not isolate", () => {
    const timedOut = Object.assign(new Error("spawnSync unshare ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(classifyIsolationProbe({ status: null, error: timedOut })).toEqual({
      ok: false,
      reason: "the namespace probe did not finish within 5 s",
    });
    expect(classifyIsolationProbe({ status: null, signal: "SIGKILL" }).ok).toBe(false);
  });
});

describe("the loopback-network script", () => {
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
    test.skipIf(process.platform === "win32")(
      `forwards and re-raises ${signal}`,
      async () => {
        // This child is created by this test; readiness proves the forwarding handlers are installed.
        const wrapper = spawn(
          "bun",
          [
            script,
            "--",
            process.execPath,
            "-e",
            `process.on("${signal}", () => { console.log("forwarded"); process.removeAllListeners("${signal}"); process.kill(process.pid, "${signal}"); }); console.log("ready"); setInterval(() => {}, 1000);`,
          ],
          {
            env: { ...process.env, [HOST_NETWORK_ENV]: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        const exited = new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            wrapper.on("error", reject);
            wrapper.on("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("child did not become ready")), 3000);
            wrapper.stdout!.on("data", (chunk) => {
              output += chunk.toString();
              if (output.includes("ready")) {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          wrapper.kill(signal);
          const result = await exited;
          expect(output).toContain("forwarded");
          expect(result).toEqual({ code: null, signal });
        } finally {
          if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGTERM");
        }
      },
      5000,
    );
  }
});
