import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { STARTUP_FAILED_TEXT } from "./electron-startup-recovery";

/**
 * Shared by the two live fixtures of `electron-startup-recovery.integration.test.ts`
 * (to-do 7062 task 2): a private network namespace, a module fan-out server
 * and bounded bursts of interface churn.
 *
 * The qualification asserts exactly one reload, so the churn must be over
 * before the reload starts. Two late events used to reach the reloaded page:
 *
 * - a bridge left up when the burst stopped gets its IPv6 link-local address
 *   about 1.5 s later, after duplicate address detection, and Chromium aborts
 *   the reload's module loads on that address change (seen 2026-11-10 with
 *   `ip monitor`; the reload then needed a second one);
 * - a burst that outlived the first load's modules saw nothing to abort.
 *
 * So new interfaces get no IPv6, the burst always ends with its bridge
 * removed, the network is left to settle before the caller reloads, and the
 * module responses are held until the caller releases them, so the first load
 * always has requests in flight while the burst runs.
 *
 * Rarely (3 of 29 Electron runs on a loaded beelink2, 2026-11-10) a whole
 * burst aborted none of the held load's queued modules. `churnLoadUntilAborted`
 * then starts the load over and churns again, and the fixtures report how
 * many bursts it took. The recovery being measured starts only after a real
 * abort, so this cannot change the reload count the qualification asserts.
 */

/** Time for Chromium to read the burst's last interface event before a reload. */
export const NETWORK_SETTLE_MS = 2_000;
const CHURN_INTERFACE = "churn-test";

const runIp = (...args: string[]): void => {
  execFileSync("ip", args, { stdio: "pipe" });
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Refuses to touch an interface unless this process is in a namespace other
 * than `parentNamespace` (the parent's `/proc/self/ns/net` link), then brings
 * up loopback and turns IPv6 off for interfaces created from now on.
 */
export function enterPrivateNetwork(parentNamespace: string | undefined): void {
  if (!parentNamespace || readlinkSync("/proc/self/ns/net") === parentNamespace) {
    throw new Error("Startup qualification requires a private network namespace");
  }
  runIp("link", "set", "lo", "up");
  // Per namespace; absent when the kernel has no IPv6, and then nothing is late.
  const defaultIpv6 = "/proc/sys/net/ipv6/conf/default/disable_ipv6";
  if (existsSync(defaultIpv6)) writeFileSync(defaultIpv6, "1");
}

export interface ModuleFanOutServer {
  readonly url: URL;
  /** Module requests received so far, from every load. */
  moduleRequests(): number;
  /** Resolves when the first module request arrives. */
  readonly started: Promise<void>;
  /** Resolves when the next module request from now arrives. */
  nextModuleRequest(): Promise<void>;
  /** Answers every held module request and every later one at once. */
  release(): void;
  stop(): Promise<void>;
}

/**
 * Serves a page that imports 1,000 modules, logs a rejected import and shows
 * the startup failure text, as renderer-entry does, or sets `title` once
 * every import resolved. Module responses wait for `release()`. Plain
 * `node:http`, so the unit test's DOM globals cannot stand in for the
 * server's `Response`.
 */
export async function serveModuleFanOut(title: string): Promise<ModuleFanOutServer> {
  let moduleRequests = 0;
  let moduleStarted!: () => void;
  const started = new Promise<void>((resolve) => (moduleStarted = resolve));
  let waiters: Array<() => void> = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const page = `<title>Starting</title><script type="module">
        Promise.all(Array.from({length: 1000}, (_, i) => import('/entry.js?i=' + i)))
        .then(() => { document.title = ${JSON.stringify(title)}; }).catch(error => {
          console.error(error.message);
          document.body.textContent = ${JSON.stringify(STARTUP_FAILED_TEXT)};
        });
      </script><body></body>`;
  const server = http.createServer((request, response) => {
    if ((request.url ?? "").split("?")[0] === "/entry.js") {
      moduleRequests += 1;
      moduleStarted();
      for (const resolve of waiters) resolve();
      waiters = [];
      void released.then(() => {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end("export const ready = true");
      });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/`),
    moduleRequests: () => moduleRequests,
    started,
    nextModuleRequest: () => new Promise<void>((resolve) => waiters.push(resolve)),
    release,
    stop: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Adds and removes a bridge until `aborted()` reports a network-change abort
 * or `maxChanges` interface changes have been made, always leaving the bridge
 * removed, then waits `settleMs` so no event of the burst is still to come.
 * Resolves with the number of changes made, the final removal included.
 * `ip` and `pause` are replaceable for the unit test.
 */
export async function churnNetworkUntil(
  aborted: () => boolean,
  {
    maxChanges = 200,
    intervalMs = 50,
    settleMs = NETWORK_SETTLE_MS,
    ip = runIp,
    pause = sleep,
  }: {
    maxChanges?: number;
    intervalMs?: number;
    settleMs?: number;
    ip?: (...args: string[]) => void;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  let changes = 0;
  let present = false;
  try {
    while (changes < maxChanges && !aborted()) {
      if (present) {
        ip("link", "del", CHURN_INTERFACE);
        present = false;
      } else {
        ip("link", "add", CHURN_INTERFACE, "type", "bridge");
        // Set before configuring it, so a failed step still removes it below.
        present = true;
        ip("addr", "add", "192.0.3.1/24", "dev", CHURN_INTERFACE);
        ip("link", "set", CHURN_INTERFACE, "up");
      }
      changes += 1;
      await pause(intervalMs);
    }
  } finally {
    if (present) {
      ip("link", "del", CHURN_INTERFACE);
      changes += 1;
    }
  }
  await pause(settleMs);
  return changes;
}

export const DEFAULT_CHURN_BURSTS = 3;

/**
 * Bursts of churn (above) until `aborted()` reports a network-change abort,
 * calling `restartLoad` between bursts that saw none, at most `bursts` times.
 * Resolves with the bursts run and the interface changes made in all of them.
 */
export async function churnLoadUntilAborted(
  aborted: () => boolean,
  restartLoad: () => Promise<void>,
  {
    bursts = DEFAULT_CHURN_BURSTS,
    maxChanges = 60,
    ...churn
  }: Parameters<typeof churnNetworkUntil>[1] & { bursts?: number } = {},
): Promise<{ bursts: number; interfaceChanges: number }> {
  let interfaceChanges = 0;
  for (let burst = 1; ; burst += 1) {
    interfaceChanges += await churnNetworkUntil(aborted, { ...churn, maxChanges });
    if (aborted() || burst >= bursts) return { bursts: burst, interfaceChanges };
    await restartLoad();
  }
}
