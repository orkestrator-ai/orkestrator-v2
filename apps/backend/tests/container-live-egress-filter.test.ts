/**
 * Real-Docker qualification of the egress gateway's name checks
 * (`egress-filter=1`, security finding M12): TLS SNI and HTTP Host checked
 * against the allowlist, DNS answered only for allowlisted names, live edits,
 * failing closed when the daemon dies, a full-mode runtime unaffected, the
 * rollback switch, and an older image under this backend.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * ORKESTRATOR_QUALIFICATION_OLDER_IMAGE=<image> adds the older-image case
 * (an image with `egress-gateway` but not `egress-filter`).
 *
 * Outside traffic goes only to hosts on the default allowlist
 * (registry.npmjs.org, GitHub). Names off the list are reserved `.invalid`
 * names, refused before anything leaves; Host checks run against a fixture
 * server this suite starts on the environment's own network. Every resource
 * is labelled with this run's private owner namespace and removed by that
 * label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { networkOwnerContainer } from "../src/core/container-network-owner";
import type { Environment } from "../src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { removeLabelledResources } from "./container-live-cleanup";
import { restartRuntime, startRuntime as startRuntimeContainer } from "./container-live-start";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const OLDER_IMAGE = process.env.ORKESTRATOR_QUALIFICATION_OLDER_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const liveOlder = ENABLED && OLDER_IMAGE ? test : test.skip;
const RUN = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 900_000;
const FIXTURE = `fixture.${RUN}.test`;
const ALIAS = `alias.${RUN}.test`;
const BLOCKED = `c2VjcmV0.exfil.${RUN}.invalid`;

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

beforeAll(async () => {
  if (!ENABLED) return;
  // A second guard: any Git this process runs reads no user or system config.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-egress-filter-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

function filterContext(environments: Environment[]) {
  const fixture = memoryLifecycleContext(environments, dataDir);
  Object.assign(fixture.context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      // Not a remote URL: the create path runs no host-side Git mirror, so
      // nothing here can reach the host's Git configuration or credentials.
      gitUrl: "file:///nonexistent/none.git",
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

/**
 * Runs a shell command as node in the runtime: its output (stdout and stderr,
 * without trailing newlines), then `rc=<status>` on a line of its own.
 */
async function inRuntime(containerId: string, script: string): Promise<string> {
  return docker([
    "exec",
    "-u",
    "node",
    containerId,
    "bash",
    "-c",
    `out=$( ${script} 2>&1 ); rc=$?; printf '%s\\nrc=%s' "$out" "$rc"`,
  ]);
}

async function inGateway(gateway: string, ...command: string[]): Promise<string> {
  return docker(["exec", "-u", "root", gateway, ...command], 200_000);
}

/**
 * Records what decides the path the name checks take on this daemon: whether
 * it is rootless (its network lives in RootlessKit's namespace), how Docker
 * names its upstream resolvers in the gateway's protected resolv.conf
 * (`host(...)` or by address, to-do 6101 task 3), and the gateway's nat
 * redirections, Docker's own included. Printed, and appended as a JSON line to
 * ORKESTRATOR_QUALIFICATION_EVIDENCE when set, since a logged run deletes
 * passing output. Addresses and ports only.
 */
async function recordTopology(gateway: string): Promise<void> {
  const security = await docker(["info", "--format", "{{json .SecurityOptions}}"]);
  const resolv = await inGateway(gateway, "cat", "/etc/orkestrator/trusted-network/resolv.conf");
  const nat = await inGateway(gateway, "iptables", "-t", "nat", "-S");
  const line = JSON.stringify({
    run: RUN,
    scenario: "topology",
    at: new Date().toISOString(),
    daemonRootless: security.includes("name=rootless"),
    resolvers: resolv.split("\n").filter((entry) => /^(nameserver |# ExtServers:)/.test(entry)),
    nat: nat.split("\n").filter((entry) => /-j (DNAT|REDIRECT)\b/.test(entry)),
  });
  console.log(`[egress-filter] ${line}`);
  const file = process.env.ORKESTRATOR_QUALIFICATION_EVIDENCE;
  if (file) await fs.appendFile(file, `${line}\n`);
}

async function booted(containerId: string): Promise<void> {
  try {
    await waitForContainerBoot(containerId);
  } catch (error) {
    const logs = await docker(["logs", "--tail", "40", containerId]).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
}

async function startRuntime(containerId: string): Promise<void> {
  await startRuntimeContainer(containerId);
  await booted(containerId);
}

async function restart(containerId: string): Promise<void> {
  await restartRuntime(containerId);
  await booted(containerId);
}

// An HTTP server that reports the Host it was asked for and a digest of the
// body, and a server-first TCP service (a banner, then echo).
const FIXTURE_SERVER = `
let requests = 0;
Bun.serve({ hostname: "0.0.0.0", port: 8080, async fetch(request) {
  if (new URL(request.url).pathname === "/count") return new Response(String(requests));
  requests++;
  const body = new Uint8Array(await request.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return Response.json({ host: request.headers.get("host"), length: body.length, sha256 });
} });
Bun.listen({ hostname: "0.0.0.0", port: 2526, socket: {
  data(socket, data) { socket.write(data); },
} });
Bun.listen({ hostname: "0.0.0.0", port: 2525, socket: {
  open(socket) { socket.write("220 fixture ready\\r\\n"); },
  data(socket, data) { socket.write(data); },
} });
`;

/** Starts the fixture on the gateway's network, under both names. */
async function startFixture(gateway: string, suffix: string): Promise<string> {
  const network = await docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", gateway]);
  const name = `ork-${RUN}-${suffix}-fixture`;
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `orkestrator-owner=${owner}`,
    "--network",
    network,
    "--network-alias",
    FIXTURE,
    "--network-alias",
    ALIAS,
    "--entrypoint",
    "bun",
    IMAGE,
    "-e",
    FIXTURE_SERVER,
  ]);
  return name;
}

async function fixtureRequests(fixture: string): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const count = await docker([
      "exec",
      fixture,
      "bun",
      "-e",
      'console.log(await (await fetch("http://127.0.0.1:8080/count")).text())',
    ]).catch(() => "");
    if (/^\d+$/.test(count)) return Number(count);
    await Bun.sleep(200);
  }
  throw new Error("the fixture never answered");
}

