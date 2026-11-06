/**
 * Runs a command in a network namespace of its own whose only interface is
 * loopback, so host interface changes cannot reach it:
 *
 *   bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts
 *
 * On Linux, Chromium aborts in-flight requests, loopback included, with
 * `net::ERR_NETWORK_CHANGED` whenever a host interface appears or disappears,
 * which other builds' Docker networks do all the time (flake 2340). Under
 * Docker network churn the component browser suite lost 850 of the first
 * 1,024 cases that way; inside the namespace, under the same churn, it lost
 * none (to-do 7020).
 *
 * Only for suites that need nothing beyond loopback. The namespace is an
 * unprivileged user namespace, so the command runs as uid 0 inside it and
 * changes nothing on the host. Elsewhere (macOS, a kernel that refuses
 * unprivileged user namespaces, a host without `ip`), or with
 * `ORKESTRATOR_E2E_HOST_NETWORK=1`, the command runs on the host network.
 */
import { spawn, spawnSync } from "node:child_process";

export const HOST_NETWORK_ENV = "ORKESTRATOR_E2E_HOST_NETWORK";

/** `unshare` and `sh` exec in place, so the process is the command itself. */
const NAMESPACE_ARGS = ["--user", "--map-root-user", "--net"];
const RAISE_LOOPBACK = 'ip link set lo up && exec "$@"';

export interface LoopbackPlan {
  command: string;
  args: string[];
  /** Whether the command gets its own loopback-only network. */
  isolated: boolean;
  /** Why it runs on the host network, when there is something worth saying. */
  reason?: string;
}

/** Whether this host can create an unprivileged network namespace and raise its loopback. */
export function canIsolateNetwork(): boolean {
  const probe = spawnSync("unshare", [...NAMESPACE_ARGS, "ip", "link", "set", "lo", "up"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 0;
}

export function loopbackNamespacePlan(
  command: readonly string[],
  options: {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    probe: () => boolean;
  },
): LoopbackPlan {
  const [program, ...rest] = command;
  if (!program) throw new Error("Usage: bun scripts/loopback-network.ts -- <command> [args...]");
  const host = (reason?: string): LoopbackPlan => ({
    command: program,
    args: rest,
    isolated: false,
    ...(reason ? { reason } : {}),
  });
  if (options.env[HOST_NETWORK_ENV] === "1") return host(`${HOST_NETWORK_ENV}=1`);
  // Docker Desktop keeps its bridges inside its VM, so other platforms see no churn.
  if (options.platform !== "linux") return host();
  if (!options.probe())
    return host("this host cannot create an unprivileged network namespace with `ip`");
  return {
    command: "unshare",
    args: [...NAMESPACE_ARGS, "sh", "-c", RAISE_LOOPBACK, "sh", program, ...rest],
    isolated: true,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const plan = loopbackNamespacePlan(argv, {
    platform: process.platform,
    env: process.env,
    probe: canIsolateNetwork,
  });
  if (plan.isolated)
    console.error("[loopback-network] running in a private loopback-only network namespace");
  else if (plan.reason)
    console.error(
      `[loopback-network] running on the host network (${plan.reason}); host interface changes can abort browser requests (flake 2340)`,
    );
  const child = spawn(plan.command, plan.args, { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`[loopback-network] ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    // Die the way the command did, without this script's own forwarding handler.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
