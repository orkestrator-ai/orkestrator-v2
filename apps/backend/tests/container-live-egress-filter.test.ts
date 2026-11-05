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
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "nodejs.org", `${FIXTURE}:8080`, `${FIXTURE}:2525`],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
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
      await Bun.sleep(2_000);
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
