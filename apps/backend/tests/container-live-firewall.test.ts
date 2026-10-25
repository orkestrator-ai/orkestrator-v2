/**
 * Real-Docker qualification for allowlist edits, refresh and revocation
 * (plan step 09, scenario C23).
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * Needs outbound access to api.github.com, registry.npmjs.org and example.com.
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
import { getHostPort } from "../src/core/commands-container-exec";
import { prepareEgressGatewayForStart, stopRuntimeContainer } from "../src/core/egress-gateway";
import type { Environment } from "../src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-firewall-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const ids = (await docker(["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  const networks = (
    await docker(["network", "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`])
  )
    .split("\n")
    .filter(Boolean);
  if (networks.length > 0) await docker(["network", "rm", ...networks]).catch(() => undefined);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  // Removing containers takes several seconds on a loaded host; the default
  // hook timeout would abandon the cleanup part-way and leak the networks.
}, 180_000);

function firewallContext(environments: Environment[]) {
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

async function probe(containerId: string, url: string): Promise<number> {
  const out = await docker([
    "exec",
    "-u",
    "node",
    containerId,
    "sh",
    "-c",
    `curl -fsS -o /dev/null --max-time 6 ${url} 2>/dev/null; echo $?`,
  ]);
  return Number(out.split("\n").at(-1));
}

/**
 * Opens one keep-alive HTTP connection to example.com as node, answers a
 * first request, then waits for `/tmp/<tag>.go` and sends a second request on
 * the same socket. `/tmp/<tag>.second` records what happened.
 */
