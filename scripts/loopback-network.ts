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

export type IsolationProbe = { ok: true } | { ok: false; reason: string };

const PROBE_TIMEOUT_MS = 5_000;
const MAX_REASON_DETAIL = 160;

/**
 * Names why the namespace probe failed, so the fallback notice in a review
 * validation log on another host says which prerequisite is missing (to-do
 * 7020 task 2): `unshare`, `ip`, or the kernel's permission.
 */
export function classifyIsolationProbe(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error & { code?: string };
  stderr?: string | null;
}): IsolationProbe {
  if (result.error?.code === "ENOENT") return { ok: false, reason: "`unshare` is not installed" };
  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason: `the namespace probe did not finish within ${PROBE_TIMEOUT_MS / 1000} s`,
    };
  }
  if (result.error) {
    const detail = (result.error.code || result.error.name).slice(0, MAX_REASON_DETAIL);
    return { ok: false, reason: `the namespace probe failed (${detail})` };
  }
  if (result.signal) {
    return { ok: false, reason: `the namespace probe was terminated by ${result.signal}` };
  }
  if (result.status === 0) return { ok: true };
  const detail = (result.stderr ?? "").trim().split("\n")[0]!.trim().slice(0, MAX_REASON_DETAIL);
  if (result.status === 127 && /failed to execute ip\b/.test(detail)) {
    return { ok: false, reason: "`ip` (iproute2) is not installed" };
  }
  return {
    ok: false,
    reason: `this host refused an unprivileged user and network namespace (${detail || `exit ${result.status}`})`,
  };
}

/** Whether this host can create an unprivileged network namespace and raise its loopback, and if not why. */
export function probeNetworkIsolation(): IsolationProbe {
  return classifyIsolationProbe(
    spawnSync("unshare", [...NAMESPACE_ARGS, "ip", "link", "set", "lo", "up"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
    }),
  );
}

export function canIsolateNetwork(): boolean {
  return probeNetworkIsolation().ok;
}

export function loopbackNamespacePlan(
  command: readonly string[],
  options: {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    probe: () => IsolationProbe;
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
  const probe = options.probe();
  if (!probe.ok) return host(probe.reason);
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
    probe: probeNetworkIsolation,
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