async function createRuntime(
  id: string,
  options: { image?: string; mode?: "restricted" | "full"; domains?: string[] } = {},
) {
  const { createDockerContainer } = await import("../src/core/commands-containers");
  const { resolveDockerImage } = await import("../src/core/docker-image");
  const environment = lifecycleEnvironment({
    id: `env-${RUN}-${id}`,
    networkAccessMode: options.mode ?? "restricted",
    allowedDomains: options.domains ?? [
      "registry.npmjs.org",
      `${FIXTURE}:8080`,
      `${ALIAS}:8080`,
      `${FIXTURE}:2525`,
      `${FIXTURE}:2526`,
      `${FIXTURE}:53`,
    ],
  });
  const { context } = filterContext([environment]);
  const resolved = await resolveDockerImage(options.image ?? IMAGE);
  if (resolved.kind !== "present") throw new Error("qualification image missing");
  const containerId = await createDockerContainer(environment, context, {
    imageId: resolved.imageId,
    runtimeGeneration: 1,
  });
  await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
  return { environment, context, containerId, gateway: await networkOwnerContainer(containerId) };
}

const dig = (containerId: string, args: string) =>
  inRuntime(containerId, `dig +time=3 +tries=1 ${args} | grep -E 'status:|EDE|no servers'`);

