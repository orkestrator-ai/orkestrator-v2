/**
 * Real-Docker qualification of the egress gateway under the three conditions
 * the other live suites never create (0018 task 3): IPv6 on the environment
 * network, DNS answers that rotate, and a restart of the Docker daemon.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * - IPv6: the environment network exactly as the backend creates it. A daemon
 *   whose `default-network-opts` enable IPv6 gives that network IPv6 itself.
 *   On any other daemon, ORKESTRATOR_LIVE_IPV6_NETWORK=1 lets the test attach
 *   an IPv6 network of its own to the gateway instead. Creating an IPv6
 *   network can switch on the host's IPv6 forwarding, so it is never done
 *   without that opt-in.
 * - DNS rotation: a resolver the test runs inside the gateway answers the
 *   allowed name with local peers' addresses, which the test rotates.
 * - Daemon restart: only with ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND, a shell
 *   command that restarts the daemon this suite talks to and returns once it
 *   answers again. A restart stops every container on that daemon, so point
 *   it only at a disposable one (DOCKER_HOST selects it).
 * Every resource is labelled with this run's private owner namespace and
 * removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { networkOwnerContainer } from "../src/core/container-network-owner";
import { prepareEgressGatewayForStart, stopRuntimeContainer } from "../src/core/egress-gateway";
import type { Environment } from "../src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { removeLabelledResources } from "./container-live-cleanup";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const IPV6_NETWORK = process.env.ORKESTRATOR_LIVE_IPV6_NETWORK === "1";
const RESTART_COMMAND = process.env.ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND?.trim() ?? "";
const live = ENABLED ? test : test.skip;
const liveRestart = ENABLED && RESTART_COMMAND ? test : test.skip;
const RUN = `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 600_000;

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function dockerStatus(args: string[], timeoutMs = 60_000): Promise<number> {
  try {
    await runCommand("docker", args, { timeoutMs });
    return 0;
  } catch {
    return 1;
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-egress-conditions-"));
  owner = dockerOwnerNamespace(dataDir);
});

/**
 * Container processes recorded before a rootless live-restore daemon restart
 * that the restart case has not reaped yet. The new daemon does not know them,
 * so removing the labelled resources would leave them running; afterAll reaps
 * them first when the case failed between the restart and its own reap.
 */
const unreapedOrphans: ContainerProcess[][] = [];

afterAll(async () => {
  if (!ENABLED) return;
  // A reap failure is reported after the resources are removed, so it neither
  // skips that cleanup nor replaces the case's own failure.
  let reapError: unknown = null;
  for (const recorded of unreapedOrphans.splice(0)) {
    await reapOrphanedContainers(recorded).catch((error: unknown) => {
      reapError ??= error;
    });
  }
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
  if (reapError) throw reapError;
}, 180_000);

function conditionsContext(environments: Environment[]) {
  const fixture = memoryLifecycleContext(environments, dataDir);
  Object.assign(fixture.context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      gitUrl: "https://example.invalid/none.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains: ["registry.npmjs.org"], enabledAgentPlatforms: [] },
      repositories: {},
    }),
  });
  return fixture;
}

/** Creates a restricted runtime through the backend; returns it and its namespace owner. */
async function createRestricted(
  id: string,
  allowedDomains: string[],
): Promise<{
  containerId: string;
  gateway: string;
  context: ReturnType<typeof conditionsContext>["context"];
}> {
  const { createDockerContainer } = await import("../src/core/commands-containers");
  const { resolveDockerImage } = await import("../src/core/docker-image");
  const environment = lifecycleEnvironment({ id: `${id}-${RUN}`, allowedDomains });
  const { context } = conditionsContext([environment]);
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("qualification image missing");
  const containerId = await createDockerContainer(environment, context, {
    imageId: resolved.imageId,
  });
  await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
  const gateway = await networkOwnerContainer(containerId);
  // Every condition here is about the gateway topology.
  expect(gateway).not.toBe(containerId);
  return { containerId, gateway, context };
}

