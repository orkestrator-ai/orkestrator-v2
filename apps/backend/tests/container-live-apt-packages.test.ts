/**
 * Real-Docker qualification of declared Debian packages (`aptPackages`,
 * to-do 7770 task 5).
 *
 * A restricted runtime of the qualification image is created, behind its
 * egress gateway with name checks, for a project whose checkout declares a
 * package. Creation must label it for Debian's archive and give the gateway
 * `deb.debian.org`; the runtime's `node` user then installs the declared
 * package through its sudo grant from the real archive, and the installer
 * refuses denied packages, a package that would bring one in, and a pattern.
 * Two installs started together of packages that conflict (openntpd and
 * chrony both provide time-daemon) run one after the other: one installs and
 * the other's plan then shows the removal, so it is refused and nothing is
 * removed. A second runtime, for a project that declares nothing, gets no
 * archive: the same install there fails as unreachable, so the first one's
 * download went through the gateway's allowlist and nowhere else. A third,
 * for a project whose list setup refuses outright, gets no archive either.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * (an image built from this tree, with `apt-packages=1`). It downloads a few
 * small packages (GNU hello, openntpd or chrony) from deb.debian.org.
 *
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
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { removeLabelledResources } from "./container-live-cleanup";
import { startRuntime } from "./container-live-start";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 900_000;
const BRANCH = "apt-live";
const INSTALLER = "/usr/local/bin/orkestrator-apt-install";

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-apt-packages-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

/** A host checkout whose `apt-live` branch holds this `orkestrator-ai.json`. */
async function checkout(name: string, config: Record<string, unknown>): Promise<string> {
  const repo = path.join(dataDir, name);
  await fs.mkdir(repo, { recursive: true });
  const git = (...args: string[]) =>
    runCommand(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { timeoutMs: 30_000 },
    );
  await git("init", "-q", "-b", BRANCH);
  await fs.writeFile(path.join(repo, "orkestrator-ai.json"), JSON.stringify(config));
  await git("add", "orkestrator-ai.json");
  await git("commit", "-q", "-m", "config");
  return repo;
}

/** Runs a shell command as node in the runtime: its output, then `rc=<status>`. */
async function asNode(containerId: string, script: string): Promise<string> {
  return docker(
    [
      "exec",
      "-u",
      "node",
      containerId,
      "bash",
      "-c",
      `out=$( ${script} 2>&1 ); rc=$?; printf '%s\\nrc=%s' "$out" "$rc"`,
    ],
    600_000,
  );
}

async function createRuntime(name: string, config: Record<string, unknown>) {
  const { createDockerContainer } = await import("../src/core/commands-containers");
  const { resolveDockerImage } = await import("../src/core/docker-image");
  const localPath = await checkout(name, config);
  const allowedDomains = ["registry.npmjs.org"];
  const environment = lifecycleEnvironment({
    id: `env-${RUN}-${name}`,
    branch: BRANCH,
    networkAccessMode: "restricted",
    allowedDomains,
  });
  const fixture = memoryLifecycleContext([environment], dataDir);
  Object.assign(fixture.context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      // Not a remote URL: the create path runs no host-side Git mirror.
      gitUrl: "file:///nonexistent/none.git",
      localPath,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains, enabledAgentPlatforms: [] },
      repositories: {},
    }),
  });
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("qualification image missing");
  const containerId = await createDockerContainer(environment, fixture.context, {
    imageId: resolved.imageId,
    runtimeGeneration: 1,
  });
  await fixture.context.storage.updateEnvironment(environment.id, {
    containerId,
    status: "running",
  });
  const gateway = await networkOwnerContainer(containerId);
  expect(gateway).not.toBe(containerId);
  await startRuntime(containerId);
  await waitForContainerBoot(containerId);
  return { containerId, gateway };
}

async function label(containerId: string): Promise<string> {
  return docker([
    "inspect",
    "-f",
    '{{ index .Config.Labels "orkestrator-debian-archive" }}',
    containerId,
  ]);
}

async function gatewayDomains(gateway: string): Promise<string> {
  const env = await docker(["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", gateway]);
  return env.split("\n").find((line) => line.startsWith("ALLOWED_DOMAINS=")) ?? "";
}