describe("M12 name checks at the egress gateway", () => {
  live(
    "SNI, Host and DNS are checked against the allowlist, edits apply in place, and a dead daemon fails closed",
    async () => {
      const { environmentNetworkPolicy, applyEnvironmentAllowedDomains } =
        await import("../src/core/container-network");
      const { environment, context, containerId, gateway } = await createRuntime("checks");
      expect(gateway).not.toBe(containerId);
      const fixture = await startFixture(gateway, "checks");
      await startRuntime(containerId);
      expect(await inGateway(gateway, "cat", "/etc/orkestrator/egress-filter")).toBe("on");
      await recordTopology(gateway);
      const policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.enforcement).toBe("gateway");
      expect(policy.effective?.egressFilter).toBe("enforced");

      // An allowed name over TLS works; the same address asked for a name
      // off the allowlist is refused at the ClientHello.
      expect(
        await inRuntime(
          containerId,
          "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://registry.npmjs.org/",
        ),
      ).toMatch(/^200\nrc=0$/);
      const npm = await inRuntime(
        containerId,
        "getent ahostsv4 registry.npmjs.org | awk 'NR == 1 { print $1 }'",
      );
      const address = npm.split("\n")[0]!;
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(
        await inRuntime(
          containerId,
          `curl -k -sS -o /dev/null --max-time 15 --resolve tenant.${RUN}.invalid:443:${address} https://tenant.${RUN}.invalid/`,
        ),
      ).toMatch(/alert access denied[\s\S]*rc=35$/);

      // Plain HTTP on a named port: the Host is checked, and a refused
      // request never reaches the server behind the allowed address.
      const before = await fixtureRequests(fixture);
      expect(
        await inRuntime(containerId, `curl -sS --max-time 15 http://${FIXTURE}:8080/`),
      ).toContain(`"host":"${FIXTURE}:8080"`);
      const fixtureAddress = (
        await inRuntime(containerId, `getent ahostsv4 ${FIXTURE} | awk 'NR == 1 { print $1 }'`)
      ).split("\n")[0]!;
      const refused = await inRuntime(
        containerId,
        `curl -sS -w '\\n%{http_code}' --max-time 15 -H 'Host: tenant.${RUN}.invalid' http://${fixtureAddress}:8080/`,
      );
      expect(refused).toContain("egress gateway refused this request");
      expect(refused).toMatch(/403\nrc=0$/);
      expect(await fixtureRequests(fixture)).toBe(before + 1);
      for (const request of [
        "\r\nGET / HTTP/1.1\r\n",
        "\r\n\r\nget / HTTP/1.1\r\n",
        "GET\t/\tHTTP/1.1\r\n",
        "custom / HTTP/1.1\r\n",
        "GET /é/🦊 HTTP/1.1\r\n",
        "custom /é HTTP/1.1\r\n",
      ]) {
        const response = await docker([
          "exec",
          "-u",
          "node",
          containerId,
          "perl",
          "-MIO::Socket::INET",
          "-e",
          `my $s = IO::Socket::INET->new(PeerAddr => $ARGV[0], PeerPort => 8080, Timeout => 5) or die $!;
           $s->autoflush(1); my $request = $ARGV[1] . "Host: tenant.invalid\\r\\n\\r\\n";
           for my $byte (split //, $request) { syswrite($s, $byte); select undef, undef, undef, 0.001; }
           alarm 5; my $line = <$s>; print $line // '';`,
          fixtureAddress,
          request,
        ]);
        expect(response).toContain("403 Forbidden");
      }
      expect(await fixtureRequests(fixture)).toBe(before + 1);
      for (const command of ["EHLO mail.test", "USER alice", "AUTH fixture"]) {
        expect(
          await docker([
            "exec",
            "-u",
            "node",
            containerId,
            "perl",
            "-MIO::Socket::INET",
            "-e",
            `my $s = IO::Socket::INET->new(PeerAddr => $ARGV[0], PeerPort => 2526, Timeout => 5) or die $!;
           $s->autoflush(1); print {$s} "$ARGV[1]\\r\\n"; alarm 5; print scalar <$s>;`,
            fixtureAddress,
            command,
          ]),
        ).toBe(command);
      }

      // The tuple proxy must never take port 53 ahead of the DNS filter.
      expect(await dig(containerId, `+tcp @${fixtureAddress} ${BLOCKED} A`)).toContain(
        "status: REFUSED",
      );
      // Workloads share the namespace but cannot reuse the held UDP listener
      // or create sockets bearing the gateway mark, even as workload root.
      for (const user of ["node", "orkroot"]) {
        expect(
          await docker([
            "exec",
            "-u",
            user,
            containerId,
            "perl",
            "-MSocket",
            "-e",
            `for my $ip ('127.0.0.1', $ARGV[0]) {
             socket(my $s, PF_INET, SOCK_DGRAM, 0) or die $!;
             setsockopt($s, SOL_SOCKET, SO_REUSEADDR, 1) or die $!;
             die 'DNS listener hijacked' if bind($s, sockaddr_in(31453, inet_aton($ip)));
             die "wrong bind error: $!" unless $!{EADDRINUSE};
           }
           socket(my $s, PF_INET, SOCK_DGRAM, 0) or die $!;
           die 'workload set SO_MARK' if setsockopt($s, SOL_SOCKET, 36, pack('L', 0x6f726b));
           die "wrong mark error: $!" unless $!{EPERM}; print 'protected';`,
            (await inGateway(gateway, "hostname", "-i")).split(" ")[0]!,
          ]),
        ).toBe("protected");
      }
      // Query the actual embedded DNS listening ports, not its port-53 alias.
      const embeddedPorts = await docker([
        "exec",
        "-u",
        "node",
        containerId,
        "perl",
        "-e",
        `for my $file ('/proc/net/udp', '/proc/net/tcp') {
           open(my $f, '<', $file) or die $!;
           while (<$f>) { print hex($1), "\\n" if /0B00007F:([0-9A-F]{4})/; }
         }`,
      ]);
      expect(embeddedPorts).not.toBe("");
      for (const port of new Set(embeddedPorts.split("\n"))) {
        expect(await dig(containerId, `@127.0.0.11 -p ${port} ${BLOCKED} A`)).toContain(
          "no servers could be reached",
        );
        expect(await dig(containerId, `+tcp @127.0.0.11 -p ${port} ${BLOCKED} A`)).toContain(
          "no servers could be reached",
        );
      }
      // Exercise the pending-query socket with a workload that knows both
      // its transaction ID and ephemeral port. Hold back the genuine reply.
      const resolverDrop = [
        "-d",
        "127.0.0.11",
        "-p",
        "udp",
        "-m",
        "mark",
        "--mark",
        "0x6f726b",
        "-j",
        "DROP",
      ];
      await inGateway(gateway, "iptables", "-I", "OUTPUT", "1", ...resolverDrop);
      try {
        const question = Buffer.concat([
          Buffer.from("123401000001000000000000", "hex"),
          ..."registry.npmjs.org"
            .split(".")
            .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
          Buffer.from("0000010001", "hex"),
        ]).toString("hex");
        await docker([
          "exec",
          "-d",
          "-u",
          "root",
          gateway,
          "perl",
          "-e",
          `open(my $f, '<', '/usr/local/bin/orkestrator-egress-filter') or die $!;
           my $source = do { local $/; <$f> }; $source =~ s/main\\(\\) unless caller;//;
           eval $source . "\\n" . $ARGV[0]; die $@ if $@;`,
          `$opt{mark} = 0x6f726b;
           my $message = pack('H*', '${question}');
           my ($id, $flags, undef, $end) = parse_query($message);
           $pending{$id} = { message => $message, flags => $flags, question_end => $end,
             resolvers => ['127.0.0.11'], attempt => 0 };
           dns_send($id); my $fh = $pending{$id}{socket} or die 'no socket';
           my ($port) = unpack_sockaddr_in(getsockname($fh));
           open(my $ready, '>', '/tmp/udp-auth.port'); print {$ready} $port; close $ready;
           select undef, undef, undef, 2;
           dns_udp_answer($fh);
           open(my $done, '>', '/tmp/udp-auth.result');
           print {$done} exists $pending{$id} ? 'ignored' : 'forgery accepted'; close $done;`,
        ]);
        let port = "";
        for (let i = 0; i < 30; i++) {
          port = await inGateway(gateway, "cat", "/tmp/udp-auth.port").catch(() => "");
          if (port) break;
          await Bun.sleep(100);
        }
        expect(port).toMatch(/^\d+$/);
        expect(
          await docker([
            "exec",
            "-u",
            "node",
            containerId,
            "perl",
            "-MSocket",
            "-e",
            `socket(my $s, PF_INET, SOCK_DGRAM, 0) or die $!;
           bind($s, sockaddr_in(0, inet_aton('127.0.0.11'))) or die $!;
           my $answer = pack('H*', $ARGV[1]); substr($answer, 2, 2, pack('n', 0x8180));
           send($s, $answer, 0, sockaddr_in($ARGV[0], inet_aton('127.0.0.1'))) or die $!; print 'sent';`,
            port,
            question,
          ]),
        ).toBe("sent");
        // Before Docker's POSTROUTING SNAT, genuine resolver responses have
        // a private high source port. An unmarked workload cannot claim 53.
        expect(
          await docker([
            "exec",
            "-u",
            "node",
            containerId,
            "perl",
            "-MSocket",
            "-e",
            `socket(my $s, PF_INET, SOCK_DGRAM, 0) or die $!;
           bind($s, sockaddr_in(53, inet_aton('127.0.0.11'))) or die $!;
           connect($s, sockaddr_in($ARGV[0], inet_aton('127.0.0.1'))) or die $!;
           my $written = send($s, pack('H*', $ARGV[1]), 0);
           die 'forged source endpoint permitted' if defined $written;
           die "wrong send error: $!" unless $!{EPERM}; print 'blocked';`,
            port,
            question,
          ]),
        ).toBe("blocked");
        let result = "";
        for (let i = 0; i < 40; i++) {
          result = await inGateway(gateway, "cat", "/tmp/udp-auth.result").catch(() => "");
          if (result) break;
          await Bun.sleep(100);
        }
        expect(result).toBe("ignored");
      } finally {
        await inGateway(gateway, "iptables", "-D", "OUTPUT", ...resolverDrop);
      }

      const supervisor = await inGateway(
        gateway,
        "cat",
        "/run/orkestrator-firewall/egress-filter.pid",
      );
      const worker = await inGateway(
        gateway,
        "cat",
        "/run/orkestrator-firewall/egress-filter.ready",
      );
      await inGateway(gateway, "/usr/local/bin/init-firewall.sh");
      await inGateway(gateway, "/usr/local/bin/init-firewall.sh");
      expect(await inGateway(gateway, "cat", "/run/orkestrator-firewall/egress-filter.pid")).toBe(
        supervisor,
      );
      expect(await inGateway(gateway, "cat", "/run/orkestrator-firewall/egress-filter.ready")).toBe(
        worker,
      );
      expect(await inGateway(gateway, "pgrep", "-P", supervisor)).toBe(worker);
      expect(await dig(containerId, `${BLOCKED} A`)).toContain("status: REFUSED");

      // Bodies pass intact both ways, and a server-first protocol on a
      // named port gets its banner before the client says anything.
      expect(
        await inRuntime(
          containerId,
          `head -c 4194304 /dev/urandom > /tmp/upload && sha=$(sha256sum /tmp/upload | cut -c1-64) && curl -sS --max-time 60 --data-binary @/tmp/upload http://${FIXTURE}:8080/upload | grep -c "\\"sha256\\":\\"$sha\\""`,
        ),
      ).toMatch(/^1\nrc=0$/);
      expect(
        await inRuntime(
          containerId,
          `timeout 10 bash -c 'exec 3<>/dev/tcp/${FIXTURE}/2525; head -c 17 <&3'`,
        ),
      ).toMatch(/^220 fixture ready\nrc=0$/);
      // GitHub over SSH still works by address.
      expect(
        await inRuntime(
          containerId,
          "timeout 10 bash -c 'exec 3<>/dev/tcp/github.com/22; head -c 7 <&3'",
        ),
      ).toMatch(/^SSH-2.0\nrc=0$/);

      // DNS: an allowed name resolves; an attacker-style name gets REFUSED
      // with an Extended DNS Error from the gateway, over UDP and TCP and
      // when sent straight to a resolver off the host.
      expect(await dig(containerId, "registry.npmjs.org A")).toContain("status: NOERROR");
      for (const args of [`${BLOCKED} A`, `+tcp ${BLOCKED} A`, `@192.0.2.53 ${BLOCKED} TXT`]) {
        const answer = await dig(containerId, args);
        expect(answer).toContain("status: REFUSED");
        expect(answer).toContain("EDE: 18 (Prohibited)");
      }
      expect(await inRuntime(containerId, `getent hosts ${BLOCKED}`)).toMatch(/rc=2$/);

      // An edit applies in place: a name added resolves and connects; a name
      // removed is refused although its address stays allowed for another.
      // Keep two classified connections open through removal. Revoking one
      // must close only it, with no worker restart or loss of the other.
      await docker([
        "exec",
        "-d",
        "-u",
        "node",
        containerId,
        "perl",
        "-MIO::Socket::INET",
        "-e",
        `eval {
           $SIG{PIPE} = 'IGNORE'; alarm 30;
           my @sockets;
           for my $host (@ARGV) {
             my $s = IO::Socket::INET->new(PeerAddr => $host, PeerPort => 8080, Timeout => 5) or die $!;
             $s->autoflush(1); print {$s} "GET / HTTP/1.1\\r\\nHost: $host:8080\\r\\n\\r\\n";
             my $buffer = ''; my $head;
             while ($buffer !~ /\\r\\n\\r\\n/) { sysread($s, my $byte, 1) == 1 or die 'no response'; $buffer .= $byte; }
             my ($size) = $buffer =~ /content-length: (\\d+)/i;
             read($s, my $body, $size) == $size or die 'short response'; push @sockets, $s;
           }
           open(my $ready, '>', '/tmp/revoke.ready') or die $!; print {$ready} 'ready'; close $ready;
           my $read = sysread($sockets[0], my $data, 1);
           die 'revoked socket stayed open' if $read;
           print {$sockets[1]} "GET / HTTP/1.1\\r\\nHost: $ARGV[1]:8080\\r\\n\\r\\n";
           sysread($sockets[1], $data, 128) > 0 or die 'unrelated connection lost';
           open(my $done, '>', '/tmp/revoke.result') or die $!; print {$done} 'ok'; close $done;
           1;
         } or do { open(my $f, '>', '/tmp/revoke.result'); print {$f} 'failed'; };`,
        ALIAS,
        FIXTURE,
      ]);
      for (let i = 0; i < 30; i++) {
        if ((await inRuntime(containerId, "cat /tmp/revoke.ready")).startsWith("ready")) break;
        await Bun.sleep(100);
      }
      expect(await inRuntime(containerId, "cat /tmp/revoke.ready")).toContain("ready");
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "nodejs.org", `${FIXTURE}:8080`, `${FIXTURE}:2525`],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      for (let i = 0; i < 30; i++) {
        if ((await inRuntime(containerId, "cat /tmp/revoke.result")).startsWith("ok")) break;
        await Bun.sleep(100);
      }
      expect(await inRuntime(containerId, "cat /tmp/revoke.result")).toContain("ok");
      expect(await inGateway(gateway, "cat", "/run/orkestrator-firewall/egress-filter.ready")).toBe(
        worker,
      );
      expect(await dig(containerId, "nodejs.org A")).toContain("status: NOERROR");
      expect(
        await inRuntime(
          containerId,
          "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://nodejs.org/en",
        ),
      ).toMatch(/^200\nrc=0$/);
      expect(await dig(containerId, `${ALIAS} A`)).toContain("status: REFUSED");
      expect(
        await inRuntime(
          containerId,
          `curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H 'Host: ${ALIAS}:8080' http://${fixtureAddress}:8080/`,
        ),
      ).toMatch(/^403\nrc=0$/);
      expect(
        await inRuntime(containerId, `curl -sS --max-time 15 http://${FIXTURE}:8080/`),
      ).toContain(`"host":"${FIXTURE}:8080"`);

      // Nothing in the runtime, root included, can see or stop the daemon.
      expect(
        await docker([
          "exec",
          "--user",
          "orkroot",
          containerId,
          "sh",
          "-c",
          "pgrep -f '[o]rkestrator-egress-filter' | wc -l",
        ]),
      ).toBe("0");

      // Killed outright, supervisor and worker: allowed traffic is refused
      // and DNS gets no answer. Nothing falls back to open.
      await inGateway(
        gateway,
        "sh",
        "-c",
        'p=$(cat /run/orkestrator-firewall/egress-filter.pid); kill -KILL $p $(pgrep -P "$p")',
      );
      expect(
        await inRuntime(
          containerId,
          `curl -sS -o /dev/null --max-time 10 --resolve registry.npmjs.org:443:${address} https://registry.npmjs.org/`,
        ),
      ).toMatch(/rc=7$/);
      expect(
        await inRuntime(
          containerId,
          `curl -sS -o /dev/null --max-time 10 http://${fixtureAddress}:8080/`,
        ),
      ).toMatch(/rc=7$/);
      expect(await dig(containerId, "registry.npmjs.org A")).toContain(
        "no servers could be reached",
      );
      expect(await dig(containerId, `@192.0.2.53 ${BLOCKED} A`)).toContain(
        "no servers could be reached",
      );
      // The refresher starts it again.
      await inGateway(gateway, "/usr/local/bin/update-firewall.sh", "--refresh");
      expect(
        await inRuntime(
          containerId,
          "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://registry.npmjs.org/",
        ),
      ).toMatch(/^200\nrc=0$/);
      // A worker that dies alone is restarted by its supervisor.
      await inGateway(
        gateway,
        "sh",
        "-c",
        'kill -KILL $(pgrep -P "$(cat /run/orkestrator-firewall/egress-filter.pid)")',
      );
      expect(
        await docker([
          "exec",
          "-u",
          "node",
          containerId,
          "perl",
          "-MSocket",
          "-e",
          `for (1 .. 200) {
           socket(my $s, PF_INET, SOCK_DGRAM, 0) or die $!;
           setsockopt($s, SOL_SOCKET, SO_REUSEADDR, 1) or die $!;
           die 'restart listener gap' if bind($s, sockaddr_in(31453, inet_aton('127.0.0.1')));
           die "wrong bind error: $!" unless $!{EADDRINUSE};
           close $s; select undef, undef, undef, 0.01;
         } print 'held';`,
        ]),
      ).toBe("held");
      expect(await dig(containerId, "registry.npmjs.org A")).toContain("status: NOERROR");

      // A restart keeps the recorded shape and the checks.
      await restart(containerId);
      expect(
        (await environmentNetworkPolicy(environment.id, context)).effective?.egressFilter,
      ).toBe("enforced");
      expect(await dig(containerId, `${BLOCKED} A`)).toContain("status: REFUSED");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "addressed DNS upstreams reject forged replies and fail over after refusal or timeout",
    async () => {
      const { containerId, gateway } = await createRuntime("dns-upstreams");
      await startRuntime(containerId);
      // Controlled addressed upstreams in this test's namespace. The first
      // has no listener, the second sends bad packets before a real answer.
      await docker([
        "exec",
        "-d",
        "-u",
        "root",
        gateway,
        "perl",
        "-MSocket",
        "-e",
        `socket(my $udp, PF_INET, SOCK_DGRAM, 0) or die $!;
         bind($udp, sockaddr_in(53, inet_aton('127.0.0.3'))) or die $!;
         socket(my $tcp, PF_INET, SOCK_STREAM, 0) or die $!;
         setsockopt($tcp, SOL_SOCKET, SO_REUSEADDR, 1);
         bind($tcp, sockaddr_in(53, inet_aton('127.0.0.3'))) or die $!;
         listen($tcp, 8) or die $!;
         my $child = fork(); die $! unless defined $child;
         if (!$child) {
           while (my $peer = accept(my $s, $tcp)) {
             read($s, my $length, 2) == 2 or next;
             read($s, my $query, unpack('n', $length)) == unpack('n', $length) or next;
             my $answer = substr($query, 0, 2) . pack('n5', 0x8180, 1, 1, 0, 0) . substr($query, 12)
               . pack('n n n N n C4', 0xc00c, 1, 1, 60, 4, 198, 51, 100, 7);
             syswrite($s, pack('n', length($answer)) . $answer); close $s;
           } exit;
         }
         open(my $ready, '>', '/tmp/dns-fixture.ready'); print {$ready} $child; close $ready;
         while (my $from = recv($udp, my $query, 4096, 0)) {
           open(my $seen, '>>', '/tmp/dns-fixture.queries'); print {$seen} unpack('H*', $query), "\\n"; close $seen;
           my $forged = substr($query, 0, 2) . pack('n5', 0x8180, 1, 1, 0, 0) . substr($query, 12)
             . pack('n n n N n C4', 0xc00c, 1, 1, 60, 4, 203, 0, 113, 99);
           socket(my $wrong, PF_INET, SOCK_DGRAM, 0) or die $!;
           bind($wrong, sockaddr_in(0, inet_aton('127.0.0.3'))) or die $!;
           send($wrong, $forged, 0, $from); close $wrong;
           # Even from the right endpoint a query, wrong ID or wrong
           # question must not consume the pending request.
           send($udp, $query, 0, $from);
           my $bad_id = pack('n', (unpack('n', $query) + 1) % 65536) . substr($forged, 2);
           send($udp, $bad_id, 0, $from);
           my $bad_question = $forged; substr($bad_question, 13, 1, 'x'); send($udp, $bad_question, 0, $from);
           select undef, undef, undef, 0.1;
           # Truncated UDP requires a new TCP query, which must also fail
           # over past the unavailable first resolver.
           my $tc = substr($query, 0, 2) . pack('n5', 0x8380, 1, 0, 0, 0) . substr($query, 12);
           send($udp, $tc, 0, $from);
         }`,
      ]);
      for (let i = 0; i < 30; i++) {
        if (
          await inGateway(gateway, "test", "-s", "/tmp/dns-fixture.ready").then(
            () => true,
            () => false,
          )
        )
          break;
        await Bun.sleep(100);
      }
      await inGateway(
        gateway,
        "sh",
        "-c",
        "printf 'nameserver 127.0.0.11\\n# ExtServers: [127.0.0.2 127.0.0.3]\\n' > /etc/orkestrator/trusted-network/resolv.conf",
      );
      // Only this fixture gateway's worker is restarted to load its new
      // protected resolver snapshot; its supervisor still holds listeners.
      await inGateway(
        gateway,
        "sh",
        "-c",
        `p=$(cat /run/orkestrator-firewall/egress-filter.pid); w=$(cat /run/orkestrator-firewall/egress-filter.ready); test "$(awk '/PPid:/ {print $2}' /proc/$w/status)" = "$p" && grep -q orkestrator-egress-filter /proc/$w/cmdline && kill -TERM "$w"`,
      );
      await Bun.sleep(1_500);
      const answer = await inRuntime(
        containerId,
        "dig +noedns +time=8 +tries=1 @192.0.2.53 registry.npmjs.org A",
      );
      expect(answer).toContain("198.51.100.7");
      expect(answer).not.toContain("203.0.113.99");
      expect(answer).toContain("Truncated, retrying in TCP mode");
      // Now the primary accepts TCP but never answers before the per-attempt
      // deadline. The secondary must still answer the same query.
      await docker([
        "exec",
        "-d",
        "-u",
        "root",
        gateway,
        "perl",
        "-MSocket",
        "-e",
        `socket(my $tcp, PF_INET, SOCK_STREAM, 0) or die $!;
         setsockopt($tcp, SOL_SOCKET, SO_REUSEADDR, 1);
         bind($tcp, sockaddr_in(53, inet_aton('127.0.0.2'))) or die $!; listen($tcp, 8) or die $!;
         open(my $ready, '>', '/tmp/dns-primary.ready'); print {$ready} 'ready'; close $ready;
         while (my $from = accept(my $s, $tcp)) { select undef, undef, undef, 4; close $s; }`,
      ]);
      for (let i = 0; i < 30; i++) {
        if (
          await inGateway(gateway, "test", "-s", "/tmp/dns-primary.ready").then(
            () => true,
            () => false,
          )
        )
          break;
        await Bun.sleep(100);
      }
      expect(
        await inRuntime(
          containerId,
          "dig +tcp +noedns +time=8 +tries=1 @192.0.2.53 registry.npmjs.org A",
        ),
      ).toContain("198.51.100.7");
      const before = await inGateway(gateway, "wc", "-l", "/tmp/dns-fixture.queries");
      expect(await dig(containerId, `@192.0.2.53 ${BLOCKED} A`)).toContain("status: REFUSED");
      expect(await dig(containerId, `+tcp @192.0.2.53 ${BLOCKED} A`)).toContain("status: REFUSED");
      expect(await inGateway(gateway, "wc", "-l", "/tmp/dns-fixture.queries")).toBe(before);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "the firewall report counts refused connections and queries since boot, and keeps no name",
    async () => {
      const { environmentNetworkPolicy } = await import("../src/core/container-network");
      const { environment, context, containerId, gateway } = await createRuntime("refusals");
      expect(gateway).not.toBe(containerId);
      await startRuntime(containerId);
      // A label no other part of this gateway's state can contain.
      const secret = `r${RUN}c2VjcmV0`;
      const refused = (suffix: string) => `${secret}.${suffix}.invalid`;
      const refusals = async () =>
        (await environmentNetworkPolicy(environment.id, context)).effective?.refusals;
      const settle = async (expected: { connections: number; queries: number }) => {
        // The daemon rewrites its counts at most once a second.
        let seen = await refusals();
        for (let i = 0; i < 20 && JSON.stringify(seen) !== JSON.stringify(expected); i++) {
          await Bun.sleep(250);
          seen = await refusals();
        }
        return seen;
      };

      // The firewall's own boot checks ask for names off the list; they are
      // not counted, and neither is anything the workload's boot did.
      expect(await refusals()).toEqual({ connections: 0, queries: 0 });

      // Allowed traffic is not a refusal.
      expect(
        await inRuntime(
          containerId,
          "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://registry.npmjs.org/",
        ),
      ).toMatch(/^200\nrc=0$/);
      expect(await dig(containerId, "registry.npmjs.org A")).toContain("status: NOERROR");
      const address = (
        await inRuntime(
          containerId,
          "getent ahostsv4 registry.npmjs.org | awk 'NR == 1 { print $1 }'",
        )
      ).split("\n")[0]!;
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(await settle({ connections: 0, queries: 0 })).toEqual({ connections: 0, queries: 0 });

      // Three refused connections: two foreign SNIs at an allowed address,
      // and a foreign Host in plain HTTP on 443.
      for (const suffix of ["tls-one", "tls-two"]) {
        expect(
          await inRuntime(
            containerId,
            `curl -k -sS -o /dev/null --max-time 15 --resolve ${refused(suffix)}:443:${address} https://${refused(suffix)}/`,
          ),
        ).toMatch(/alert access denied[\s\S]*rc=35$/);
      }
      expect(
        await inRuntime(
          containerId,
          `curl -sS -w '\\n%{http_code}' --max-time 15 -H 'Host: ${refused("http")}' http://${address}:443/`,
        ),
      ).toMatch(/egress gateway refused this request[\s\S]*403\nrc=0$/);
      // Three refused queries: over UDP, over TCP, and sent straight to a
      // resolver off the host.
      for (const args of [
        `${refused("udp")} A`,
        `+tcp ${refused("tcp")} A`,
        `@192.0.2.53 ${refused("direct")} TXT`,
      ]) {
        expect(await dig(containerId, args)).toContain("status: REFUSED");
      }
      expect(await settle({ connections: 3, queries: 3 })).toEqual({ connections: 3, queries: 3 });

      // Counts only: the file holds two numbers, and no refused name is in
      // the gateway's files or its log.
      expect(
        await inGateway(gateway, "cat", "/run/orkestrator-firewall/egress-refusals.json"),
      ).toBe('{"refusedConnections":3,"refusedQueries":3}');
      expect(
        await inGateway(
          gateway,
          "sh",
          "-c",
          `grep -rlF '${secret}' /run /etc /tmp /var/log /root 2>/dev/null; echo "found=$?"`,
        ),
      ).toBe("found=1");
      const logs = await runCommand("docker", ["logs", gateway], { timeoutMs: 30_000 });
      expect(`${logs.stdout}${logs.stderr}`).not.toContain(secret);

      // A worker restart keeps the counts; the next refusal adds to them.
      const worker = await inGateway(
        gateway,
        "cat",
        "/run/orkestrator-firewall/egress-filter.ready",
      );
      await inGateway(gateway, "kill", "-KILL", worker);
      let restarted = "";
      for (let i = 0; i < 50; i++) {
        restarted = await inGateway(
          gateway,
          "cat",
          "/run/orkestrator-firewall/egress-filter.ready",
        ).catch(() => "");
        if (/^\d+$/.test(restarted) && restarted !== worker) break;
        await Bun.sleep(100);
      }
      expect(restarted).not.toBe(worker);
      expect(await refusals()).toEqual({ connections: 3, queries: 3 });
      expect(await dig(containerId, `${refused("after-restart")} A`)).toContain("status: REFUSED");
      expect(await settle({ connections: 3, queries: 4 })).toEqual({ connections: 3, queries: 4 });

      // A new boot of the gateway counts from zero again.
      await restart(containerId);
      expect(await refusals()).toEqual({ connections: 0, queries: 0 });
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a full-mode runtime has no gateway and no name checks",
    async () => {
      const { environmentNetworkPolicy } = await import("../src/core/container-network");
      const { environment, context, containerId, gateway } = await createRuntime("full", {
        mode: "full",
      });
      expect(gateway).toBe(containerId);
      await startRuntime(containerId);
      const policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.enforcement).toBe("none");
      expect(policy.effective?.mode).toBe("full");
      expect(policy.effective?.egressFilter ?? null).toBeNull();
      expect(await dig(containerId, "registry.npmjs.org A")).toContain("status: NOERROR");
      // A reserved name is answered by Docker's resolver as it always was.
      const answer = await dig(containerId, "orkestrator-dns-probe.invalid A");
      expect(answer).not.toContain("REFUSED");
      expect(answer).not.toContain("EDE");
      expect(
        await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          "pgrep -f '[o]rkestrator-egress-filter' | wc -l; test -e /etc/orkestrator/egress-filter; echo $?",
        ]),
      ).toBe("0\n1");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "the rollback switch creates a gateway without name checks, and it stays that way",
    async () => {
      const { environmentNetworkPolicy } = await import("../src/core/container-network");
      const previous = process.env.ORKESTRATOR_EGRESS_FILTER;
      process.env.ORKESTRATOR_EGRESS_FILTER = "off";
      let created: Awaited<ReturnType<typeof createRuntime>>;
      try {
        created = await createRuntime("rollback");
      } finally {
        if (previous === undefined) delete process.env.ORKESTRATOR_EGRESS_FILTER;
        else process.env.ORKESTRATOR_EGRESS_FILTER = previous;
      }
      const { environment, context, containerId, gateway } = created;
      const fixture = await startFixture(gateway, "rollback");
      await startRuntime(containerId);
      expect(await inGateway(gateway, "cat", "/etc/orkestrator/egress-filter")).toBe("off");
      expect(
        (await environmentNetworkPolicy(environment.id, context)).effective?.egressFilter,
      ).toBe("off");
      const fixtureAddress = (
        await inRuntime(containerId, `getent ahostsv4 ${FIXTURE} | awk 'NR == 1 { print $1 }'`)
      ).split("\n")[0]!;
      const before = await fixtureRequests(fixture);
      expect(
        await inRuntime(
          containerId,
          `curl -sS --max-time 15 -H 'Host: tenant.${RUN}.invalid' http://${fixtureAddress}:8080/`,
        ),
      ).toContain(`"host":"tenant.${RUN}.invalid"`);
      expect(await fixtureRequests(fixture)).toBe(before + 1);
      expect(await dig(containerId, `${BLOCKED} A`)).not.toContain("EDE");
      // A restart with the switch gone keeps what the gateway recorded.
      await restart(containerId);
      expect(
        (await environmentNetworkPolicy(environment.id, context)).effective?.egressFilter,
      ).toBe("off");
    },
    LIVE_TIMEOUT_MS,
  );

  liveOlder(
    "an older image under this backend keeps address-only enforcement, and a start does not change it",
    async () => {
      const { environmentNetworkPolicy } = await import("../src/core/container-network");
      const { environment, context, containerId, gateway } = await createRuntime("older", {
        image: OLDER_IMAGE,
      });
      expect(gateway).not.toBe(containerId);
      const fixture = await startFixture(gateway, "older");
      await startRuntime(containerId);
      const check = async () => {
        const policy = await environmentNetworkPolicy(environment.id, context);
        expect(policy.enforcement).toBe("gateway");
        expect(policy.effective?.state).toBe("applied");
        // The older report has no field, which reads as "not checked".
        expect(policy.effective?.egressFilter).toBeNull();
        expect(
          await docker([
            "exec",
            gateway,
            "sh",
            "-c",
            "test -e /etc/orkestrator/egress-filter; echo $?",
          ]),
        ).toBe("1");
        const fixtureAddress = (
          await inRuntime(containerId, `getent ahostsv4 ${FIXTURE} | awk 'NR == 1 { print $1 }'`)
        ).split("\n")[0]!;
        const before = await fixtureRequests(fixture);
        expect(
          await inRuntime(
            containerId,
            `curl -sS --max-time 15 -H 'Host: tenant.${RUN}.invalid' http://${fixtureAddress}:8080/`,
          ),
        ).toContain(`"host":"tenant.${RUN}.invalid"`);
        expect(await fixtureRequests(fixture)).toBe(before + 1);
        expect(await dig(containerId, `${BLOCKED} A`)).not.toContain("EDE");
      };
      await check();
      await restart(containerId);
      await check();
    },
    LIVE_TIMEOUT_MS,
  );
});