async function booted(containerId: string): Promise<void> {
  try {
    await waitForContainerBoot(containerId);
  } catch (error) {
    const logs = await docker(["logs", "--tail", "40", containerId]).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
}

/** The backend's start path: the gateway, its firewall, then the runtime. */
async function startRuntime(containerId: string): Promise<void> {
  await prepareEgressGatewayForStart(containerId);
  await docker(["start", containerId]);
  await booted(containerId);
}

async function running(containerId: string): Promise<boolean> {
  return (await docker(["inspect", "-f", "{{.State.Running}}", containerId])) === "true";
}

// A local peer answers TCP and UDP on these ports, so a failed probe shows
// filtering rather than an absent service. Listening on `::` takes IPv4 and,
// where the peer has it, IPv6.
const ECHO_PEER = `
const net = require("node:net");
const dgram = require("node:dgram");
for (const port of [18080, 18081]) {
  net.createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", data => socket.write(data));
  }).listen(port, "::");
  const udp = dgram.createSocket("udp4");
  udp.on("message", (data, peer) => udp.send(data, peer.port, peer.address));
  udp.bind(port, "0.0.0.0");
}
`;

async function startPeer(network: string): Promise<string> {
  const peer = await docker([
    "run",
    "-d",
    "--label",
    `orkestrator-owner=${owner}`,
    "--network",
    network,
    "--entrypoint",
    "node",
    IMAGE,
    "-e",
    ECHO_PEER,
  ]);
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await tcpProbe(peer, "127.0.0.1", 18080, "root")) === 0) return peer;
    await Bun.sleep(100);
  }
  throw new Error("echo peer never listened");
}

async function peerAddress(peer: string, family: 4 | 6, network: string): Promise<string> {
  const field = family === 4 ? "IPAddress" : "GlobalIPv6Address";
  return docker([
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${network}").${field}}}`,
    peer,
  ]);
}

/**
 * 0 when a TCP echo through `address:port` answered, 1 otherwise. Every first
 * write is a whole line: the gateway's name checks (`egress-filter=1`) hold a
 * partial printable line, which could still be an HTTP request, until its
 * newline arrives, so a bare word would never reach the peer.
 */
async function tcpProbe(
  containerId: string,
  address: string,
  port: number,
  user = "node",
): Promise<number> {
  const script = `
    const socket = require("node:net").connect({ host: ${JSON.stringify(address)}, port: ${port} });
    socket.on("connect", () => socket.write("probe\\n"));
    socket.on("data", data => process.exit(data.toString() === "probe\\n" ? 0 : 2));
    socket.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  `;
  return dockerStatus(["exec", "-u", user, containerId, "node", "-e", script]);
}

/**
 * Opens one TCP connection to `address:port` as node and answers its first
 * echo; touching `/tmp/<tag>.go` sends a second message on the same socket,
 * whose fate lands in `/tmp/<tag>.second`.
 */
async function heldConnection(
  containerId: string,
  address: string,
  port: number,
  tag: string,
): Promise<void> {
  const script = `
    const fs = require("node:fs");
    const socket = require("node:net").connect({ host: ${JSON.stringify(address)}, port: ${port} });
    let first = true;
    const finish = result => { fs.writeFileSync("/tmp/${tag}.second", result); process.exit(0); };
    socket.on("error", () => finish("closed"));
    socket.on("connect", () => socket.write("first\\n"));
    socket.on("data", data => {
      if (first) { first = false; fs.writeFileSync("/tmp/${tag}.first", data); }
      else finish(data.toString());
    });
    const poll = setInterval(() => {
      if (!fs.existsSync("/tmp/${tag}.go")) return;
      clearInterval(poll);
      socket.write("second\\n");
      setTimeout(() => finish("timeout"), 3000);
    }, 50);
    setTimeout(() => finish("expired"), 120000);
  `;
  await docker(["exec", "-d", "-u", "node", containerId, "node", "-e", script]);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      (await docker(["exec", containerId, "cat", `/tmp/${tag}.first`]).catch(() => "")) === "first"
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error(`held connection ${tag} never answered`);
}