async function openHeldConnection(containerId: string, tag: string): Promise<void> {
  const script = [
    "exec 3<>/dev/tcp/example.com/80 || exit 1",
    "request() { printf 'HEAD / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: keep-alive\\r\\n\\r\\n' >&3; }",
    "headers() { status=''; while IFS= read -r -t 5 line <&3; do [ -z \"$status\" ] && status=\"$line\"; [ \"$line\" = $'\\r' ] && break; done; printf '%s' \"${status%$'\\r'}\"; }",
    "request",
    `headers > /tmp/${tag}.first`,
    `while [ ! -e /tmp/${tag}.go ]; do sleep 0.1; done`,
    `if ! request 2>/dev/null; then echo write-failed > /tmp/${tag}.second; exit 0; fi`,
    `answer=$(headers); echo "\${answer:-no-answer}" > /tmp/${tag}.second`,
  ].join("\n");
  await docker(["exec", "-d", "-u", "node", containerId, "bash", "-c", script]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const first = await docker(["exec", containerId, "cat", `/tmp/${tag}.first`]).catch(() => "");
    if (first) {
      expect(first).toStartWith("HTTP/1.1 ");
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("the held connection never answered its first request");
}

async function secondRequest(containerId: string, tag: string): Promise<string> {
  await docker(["exec", "-u", "node", containerId, "touch", `/tmp/${tag}.go`]);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const second = await docker(["exec", containerId, "cat", `/tmp/${tag}.second`]).catch(() => "");
    if (second) return second;
    await Bun.sleep(100);
  }
  return "timeout";
}

/** Waits for a boot; a failed one reports the container's last log lines. */
async function booted(containerId: string): Promise<void> {
  try {
    await waitForContainerBoot(containerId);
  } catch (error) {
    const logs = await docker(["logs", "--tail", "40", containerId]).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
}

/**
 * Starts a runtime the way the backend does: its egress gateway first (when
 * the image has one), then the runtime once the gateway's firewall applied.
 */
async function startRuntime(containerId: string): Promise<void> {
  await prepareEgressGatewayForStart(containerId);
  await docker(["start", containerId]);
  await booted(containerId);
}

async function restartRuntime(containerId: string): Promise<void> {
  await stopRuntimeContainer(containerId);
  await startRuntime(containerId);
}

async function refresherPids(containerId: string): Promise<string[]> {
  const out = await docker([
    "exec",
    // As node: a gateway's default exec user is root, and this probe's own
    // shell is a session leader too.
    "-u",
    "node",
    containerId,
    "sh",
    "-c",
    // The refresher is a root session leader (setsid); its refresh subshells
    // and this probe are not.
    "ps -eo pid=,sid=,uid=,args= | awk '$1 == $2 && $3 == 0 && /update-firewall.sh --refresh-loop/ { print $1 }'",
  ]);
  return out.split("\n").filter(Boolean);
}

describe("C23 allowlist edits, refresh and revocation", () => {
  live(
    "an edit applies in place, revokes removed addresses, survives a restart and never widens on failure",
    async () => {
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const { applyEnvironmentAllowedDomains, environmentNetworkPolicy } =
        await import("../src/core/container-network");
      const environment = lifecycleEnvironment({
        id: `env-${RUN}`,
        networkAccessMode: "restricted",
        allowedDomains: ["registry.npmjs.org"],
      });
      const { context } = firewallContext([environment]);
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
      // The firewall's namespace owner: the egress gateway on a gateway image.
      const firewall = await networkOwnerContainer(containerId);
      await startRuntime(containerId);

      // Booted with the saved list, which it reports by revision.
      let policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("applied");
      expect(policy.effective?.domainsRevision).toBe(policy.configured.domainsRevision);
      expect(policy.effective?.refreshedAt).toBeTruthy();
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);
      // Resolved addresses carry kernel expiry, as HTTPS tuples (policy 3).
      expect(
        await docker(["exec", "--user", "root", firewall, "ipset", "list", "allowed-domains"]),
      ).toMatch(/^\d+\.\d+\.\d+\.\d+,tcp:443 timeout \d+$/m);

      // One root refresher, which node can neither signal nor duplicate. The
      // root entrypoint runs the firewall; node has no sudo grant for it.
      const [refresher] = await refresherPids(firewall);
      expect(refresher).toBeTruthy();
      expect(
        await dockerStatus(["exec", "-u", "node", firewall, "kill", "-TERM", refresher!]),
      ).toBe(1);
      expect(
        await dockerStatus([
          "exec",
          "-u",
          "node",
          containerId,
          "sudo",
          "-n",
          "/usr/local/bin/init-firewall.sh",
        ]),
      ).toBe(1);
      expect(await refresherPids(firewall)).toHaveLength(1);
      // node cannot write the firewall's report or schedule.
      expect(
        await dockerStatus([
          "exec",
          "-u",
          "node",
          firewall,
          "sh",
          "-c",
          "echo 1 > /run/orkestrator-firewall/refresh-delay",
        ]),
      ).toBe(1);

      if (firewall !== containerId) {
        // External enforcement: the runtime holds no capability, so root in it
        // cannot change the gateway's rules, and its boot verified them.
        expect(
          await docker(["exec", containerId, "awk", "/^CapEff/ { print $2 }", "/proc/self/status"]),
        ).toBe("0000000000000000");
        expect(
          await docker(["exec", containerId, "cat", "/run/orkestrator-network/firewall-boot"]),
        ).toBe("gateway");
        for (const tamper of [
          ["iptables", "-P", "OUTPUT", "ACCEPT"],
          ["iptables", "-F"],
          ["ipset", "flush", "allowed-domains"],
        ]) {
          expect(await dockerStatus(["exec", "--user", "orkroot", containerId, ...tamper])).toBe(1);
        }
        expect(await probe(containerId, "https://example.com/")).not.toBe(0);
        expect(await probe(containerId, "https://registry.npmjs.org/")).toBe(0);
        expect((await environmentNetworkPolicy(environment.id, context)).enforcement).toBe(
          "gateway",
        );
        // The runtime's published ports are the gateway's.
        await docker([
          "exec",
          "-d",
          "-u",
          "node",
          containerId,
          "node",
          "-e",
          'require("http").createServer((q, r) => r.end("ok")).listen(4096)',
        ]);
        const hostPort = await getHostPort(containerId, 4096);
        expect(hostPort).toBeGreaterThan(0);
        let answered = "";
        for (let attempt = 0; attempt < 30 && answered !== "ok"; attempt += 1) {
          answered = await fetch(`http://127.0.0.1:${hostPort}/`)
            .then((response) => response.text())
            .catch(() => "");
          if (answered !== "ok") await Bun.sleep(200);
        }
        expect(answered).toBe("ok");

        // A gateway restart leaves the running runtime with only loopback
        // (fail closed); the start path stops it and starts it again once
        // the gateway's new boot applied its firewall.
        await docker(["restart", "-t", "5", firewall]);
        expect(await probe(containerId, "https://registry.npmjs.org/")).not.toBe(0);
        expect(await prepareEgressGatewayForStart(containerId)).toBe("restarted-gateway");
        await docker(["start", containerId]);
        await booted(containerId);
        expect(await probe(containerId, "https://registry.npmjs.org/")).toBe(0);
        expect(await probe(containerId, "https://example.com/")).not.toBe(0);
      }

      // Saved but not yet applied is reported as pending, then applied in
      // place. A bare domain is HTTPS only; port 80 needs its own entry.
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com"],
      });
      policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("pending");
      const applied = await applyEnvironmentAllowedDomains(environment.id, context);
      expect(applied.kind).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).toBe(0);
      expect(await probe(containerId, "http://example.com/")).not.toBe(0);
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com", "example.com:80"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      expect(await probe(containerId, "http://example.com/")).toBe(0);
      expect(await docker(["exec", firewall, "cat", "/etc/orkestrator/allowed-domains"])).toBe(
        "registry.npmjs.org,example.com,example.com:80",
      );

      // Control: an edit that keeps example.com:80 leaves an open connection alone.
      await openHeldConnection(containerId, "kept");
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com", "example.com:80", "bun.sh"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      expect(await secondRequest(containerId, "kept")).toStartWith("HTTP/1.1 ");

      // Removing only example.com:80 revokes the connection already open on
      // that port and leaves HTTPS to the same address allowed.
      await openHeldConnection(containerId, "revoked");
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com"],
      });
      const removed = await applyEnvironmentAllowedDomains(environment.id, context);
      expect(removed.kind).toBe("applied");
      expect(removed.policy.effective?.revocation).toBe("conntrack");
      expect(removed.policy.effective?.revokedEntries ?? 0).toBeGreaterThan(0);
      expect(await secondRequest(containerId, "revoked")).not.toStartWith("HTTP/1.1 ");
      expect(await probe(containerId, "http://example.com/")).not.toBe(0);
      expect(await probe(containerId, "https://example.com/")).toBe(0);

      // Removing example.com closes HTTPS to it as well.
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);

      // A refresh re-resolves in place and keeps the same list.
      await docker([
        "exec",
        "--user",
        "root",
        firewall,
        "/usr/local/bin/update-firewall.sh",
        "--refresh",
      ]);
      policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("applied");
      expect(policy.effective?.refreshFailures).toBe(0);

      // An invalid list is refused and changes nothing.
      expect(
        await dockerStatus([
          "exec",
          "--user",
          "root",
          firewall,
          "/usr/local/bin/update-firewall.sh",
          "--set-domains",
          "example.com;id",
        ]),
      ).toBe(1);
      expect(await docker(["exec", firewall, "cat", "/etc/orkestrator/allowed-domains"])).toBe(
        "registry.npmjs.org",
      );

      // Durable: a restart boots with the applied list, with nothing to re-apply.
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      await restartRuntime(containerId);
      policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).toBe(0);
      expect(await refresherPids(firewall)).toHaveLength(1);

      // An edit saved while the container is stopped is pending until applied.
      await stopRuntimeContainer(containerId);
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe(
        "not-running",
      );
      await startRuntime(containerId);
      expect((await environmentNetworkPolicy(environment.id, context)).domains).toBe("pending");
      expect(await probe(containerId, "https://example.com/")).toBe(0);
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);
    },
    LIVE_TIMEOUT_MS,
  );
});

