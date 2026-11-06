import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  HOST_NETWORK_ENV,
  canIsolateNetwork,
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
      probe: () => true,
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
    const plan = loopbackNamespacePlan(command, { platform: "linux", env: {}, probe: () => false });
    expect(plan).toMatchObject({ command: "bunx", args: command.slice(1), isolated: false });
    expect(plan.reason).toContain("cannot create");
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
      loopbackNamespacePlan([], { platform: "linux", env: {}, probe: () => true }),
    ).toThrow("Usage");
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