async function secondMessage(containerId: string, tag: string): Promise<string> {
  await docker(["exec", "-u", "node", containerId, "touch", `/tmp/${tag}.go`]);
  for (let attempt = 0; attempt < 60; attempt++) {
    const second = await docker(["exec", containerId, "cat", `/tmp/${tag}.second`]).catch(() => "");
    if (second) return second;
    await Bun.sleep(100);
  }
  return "no-result";
}

async function inGateway(gateway: string, ...args: string[]): Promise<string> {
  return docker(["exec", "-u", "root", gateway, ...args]);
}

/** An allowed-domains member's remaining kernel timeout in seconds; null when absent. */
async function memberTimeout(gateway: string, entry: string): Promise<number | null> {
  const list = await inGateway(gateway, "ipset", "list", "allowed-domains");
  const line = list.split("\n").find((candidate) => candidate.startsWith(`${entry} `));
  const timeout = line?.match(/ timeout (\d+)/)?.[1];
  return timeout === undefined ? null : Number(timeout);
}

describe("IPv6 on the environment network", () => {
  live(
    "the gateway and its runtime get no IPv6 address and cannot reach an IPv6 peer",
    async () => {
      const { containerId, gateway, context } = await createRestricted("ipv6", [
        "registry.npmjs.org",
      ]);
      const { environmentNetworkName, environmentNetworkPolicy } =
        await import("../src/core/container-network");
      let network = environmentNetworkName(owner, `ipv6-${RUN}`);
      const daemonIpv6 = await docker(["network", "inspect", "-f", "{{.EnableIPv6}}", network]);
      if (daemonIpv6 !== "true") {
        if (!IPV6_NETWORK) {
          console.warn(
            "IPv6 not covered: this daemon creates environment networks without IPv6 and ORKESTRATOR_LIVE_IPV6_NETWORK is not 1.",
          );
          return;
        }
        // A unique local /64 per run; attached before the gateway's first start,
        // as a daemon default would have given it.
        const hex = () => Math.floor(Math.random() * 0x10000).toString(16);
        network = `ork-${owner}-${RUN}-v6`;
        await docker([
          "network",
          "create",
          "--label",
          `orkestrator-owner=${owner}`,
          "--ipv6",
          "--subnet",
          `fd18:${hex()}:${hex()}:${hex()}::/64`,
          network,
        ]);
        await docker(["network", "connect", network, gateway]);
      }
      const peer = await startPeer(network);
      const peer6 = await peerAddress(peer, 6, network);
      expect(peer6).toContain(":");
      // Positive control: IPv6 works on this network for a container without
      // the gateway's sysctl.
      const control = await docker([
        "run",
        "-d",
        "--label",
        `orkestrator-owner=${owner}`,
        "--network",
        network,
        "--entrypoint",
        "sleep",
        IMAGE,
        "600",
      ]);
      expect(await tcpProbe(control, peer6, 18080, "root")).toBe(0);

      await startRuntime(containerId);
      const policy = await environmentNetworkPolicy(`ipv6-${RUN}`, context);
      expect(policy.effective).toMatchObject({ mode: "restricted", state: "applied" });
      expect(["blocked", "disabled"]).toContain(policy.effective!.ipv6!);
      for (const container of [gateway, containerId]) {
        // No IPv6 address on any interface, loopback included, and IPv6 off
        // on every interface, including one Docker attached after creation.
        expect(await docker(["exec", container, "cat", "/proc/net/if_inet6"])).toBe("");
        const switches = await docker([
          "exec",
          container,
          "sh",
          "-c",
          "cat /proc/sys/net/ipv6/conf/*/disable_ipv6 | sort -u",
        ]);
        expect(switches).toBe("1");
      }
      for (const user of ["node", "root"]) {
        expect(await tcpProbe(containerId, peer6, 18080, user)).toBe(1);
      }
      if (policy.effective!.ipv6 === "blocked") {
        const rules = await inGateway(gateway, "ip6tables", "-S");
        expect(rules).toContain("-P OUTPUT DROP");
      }
      // The gateway refuses the start and stays closed if IPv6 ever appears
      // without ip6tables; that is init-firewall.sh's own check.
    },
    LIVE_TIMEOUT_MS,
  );
});