// A local peer makes protocol matching independent of public UDP services.
// Every port answers TCP and UDP, so a failed probe demonstrates filtering.
const ECHO_PEER = `
const net = require("node:net");
const dgram = require("node:dgram");
for (const port of [18080, 18081, 18082]) {
  net.createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", data => socket.write(data));
  }).listen(port, "0.0.0.0");
  const udp = dgram.createSocket("udp4");
  udp.on("message", (data, peer) => udp.send(data, peer.port, peer.address));
  udp.bind(port, "0.0.0.0");
}
`;

async function echoProbe(
  containerId: string,
  protocol: "tcp" | "udp",
  port: number,
): Promise<number> {
  const script =
    protocol === "tcp"
      ? `
    const socket = require("node:net").connect(${port}, "firewall-peer.test");
    socket.on("connect", () => socket.write("probe"));
    socket.on("data", data => process.exit(data.toString() === "probe" ? 0 : 2));
    socket.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  `
      : `
    const socket = require("node:dgram").createSocket("udp4");
    socket.on("message", data => process.exit(data.toString() === "probe" ? 0 : 2));
    socket.on("error", () => process.exit(1));
    socket.send("probe", ${port}, "firewall-peer.test");
    setTimeout(() => process.exit(1), 2000);
  `;
  return dockerStatus(["exec", "-u", "node", containerId, "node", "-e", script]);
}