describe("declared Debian packages (to-do 7770)", () => {
  live(
    "a restricted gateway runtime installs a declared package and refuses denied ones",
    async () => {
      const declared = await createRuntime("declared", { aptPackages: ["hello"] });
      expect(await label(declared.containerId)).toBe("1");
      expect(await gatewayDomains(declared.gateway)).toContain("deb.debian.org");
      expect(await docker(["exec", declared.containerId, "cat", "/etc/orkestrator/egress"])).toBe(
        "gateway",
      );

      // The sources are HTTPS, so the install uses TCP 443 and passes the
      // gateway's SNI check.
      expect(
        await docker([
          "exec",
          declared.containerId,
          "grep",
          "-c",
          "^URIs: https://deb.debian.org/",
          "/etc/apt/sources.list.d/debian.sources",
        ]),
      ).toBe("2");

      const installed = await asNode(declared.containerId, `sudo -n ${INSTALLER} hello`);
      expect(installed).toContain("Installed: hello");
      expect(installed).toMatch(/\nrc=0$/);
      expect(await asNode(declared.containerId, "hello")).toBe("Hello, world!\nrc=0");
      // A second run has nothing to do.
      expect(await asNode(declared.containerId, `sudo -n ${INSTALLER} hello`)).toBe(
        "Already installed: hello\nrc=0",
      );

      for (const [name, reason] of [
        ["openssh-server", "openssh-server is not allowed"],
        ["sudo", "sudo is not allowed"],
        // ssh depends on openssh-server.
        ["ssh", "would bring in openssh-server"],
        // apt-get would read these as a pattern and a modifier.
        ["sud.", "sud. is not a package in Debian's archive"],
        ["sudo+", "sudo+ is not a package in Debian's archive"],
        // A virtual package, provided by openssh-server among others.
        ["ssh-server", "ssh-server is not a package in Debian's archive"],
        ["bad;name", "is not a Debian package name"],
      ] as const) {
        const refused = await asNode(declared.containerId, `sudo -n ${INSTALLER} '${name}'`);
        expect(refused).toContain(reason);
        expect(refused).toMatch(/\nrc=3$/);
      }
      expect(
        await asNode(
          declared.containerId,
          "dpkg-query -W -f='${db:Status-Abbrev}' openssh-server 2>/dev/null || echo absent",
        ),
      ).not.toMatch(/^ii/);

      // Concurrent installs of conflicting packages are serialized: the plan
      // checked is the plan installed, so neither removes the other.
      const concurrent = await asNode(
        declared.containerId,
        `sudo -n ${INSTALLER} openntpd > /tmp/apt-a.log 2>&1 & a=$!; ` +
          `sudo -n ${INSTALLER} chrony > /tmp/apt-b.log 2>&1 & b=$!; ` +
          `wait $a; echo "a=$?"; wait $b; echo "b=$?"; cat /tmp/apt-a.log /tmp/apt-b.log`,
      );
      const statuses = [/\ba=(\d+)/, /\bb=(\d+)/].map((pattern) =>
        Number(pattern.exec(concurrent)?.[1] ?? -1),
      );
      expect(statuses.sort()).toEqual([0, 3]);
      expect(concurrent).toMatch(/the install would remove (openntpd|chrony)/);
      const timeDaemons = await asNode(
        declared.containerId,
        "for p in openntpd chrony; do dpkg-query -W -f='${db:Status-Abbrev}' $p 2>/dev/null | grep -q '^ii' && echo $p; done",
      );
      expect(
        timeDaemons.split("\n").filter((line) => line && !line.startsWith("rc=")),
      ).toHaveLength(1);

      // A project that declares nothing gets no archive: the gateway refuses it.
      const plain = await createRuntime("plain", { setupContainer: ["true"] });
      expect(await label(plain.containerId)).not.toBe("1");
      expect(await gatewayDomains(plain.gateway)).not.toContain("deb.debian.org");
      const unreachable = await asNode(plain.containerId, `sudo -n ${INSTALLER} hello`);
      expect(unreachable).toContain("Debian's archive could not be reached");
      expect(unreachable).toMatch(/\nrc=5$/);

      // A list setup refuses outright never reaches the archive, so its
      // runtime is not given it.
      const refusedOnly = await createRuntime("refused", { aptPackages: ["hello", "sudo"] });
      expect(await label(refusedOnly.containerId)).not.toBe("1");
      expect(await gatewayDomains(refusedOnly.gateway)).not.toContain("deb.debian.org");
    },
    LIVE_TIMEOUT_MS,
  );
});