// A resolver that answers `rotate.test` from /tmp/rotate-answers ("address
// ttl" lines) and relays every other name to the gateway's own resolver.
const ROTATING_DNS = `
const fs = require("node:fs"), dgram = require("node:dgram");
const upstream = fs.readFileSync("/tmp/rotate-upstream", "utf8").trim();
const server = dgram.createSocket("udp4");
server.on("message", (query, remote) => {
  let end = 12;
  const labels = [];
  while (query[end]) { labels.push(query.subarray(end + 1, end + 1 + query[end]).toString()); end += query[end] + 1; }
  const qtype = query.readUInt16BE(end + 1);
  end += 5;
  const name = labels.join(".").toLowerCase();
  if (name !== "rotate.test") {
    const relay = dgram.createSocket("udp4");
    relay.on("message", answer => { server.send(answer, remote.port, remote.address); relay.close(); });
    relay.send(query, 53, upstream);
    setTimeout(() => { try { relay.close(); } catch {} }, 5000);
    return;
  }
  fs.appendFileSync("/tmp/rotate-queries", name + "\\n");
  const records = qtype !== 1 ? [] : fs.readFileSync("/tmp/rotate-answers", "utf8")
    .split("\\n").filter(Boolean).map(line => line.split(" "));
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8580, 2);
  header.writeUInt16BE(records.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const answers = records.map(([address, ttl]) => {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(1, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(Number(ttl), 6);
    record.writeUInt16BE(4, 10);
    address.split(".").forEach((octet, index) => { record[12 + index] = Number(octet); });
    return record;
  });
  server.send(Buffer.concat([header, query.subarray(12, end), ...answers]), remote.port, remote.address);
});
server.bind(53, "127.0.0.1", () => fs.writeFileSync("/tmp/rotate-dns-ready", "ready"));
`;

// Probes an unlisted and a carried address every 50 ms until /tmp/watch.stop
// exists; /tmp/watch.json counts any opening of the first and any refusal of
// the second.
function watcher(unlisted: string, carried: string): string {
  return `
const fs = require("node:fs"), net = require("node:net");
const counts = { rounds: 0, unlistedOpen: 0, carriedRefused: 0 };
const attempt = address => new Promise(resolve => {
  const socket = net.connect({ host: address, port: 18080 });
  const done = ok => { socket.destroy(); resolve(ok); };
  socket.on("connect", () => done(true));
  socket.on("error", () => done(false));
  setTimeout(() => done(false), 1000);
});
(async () => {
  while (!fs.existsSync("/tmp/watch.stop")) {
    if (await attempt(${JSON.stringify(unlisted)})) counts.unlistedOpen++;
    if (!(await attempt(${JSON.stringify(carried)}))) counts.carriedRefused++;
    counts.rounds++;
    fs.writeFileSync("/tmp/watch.json", JSON.stringify(counts));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fs.writeFileSync("/tmp/watch.done", "done");
})();
`;
}