async function heldEcho(containerId: string, port: number, tag: string): Promise<void> {
  const script = `
    const fs = require("node:fs");
    const socket = require("node:net").connect(${port}, "firewall-peer.test");
    let first = true;
    const finish = result => { fs.writeFileSync("/tmp/${tag}.second", result); process.exit(0); };
    socket.on("error", () => finish("closed"));
    socket.on("connect", () => socket.write("first"));
    socket.on("data", data => {
      if (first) { first = false; fs.writeFileSync("/tmp/${tag}.first", data); }
      else finish(data.toString());
    });
    const poll = setInterval(() => {
      if (!fs.existsSync("/tmp/${tag}.go")) return;
      clearInterval(poll);
      socket.write("second");
      setTimeout(() => finish("timeout"), 2000);
    }, 50);
    setTimeout(() => finish("expired"), 30000);
  `;
  await docker(["exec", "-d", "-u", "node", containerId, "node", "-e", script]);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      (await docker(["exec", containerId, "cat", `/tmp/${tag}.first`]).catch(() => "")) === "first"
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("local peer did not answer the held connection");
}

describe("policy 3 kernel tuple qualification", () => {
  live(
    "TCP and UDP match separately and removing a port revokes only its established connection",
    async () => {
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const { applyEnvironmentAllowedDomains, environmentNetworkPolicy } =
        await import("../src/core/container-network");
      const entries = [
        "firewall-peer.test:18080",
        "firewall-peer.test:18081",
        "firewall-peer.test:18080/udp",
      ];
      const environment = lifecycleEnvironment({ id: `tuple-${RUN}`, allowedDomains: entries });
      const { context } = firewallContext([environment]);
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
      });
      await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
      const firewall = await networkOwnerContainer(containerId);
      const network = await docker([
        "inspect",
        "--format",
        "{{.HostConfig.NetworkMode}}",
        firewall,
      ]);
      const peer = await docker([
        "run",
        "-d",
        "--label",
        `orkestrator-owner=${owner}`,
        "--network",
        network,
        "--network-alias",
        "firewall-peer.test",
        "--entrypoint",
        "node",
        IMAGE,
        "-e",
        ECHO_PEER,
      ]);
      try {
        // Docker returns before Node necessarily has its listeners open.
        let ready = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          if ((await echoProbe(peer, "tcp", 18080)) === 0) {
            ready = true;
            break;
          }
          await Bun.sleep(100);
        }
        expect(ready).toBe(true);
        // Prove all server ports really answer before testing the restricted client.
        for (const protocol of ["tcp", "udp"] as const) {
          for (const port of [18080, 18081, 18082])
            expect(await echoProbe(peer, protocol, port)).toBe(0);
        }
        // The peer runs before the gateway, so the gateway must be started
        // after it joined the network: start the runtime the backend's way.
        await startRuntime(containerId);
        const policy = await environmentNetworkPolicy(environment.id, context);
        expect(policy.policyVersion).toBe(3);
        const members = await docker([
          "exec",
          "--user",
          "root",
          firewall,
          "ipset",
          "list",
          "allowed-domains",
        ]);
        expect(policy.effective?.allowedEntries).toBe(
          Number(members.match(/Number of entries: (\d+)/)?.[1]),
        );
        expect(await echoProbe(containerId, "tcp", 18080)).toBe(0);
        expect(await echoProbe(containerId, "tcp", 18081)).toBe(0);
        expect(await echoProbe(containerId, "udp", 18080)).toBe(0);
        expect(await echoProbe(containerId, "udp", 18081)).toBe(1);
        expect(await echoProbe(containerId, "tcp", 18082)).toBe(1);
        if (firewall !== containerId) {
          // Positive control: this image can create AF_PACKET sockets as root.
          const rawSocket = 'socket(my $s, 17, 3, 0x0300) or die "$!";';
          expect(await dockerStatus(["exec", "-u", "root", peer, "perl", "-e", rawSocket])).toBe(0);
          const denied =
            'socket(my $s, 17, 3, 0x0300) and die "AF_PACKET permitted"; $!{EPERM} or die "$!";';
          expect(
            await dockerStatus(["exec", "-u", "root", containerId, "perl", "-e", denied]),
          ).toBe(0);
          expect(
            await docker(["inspect", "-f", "{{json .HostConfig.CapDrop}}", containerId]),
          ).toContain("NET_RAW");

          const peerAddress = await docker([
            "inspect",
            "-f",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
            peer,
          ]);
          // A real forged loopback DNS server; answer every A query with the
          // controlled peer's otherwise-blocked address.
          const dns = `
const fs = require("fs"), udp = require("dgram").createSocket("udp4");
let count = 0;
udp.on("message", (query, remote) => {
  fs.writeFileSync("/tmp/forged-dns-queries", String(++count));
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  let end = 12;
  while (query[end]) end += query[end] + 1;
  end += 5; // zero label, QTYPE and QCLASS, excluding EDNS additional records
  const answer = Buffer.from([192,12,0,1,0,1,0,0,1,44,0,4,..."${peerAddress}".split(".").map(Number)]);
  udp.send(Buffer.concat([header, query.subarray(12, end), answer]), remote.port, remote.address);
});
udp.bind(53, "127.0.0.1", () => fs.writeFileSync("/tmp/forged-dns-ready", "ready"));`;
          await docker(["exec", "-d", "-u", "root", containerId, "node", "-e", dns]);
          for (let attempt = 0; attempt < 50; attempt++) {
            if (
              (await dockerStatus(["exec", containerId, "test", "-f", "/tmp/forged-dns-ready"])) ===
              0
            )
              break;
            await Bun.sleep(100);
          }
          expect(
            await docker(["exec", containerId, "dig", "@127.0.0.1", "+short", "poisoned.test"]),
          ).toBe(peerAddress);
          await docker([
            "exec",
            "-u",
            "root",
            containerId,
            "bash",
            "-ec",
            `
cp /etc/resolv.conf /tmp/resolv.before
cp /etc/hosts /tmp/hosts.before
printf 'nameserver 127.0.0.1\\n' > /etc/resolv.conf
printf '${peerAddress} host.docker.internal\\n' >> /etc/hosts
`,
          ]);
          try {
            await docker([
              "exec",
              "-u",
              "root",
              firewall,
              "/usr/local/bin/update-firewall.sh",
              "--add",
              "poisoned.test:18082",
            ]);
            await docker([
              "exec",
              "-u",
              "root",
              firewall,
              "/usr/local/bin/update-firewall.sh",
              "--refresh",
            ]);
            expect(
              await dockerStatus([
                "exec",
                "-u",
                "root",
                firewall,
                "ipset",
                "test",
                "allowed-domains",
                `${peerAddress},tcp:18082`,
              ]),
            ).toBe(1);
            await docker([
              "exec",
              "-u",
              "root",
              firewall,
              "/usr/local/bin/update-firewall.sh",
              "--host-ports",
              "18082",
            ]);
            const hostRules = await docker([
              "exec",
              "-u",
              "root",
              firewall,
              "iptables",
              "-S",
              "ORK_HOST_SERVICES",
            ]);
            expect(hostRules).not.toContain(peerAddress);
            // Only the explicit positive-control query reached the forged server.
            expect(await docker(["exec", containerId, "cat", "/tmp/forged-dns-queries"])).toBe("1");
          } finally {
            await docker([
              "exec",
              "-u",
              "root",
              containerId,
              "bash",
              "-ec",
              "cat /tmp/resolv.before > /etc/resolv.conf; cat /tmp/hosts.before > /etc/hosts",
            ]);
          }
          expect(await echoProbe(containerId, "tcp", 18082)).toBe(1);
          expect(await echoProbe(containerId, "tcp", 18080)).toBe(0);
        }
        await heldEcho(containerId, 18080, "tuple-revoked");
        await heldEcho(containerId, 18081, "tuple-kept");
        await context.storage.updateEnvironment(environment.id, {
          allowedDomains: entries.slice(1),
        });
        expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe(
          "applied",
        );
        expect(await secondRequest(containerId, "tuple-revoked")).not.toBe("second");
        expect(await secondRequest(containerId, "tuple-kept")).toBe("second");
        expect(await echoProbe(containerId, "tcp", 18080)).toBe(1);
        expect(await echoProbe(containerId, "udp", 18080)).toBe(0);
      } finally {
        await docker(["rm", "-f", peer]);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