describe("DNS rotation", () => {
  live(
    "rotated addresses are added, carried ones stay open until they expire, and nothing unlisted ever opens",
    async () => {
      const { containerId, gateway } = await createRestricted("dns", ["rotate.test:18080"]);
      const network = await docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", gateway]);
      const peers = [await startPeer(network), await startPeer(network), await startPeer(network)];
      const [first, second, unlisted] = await Promise.all(
        peers.map((peer) => peerAddress(peer, 4, network)),
      );
      await startRuntime(containerId);
      const tuple = (address: string) => `${address},tcp:18080`;

      // Point the gateway's trusted resolver at the controlled one, root-only
      // and inside the gateway, as a real upstream change would look to it.
      const trusted = "/etc/orkestrator/trusted-network/resolv.conf";
      await inGateway(
        gateway,
        "sh",
        "-ec",
        `awk '$1 == "nameserver" { print $2; exit }' ${trusted} > /tmp/rotate-upstream; cp ${trusted} /tmp/resolv.trusted.before; printf '%s 30\\n' ${first} > /tmp/rotate-answers`,
      );
      // By absolute path: root execs in the gateway get a fixed PATH without
      // /usr/local/bin (security H2), where the image's node lives.
      await docker([
        "exec",
        "-d",
        "-u",
        "root",
        gateway,
        "/usr/local/bin/node",
        "-e",
        ROTATING_DNS,
      ]);
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await dockerStatus(["exec", gateway, "test", "-f", "/tmp/rotate-dns-ready"])) === 0)
          break;
        await Bun.sleep(100);
      }
      await inGateway(gateway, "sh", "-ec", `printf 'nameserver 127.0.0.1\\n' > ${trusted}`);
      const refresh = () => inGateway(gateway, "/usr/local/bin/update-firewall.sh", "--refresh");
      try {
        // 1. The first answer: allowed with the full six-hour lifetime, and
        //    the next refresh follows the TTL within its 300 s floor.
        await refresh();
        expect(await memberTimeout(gateway, tuple(first!))).toBeGreaterThan(21_500);
        expect(await inGateway(gateway, "cat", "/run/orkestrator-firewall/refresh-delay")).toBe(
          "300",
        );
        expect(await tcpProbe(containerId, first!, 18080)).toBe(0);
        expect(await tcpProbe(containerId, second!, 18080)).toBe(1);
        expect(await tcpProbe(containerId, unlisted!, 18080)).toBe(1);
        // Another port on an allowed address stays closed.
        expect(await tcpProbe(containerId, first!, 18081)).toBe(1);

        // 2. The answer rotates while a connection to the first address is
        //    open and a watcher probes throughout several swaps.
        await heldConnection(containerId, first!, 18080, "rotated");
        await docker([
          "exec",
          "-d",
          "-u",
          "node",
          containerId,
          "node",
          "-e",
          watcher(unlisted!, first!),
        ]);
        await inGateway(
          gateway,
          "sh",
          "-ec",
          `printf '%s 4000\\n' ${second} > /tmp/rotate-answers`,
        );
        for (let swap = 0; swap < 5; swap++) await refresh();
        await docker(["exec", "-u", "node", containerId, "touch", "/tmp/watch.stop"]);
        for (let attempt = 0; attempt < 50; attempt++) {
          if ((await dockerStatus(["exec", containerId, "test", "-f", "/tmp/watch.done"])) === 0)
            break;
          await Bun.sleep(100);
        }
        const counts = JSON.parse(await docker(["exec", containerId, "cat", "/tmp/watch.json"]));
        expect(counts.rounds).toBeGreaterThan(5);
        expect(counts.unlistedOpen).toBe(0);
        expect(counts.carriedRefused).toBe(0);
        // The new address has its own six hours; the old one keeps the rest of
        // its own, and its open connection was not revoked.
        expect(await memberTimeout(gateway, tuple(second!))).toBeGreaterThan(21_500);
        const carried = await memberTimeout(gateway, tuple(first!));
        expect(carried).not.toBeNull();
        expect(carried!).toBeLessThanOrEqual(21_600);
        expect(await secondMessage(containerId, "rotated")).toBe("second");
        expect(await tcpProbe(containerId, second!, 18080)).toBe(0);
        expect(await tcpProbe(containerId, first!, 18080)).toBe(0);
        expect(await tcpProbe(containerId, unlisted!, 18080)).toBe(1);
        // A long TTL is capped at the 1800 s ceiling.
        expect(await inGateway(gateway, "cat", "/run/orkestrator-firewall/refresh-delay")).toBe(
          "1800",
        );

        // 3. Age-out. Six hours pass for the first address: its recorded
        //    expiry is moved to a few seconds from now, and one refresh
        //    carries it with only that long left.
        await heldConnection(containerId, first!, 18080, "expiring");
        await inGateway(
          gateway,
          "sh",
          "-ec",
          `record=/var/lib/orkestrator/domain-addresses; soon=$(($(date +%s) + 4)); awk -v a=${first} -v t="$soon" '$2 == a { $3 = t } { print }' "$record" > "$record.edit"; mv -f "$record.edit" "$record"`,
        );
        await refresh();
        const left = await memberTimeout(gateway, tuple(first!));
        expect(left).not.toBeNull();
        expect(left!).toBeLessThanOrEqual(4);
        await Bun.sleep(6_000);
        // The kernel dropped it on time, with no refresh running.
        expect(await memberTimeout(gateway, tuple(first!))).toBeNull();
        expect(await tcpProbe(containerId, first!, 18080)).toBe(1);
        // The next refresh revokes the connection that outlived the address.
        await refresh();
        expect(await secondMessage(containerId, "expiring")).not.toBe("second");
        expect(
          await inGateway(gateway, "cat", "/var/lib/orkestrator/domain-addresses"),
        ).not.toContain(` ${first} `);
        expect(await tcpProbe(containerId, second!, 18080)).toBe(0);
      } finally {
        await inGateway(gateway, "sh", "-ec", `cat /tmp/resolv.trusted.before > ${trusted}`).catch(
          () => "",
        );
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

/** Runs the restart command, then waits until the daemon answers again. */
async function restartDaemon(): Promise<void> {
  await runCommand("sh", ["-c", RESTART_COMMAND], { timeoutMs: 180_000 });
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await dockerStatus(["info", "--format", "{{.ID}}"], 10_000)) === 0) return;
    await Bun.sleep(500);
  }
  throw new Error("the daemon did not answer after its restart");
}

type ContainerProcess = { containerId: string; fullId: string; pid: number; startTime: string };

/** Start time (field 22 of `/proc/<pid>/stat`) of a host process; null once it is gone. */
async function processStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Each running container's init process, as the host sees it (rootless dockerd shares its pid namespace). */
async function containerProcesses(ids: string[]): Promise<ContainerProcess[]> {
  const found: ContainerProcess[] = [];
  for (const containerId of ids) {
    const [fullId = "", pidText = ""] = (
      await docker(["inspect", "-f", "{{.Id}} {{.State.Pid}}", containerId])
    ).split(" ");
    const pid = Number(pidText);
    const startTime = pid > 0 ? await processStartTime(pid) : null;
    if (fullId && startTime) found.push({ containerId, fullId, pid, startTime });
  }
  return found;
}

/**
 * Prints one observation and, when ORKESTRATOR_QUALIFICATION_EVIDENCE names a
 * file, appends it there as a JSON line (a logged run deletes passing output).
 * Observations carry no workspace contents.
 */
async function evidence(scenario: string, fields: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ run: RUN, scenario, at: new Date().toISOString(), ...fields });
  console.info(`[egress-conditions] ${line}`);
  const file = process.env.ORKESTRATOR_QUALIFICATION_EVIDENCE;
  if (file) await fs.appendFile(file, `${line}\n`);
}

/** How many host processes share `pid`'s pid namespace (a container's whole tree). */
async function processesInNamespaceOf(pid: number): Promise<number> {
  const target = await fs.readlink(`/proc/${pid}/ns/pid`).catch(() => null);
  if (!target) return 0;
  let count = 0;
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    if ((await fs.readlink(`/proc/${entry}/ns/pid`).catch(() => null)) === target) count++;
  }
  return count;
}

/**
 * Whether an orphaned gateway's network namespace still reaches the allowed
 * registry: curl in that namespace (entered through the user namespace this
 * user owns) with the address resolved on the host. Null when the namespace
 * cannot be entered, so it stays an observation rather than an assertion.
 */
async function orphanReachesRegistry(pid: number): Promise<number | null> {
  const address = (
    await runCommand("getent", ["ahostsv4", "registry.npmjs.org"]).catch(() => null)
  )?.stdout.split(/\s+/)[0];
  if (!address) return null;
  try {
    const result = await runCommand(
      "sh",
      [
        "-c",
        `nsenter --preserve-credentials -U -n -t ${pid} curl -sS -o /dev/null --max-time 8 --resolve registry.npmjs.org:443:${address} https://registry.npmjs.org/ 2>/dev/null; echo $?`,
      ],
      { timeoutMs: 20_000 },
    );
    return Number(result.stdout.trim().split("\n").at(-1));
  } catch {
    return null;
  }
}

/**
 * Kills the container processes that outlived a rootless daemon restart the
 * daemon no longer knows about. Each is signalled only while its start time
 * and its cgroup (which names the full container id) still match what was
 * recorded before the restart. Killing a container's init ends its whole pid
 * namespace. Returns the containers whose processes had survived.
 */
async function reapOrphanedContainers(recorded: ContainerProcess[]): Promise<string[]> {
  const orphaned: string[] = [];
  for (const entry of recorded) {
    if ((await processStartTime(entry.pid)) !== entry.startTime) continue;
    const cgroup = await fs.readFile(`/proc/${entry.pid}/cgroup`, "utf8").catch(() => "");
    if (!cgroup.includes(entry.fullId)) continue;
    orphaned.push(entry.containerId);
    process.kill(entry.pid, "SIGKILL");
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const left = await Promise.all(
      recorded.map(async (entry) => (await processStartTime(entry.pid)) === entry.startTime),
    );
    if (!left.some(Boolean)) return orphaned;
    await Bun.sleep(200);
  }
  throw new Error("orphaned container processes did not exit after SIGKILL");
}

async function assertEnforced(containerId: string, gateway: string): Promise<void> {
  expect(
    await docker(["exec", containerId, "awk", "/^CapEff/ { print $2 }", "/proc/self/status"]),
  ).toBe("0000000000000000");
  const report = JSON.parse(
    await inGateway(gateway, "cat", "/run/orkestrator-firewall/firewall.json"),
  );
  expect(report).toMatchObject({ mode: "restricted", state: "applied" });
  const rules = await inGateway(gateway, "iptables", "-S", "OUTPUT");
  expect(rules).toContain("-P OUTPUT DROP");
  expect(rules).toContain("-j REJECT --reject-with icmp-admin-prohibited");
  expect(
    await docker(["exec", containerId, "cat", "/proc/sys/net/ipv6/conf/all/disable_ipv6"]),
  ).toBe("1");
  // The allowed registry answers (DNS through the daemon's resolver works);
  // an address off the list is rejected at once.
  const curl = async (url: string) =>
    Number(
      (
        await docker([
          "exec",
          "-u",
          "node",
          containerId,
          "sh",
          "-c",
          `curl -sS -o /dev/null --max-time 8 ${url} 2>/dev/null; echo $?`,
        ])
      )
        .split("\n")
        .at(-1),
    );
  expect(await curl("https://registry.npmjs.org/")).toBe(0);
  // Refused at the connection (7), or already at DNS (6) by a gateway whose
  // image checks names.
  expect([6, 7]).toContain(await curl("https://example.com/"));
}

describe("Docker daemon restart", () => {
  liveRestart(
    "stopped and running gateway runtimes restart in order with their policy, and never start on their own",
    async () => {
      const liveRestore =
        (await docker(["info", "--format", "{{.LiveRestoreEnabled}}"])) === "true";
      const rootless = (await docker(["info", "--format", "{{json .SecurityOptions}}"])).includes(
        "name=rootless",
      );
      const { containerId, gateway } = await createRestricted("restart", ["registry.npmjs.org"]);
      await startRuntime(containerId);
      await assertEnforced(containerId, gateway);

      // 1. Stopped through the backend, then the daemon restarts.
      await stopRuntimeContainer(containerId);
      await restartDaemon();
      expect(await running(gateway)).toBe(false);
      expect(await running(containerId)).toBe(false);
      // Docker refuses the runtime while its gateway is stopped.
      expect(await dockerStatus(["start", containerId])).toBe(1);
      expect(await running(containerId)).toBe(false);
      await startRuntime(containerId);
      await assertEnforced(containerId, gateway);

      // 2. Running when the daemon restarts.
      const gatewayStarted = await docker(["inspect", "-f", "{{.State.StartedAt}}", gateway]);
      const before = await containerProcesses([gateway, containerId]);
      // Registered before the restart: a rootless restart can orphan these
      // processes even when the restart command itself then fails.
      if (liveRestore && rootless) unreapedOrphans.push(before);
      await restartDaemon();
      if (liveRestore && rootless) {
        // A rootless restart replaces RootlessKit, its user and network
        // namespaces, containerd and the shims (to-do 7390 task 1,
        // 2026-11-11). The new daemon finds no shim and reports both
        // containers exited, while their processes can outlive it in the old
        // namespace with nothing but loopback. Those are reaped before the
        // backend starts the containers again, as a daemon with live-restore
        // off would have left them.
        expect(await running(gateway)).toBe(false);
        expect(await running(containerId)).toBe(false);
        const survivors = [];
        for (const entry of before) {
          const alive = (await processStartTime(entry.pid)) === entry.startTime;
          survivors.push({
            role: entry.containerId === gateway ? "gateway" : "runtime",
            alive,
            processes: alive ? await processesInNamespaceOf(entry.pid) : 0,
            registryExit:
              alive && entry.containerId === gateway
                ? await orphanReachesRegistry(entry.pid)
                : null,
          });
        }
        const orphaned = await reapOrphanedContainers(before);
        unreapedOrphans.splice(unreapedOrphans.indexOf(before), 1);
        await evidence("rootless-live-restore-restart", {
          containers: before.length,
          orphaned: orphaned.length,
          survivors,
          daemonState: { gateway: "exited", runtime: "exited" },
        });
        expect(await dockerStatus(["start", containerId])).toBe(1);
        await startRuntime(containerId);
        await assertEnforced(containerId, gateway);
      } else if (liveRestore) {
        // Both kept running in the same namespace; the rules, the resolver
        // and the refresher survived the daemon.
        expect(await running(gateway)).toBe(true);
        expect(await running(containerId)).toBe(true);
        expect(await docker(["inspect", "-f", "{{.State.StartedAt}}", gateway])).toBe(
          gatewayStarted,
        );
        await assertEnforced(containerId, gateway);
        await inGateway(gateway, "/usr/local/bin/update-firewall.sh", "--refresh");
        await assertEnforced(containerId, gateway);
        expect(await prepareEgressGatewayForStart(containerId)).toBe("ready");
      } else {
        // No restart policy: Docker started neither again.
        expect(await running(gateway)).toBe(false);
        expect(await running(containerId)).toBe(false);
        expect(await dockerStatus(["start", containerId])).toBe(1);
        await startRuntime(containerId);
        await assertEnforced(containerId, gateway);
      }
      await evidence("daemon-restart", {
        liveRestore,
        rootless,
        branch: liveRestore ? (rootless ? "rootless-live-restore" : "live-restore") : "stopped",
        passed: true,
      });
    },
    LIVE_TIMEOUT_MS,
  );
});
