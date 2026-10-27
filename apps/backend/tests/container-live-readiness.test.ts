/**
 * Real-Docker readiness failure injection (C09 faults, C10, a C23 firewall
 * re-run) and the live host-service reply (C22).
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * (a manifest-bearing image; never retag `orkestrator-v2:latest` for this).
 * Restricted boots need outbound access to api.github.com and github.com.
 *
 * Faults enter only through fixtures at the lifecycle-service boundary:
 * throwaway images derived from the qualification image (no firewall script,
 * an unwritable status directory, a boot held at its firewall step), a
 * pre-created DNS-broken environment network, file writes and a silent
 * resolver inside this run's own containers, a container restart, and the
 * death of the setup terminal's host process. No production setting is
 * involved. The whole Docker daemon is never restarted: it is shared.
 *
 * Every scenario has a private data directory, so everything the backend
 * creates carries that directory's owner label; fixtures also carry this
 * run's `orkestrator-qualification` label. `afterAll` removes exactly those
 * containers, volumes, networks and derived image tags. Never a prune.
 *
 * Scenario ids refer to the matrix in
 * docs/development/container-qualification.md.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import {
  BOOT_STATUS_PATH,
  ContainerInitializationError,
  ensureCurrentBootReady,
  observeContainerBoot,
  waitForContainerBoot,
  type BootObservation,
} from "../src/core/container-readiness";
import { ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES } from "../src/core/commands-error-text";
import type { Environment } from "../src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { removeLabelledResources } from "./container-live-cleanup";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const RUN_LABEL = `orkestrator-qualification=${RUN}`;
const LIVE_TIMEOUT_MS = 900_000;

type Scenario = { root: string; dataDir: string; owner: string };
const scenarios: Scenario[] = [];
const derivedImages: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

const savedEgress = process.env.ORKESTRATOR_EGRESS;
afterEach(() => {
  if (savedEgress === undefined) delete process.env.ORKESTRATOR_EGRESS;
  else process.env.ORKESTRATOR_EGRESS = savedEgress;
});

/**
 * Keeps this scenario's firewall inside the runtime (the rollout cap). Its
 * faults are injected into the runtime's own firewall step, which a runtime
 * behind an egress gateway does not have; the gateway's are tested apart.
 */
function pinInContainerFirewall(): void {
  process.env.ORKESTRATOR_EGRESS = "in-container";
}

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

/** Both streams of a container's log: the entrypoint writes errors to stderr. */
async function containerLogs(containerId: string): Promise<string> {
  const { stdout, stderr } = await runCommand("docker", ["logs", containerId], {
    timeoutMs: 60_000,
  });
  return `${stdout}\n${stderr}`;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await runCommand(
    "git",
    ["-c", "user.email=q@example.invalid", "-c", "user.name=q", "-C", cwd, ...args],
    { timeoutMs: 60_000 },
  );
}

/**
 * A private data directory. With `origin`, also the agent-test bare remote
 * the backend binds into a runtime (`<data dir>/../fixtures/origin.git`), so
 * a real clone and setup run without a network or credential.
 */
async function scenario(origin?: { setupContainer?: string }): Promise<Scenario> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-readiness-"));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const entry = { root, dataDir, owner: dockerOwnerNamespace(dataDir) };
  scenarios.push(entry);
  if (origin) {
    const source = path.join(root, "source");
    await fs.mkdir(source, { recursive: true });
    await git(source, ["init", "-q", "-b", "main"]);
    await fs.writeFile(path.join(source, "README.md"), "readiness fixture\n");
    if (origin.setupContainer) {
      await fs.writeFile(
        path.join(source, "orkestrator-ai.json"),
        `${JSON.stringify({ setupContainer: origin.setupContainer }, null, 2)}\n`,
      );
    }
    await git(source, ["add", "."]);
    await git(source, ["commit", "-qm", "fixture"]);
    await fs.mkdir(path.join(root, "fixtures"), { recursive: true });
    await runCommand(
      "git",
      ["clone", "-q", "--bare", source, path.join(root, "fixtures", "origin.git")],
      { timeoutMs: 60_000 },
    );
  }
  return entry;
}

/** A throwaway image derived from the qualification image, tagged for this run. */
async function deriveImage(
  name: string,
  instructions: string[],
  files: Record<string, string> = {},
): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-readiness-image-"));
  const tag = `orkestrator-qualification-${RUN}:${name}`;
  try {
    await fs.writeFile(
      path.join(directory, "Dockerfile"),
      [`FROM ${IMAGE}`, ...instructions].join("\n") + "\n",
    );
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(path.join(directory, file), content);
    }
    derivedImages.push(tag);
    await docker(["build", "-q", "--label", RUN_LABEL, "-t", tag, directory], 600_000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  return tag;
}

const HOLD_MARKER = "/etc/orkestrator-qualification-hold";
const HELD_MARKER = "/run/orkestrator-qualification-held";
const RELEASE_MARKER = "/run/orkestrator-qualification-release";
let heldBootImageTag: Promise<string> | null = null;

/**
 * The qualification image with its first boot held at the firewall step
 * (phase `initializing`) until the test releases it, so a fault lands
 * before readiness however fast the host is. The hold is one-shot: a later
 * boot of the same container passes straight through to the real script.
 */
function heldBootImage(): Promise<string> {
  heldBootImageTag ??= deriveImage(
    "held-boot",
    [
      "USER root",
      "RUN mv /usr/local/bin/init-firewall.sh /usr/local/bin/init-firewall-real.sh",
      "COPY --chmod=0755 hold-firewall.sh /usr/local/bin/init-firewall.sh",
      `RUN touch ${HOLD_MARKER}`,
      "USER node",
    ],
    {
      "hold-firewall.sh": [
        "#!/bin/bash",
        "# Qualification fixture: hold one boot before its firewall step.",
        `if [ -e ${HOLD_MARKER} ]; then`,
        `  rm -f ${HOLD_MARKER}`,
        `  touch ${HELD_MARKER}`,
        `  while [ ! -e ${RELEASE_MARKER} ]; do sleep 0.1; done`,
        "fi",
        'exec /usr/local/bin/init-firewall-real.sh "$@"',
        "",
      ].join("\n"),
    },
  );
  return heldBootImageTag;
}

/** Waits until the boot is held and returns its current (initializing) record. */
async function heldBoot(
  containerId: string,
): Promise<{ bootId: string; phase: string; pid1Start: string }> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const out = await docker([
      "exec",
      containerId,
      "sh",
      "-c",
      `test -e ${HELD_MARKER} && head -n 1 ${BOOT_STATUS_PATH}`,
    ]).catch(() => "");
    if (out) {
      const record = JSON.parse(out) as { bootId: string; phase: string; pid1Start: string };
      expect(record.phase).toBe("initializing");
      return record;
    }
    await Bun.sleep(100);
  }
  throw new Error("the boot was never held");
}

async function releaseBoot(containerId: string): Promise<void> {
  await docker(["exec", "--user", "root", containerId, "touch", RELEASE_MARKER]);
}

/** The environment's lifecycle record; a format this backend cannot read fails. */
function lifecycleRecord(environment: Environment) {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) throw new Error("unsupported lifecycle record");
  return parsed.record;
}

function project(dataDir: string) {
  return {
    id: "project-1",
    name: "Project",
    gitUrl: path.join(path.dirname(dataDir), "fixtures", "origin.git"),
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  };
}

/**
 * A lifecycle context against the real daemon. The agent launch after setup
 * is recorded, never performed, together with the boot it would have
 * launched into.
 */
function readinessContext(
  scene: Scenario,
  environment: Environment,
  options: { image?: string; servicePort?: number } = {},
) {
  const fixture = memoryLifecycleContext([environment], scene.dataDir);
  const launches: Array<{
    environmentId: string;
    boot: BootObservation | null;
  }> = [];
  Object.assign(fixture.context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    dockerImage: options.image ?? IMAGE,
    nativeAgents: {
      reconcileInitialLaunch: async (environmentId: string) => {
        const containerId = fixture.environments.get(environmentId)?.containerId;
        launches.push({
          environmentId,
          boot: containerId ? await observeContainerBoot(containerId) : null,
        });
      },
    },
    ...(options.servicePort
      ? {
          agentTools: {
            connection: () => {
              throw new Error("not used");
            },
            revokeEnvironment: () => undefined,
            servicePort: () => options.servicePort,
          },
        }
      : {}),
  });
  Object.assign(fixture.context.storage, {
    getProject: async () => project(scene.dataDir),
    loadConfig: async () => ({
      version: "1.0.0",
      global: {
        allowedDomains: ["registry.npmjs.org"],
        enabledAgentPlatforms: [],
      },
      repositories: {},
    }),
  });
  cleanups.push(() => fixture.context.runtime.shutdown());
  return { ...fixture, launches };
}

/** An environment that asks for an agent launch once setup completes. */
function launchingEnvironment(id: string, overrides: Partial<Environment> = {}): Environment {
  return lifecycleEnvironment({
    id,
    pendingAgentLaunch: true,
    initialAgentPlatform: "claude",
    ...overrides,
  });
}

async function startEnvironment(environmentId: string, context: unknown) {
  const { startEnvironmentOnce } = await import("../src/core/commands-environment");
  return startEnvironmentOnce(environmentId, context as never, () => undefined);
}

async function containerOf(scene: Scenario, environmentId: string): Promise<string> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const id = await docker([
      "ps",
      "-aq",
      "--filter",
      `label=orkestrator-owner=${scene.owner}`,
      "--filter",
      `label=environment-id=${environmentId}`,
    ]).catch(() => "");
    if (id) return id.split("\n")[0]!;
    await Bun.sleep(100);
  }
  throw new Error(`no container appeared for ${environmentId}`);
}

/** The last boot record a stopped container left on its filesystem. */
async function finalBootRecord(scene: Scenario, containerId: string) {
  const target = path.join(scene.root, `boot-status-${containerId.slice(0, 12)}.json`);
  await docker(["cp", `${containerId}:${BOOT_STATUS_PATH}`, target]);
  return JSON.parse(await fs.readFile(target, "utf8")) as {
    phase: string;
    failureCode: string;
  };
}

async function waitForExit(containerId: string): Promise<number> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const [running, code] = (
      await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", containerId])
    ).split(" ");
    if (running === "false") return Number(code);
    await Bun.sleep(250);
  }
  throw new Error("container kept running");
}

/**
 * Asserts a launch that failed readiness: a typed, actionable `not-ready`
 * failure; no setup, no agent launch, no boot accepted, and the operation
 * recorded as failed.
 */
function expectRefusedLaunch(
  fixture: ReturnType<typeof readinessContext>,
  environmentId: string,
  error: unknown,
  expected: {
    reason: "failed" | "timed-out";
    failureCodes: Array<string | null>;
  },
): void {
  expect(error).toBeInstanceOf(ContainerInitializationError);
  const failure = error as ContainerInitializationError;
  expect(failure.reason).toBe(expected.reason);
  expect(expected.failureCodes).toContain(failure.failureCode);
  expect(failure.message).toContain("ContainerLifecycleError:not-ready:");
  expect(failure.message).toMatch(/retry/i);
  const environment = fixture.environments.get(environmentId)!;
  expect(environment.status).toBe("error");
  expect(environment.lifecycleError).toBe(
    expected.reason === "failed"
      ? ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.initializationFailed
      : ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.initializationTimedOut,
  );
  // No false ready and nothing dispatched into the container.
  expect(environment.setupScriptsComplete).toBeFalsy();
  expect(
    fixture.writes.some(
      (write) =>
        write.environmentId === environmentId &&
        (write.update.setupPhase === "running" || write.update.setupPhase === "ready"),
    ),
  ).toBe(false);
  expect(environment.pendingAgentLaunch).toBe(false);
  expect(fixture.launches).toEqual([]);
  const record = lifecycleRecord(environment);
  expect(record.operation).toBeUndefined();
  expect(record.outcomes.at(-1)).toMatchObject({
    status: "failed",
    failureCode: "not-ready",
  });
  expect(record.boot?.phase).toBe("failed");
  expect(record.runtime?.bootId).toBeUndefined();
  expect(record.setup).toBeUndefined();
}

afterAll(async () => {
  if (!ENABLED) return;
  for (const cleanup of cleanups) await Promise.resolve(cleanup()).catch(() => undefined);
  const filters = [
    `label=${RUN_LABEL}`,
    ...scenarios.map((s) => `label=orkestrator-owner=${s.owner}`),
  ];
  const leftovers = await removeLabelledResources(docker, filters);
  for (const tag of derivedImages) await docker(["image", "rm", tag]).catch(() => undefined);
  for (const scene of scenarios) await fs.rm(scene.root, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 600_000);

describe("C09/readiness failure injection at the lifecycle boundary", () => {
  live(
    "C09/readiness: a missing firewall script fails a restricted boot before setup or agent launch",
    async () => {
      pinInContainerFirewall();
      const image = await deriveImage("no-firewall", [
        "USER root",
        "RUN rm /usr/local/bin/init-firewall.sh",
        "USER node",
      ]);
      const scene = await scenario({});
      const environment = launchingEnvironment(`env-${RUN}-nofw`);
      const fixture = readinessContext(scene, environment, { image });
      const error = await startEnvironment(environment.id, fixture.context).then(
        () => null,
        (failure: unknown) => failure,
      );
      // The entrypoint records the specific code and exits; the backend
      // surfaces it whether it reads the record before the container stops
      // or, with `docker cp`, from the stopped container.
      expectRefusedLaunch(fixture, environment.id, error, {
        reason: "failed",
        failureCodes: ["firewall-missing"],
      });
      const containerId = fixture.environments.get(environment.id)!.containerId!;
      expect(await waitForExit(containerId)).not.toBe(0);
      expect(await finalBootRecord(scene, containerId)).toMatchObject({
        phase: "failed",
        failureCode: "firewall-missing",
      });
      expect(await containerLogs(containerId)).toContain(
        "Restricted network requested but the firewall is not installed",
      );
      console.warn(
        `[C09/readiness] missing firewall: backend failureCode=${(error as ContainerInitializationError).failureCode}`,
      );
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "C09/readiness: a gateway that cannot apply its firewall refuses the start before the runtime boots",
    async () => {
      const image = await deriveImage("no-firewall", [
        "USER root",
        "RUN rm /usr/local/bin/init-firewall.sh",
        "USER node",
      ]);
      const scene = await scenario({});
      const environment = launchingEnvironment(`env-${RUN}-nofw-gw`);
      const fixture = readinessContext(scene, environment, { image });
      const error = await startEnvironment(environment.id, fixture.context).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("ContainerLifecycleError:not-ready");
      expect((error as Error).message).toContain("egress gateway could not apply");
      expect(fixture.launches).toHaveLength(0);
      // The runtime never started: it was never in an unenforced namespace.
      const containerId = fixture.environments.get(environment.id)!.containerId!;
      expect(await docker(["inspect", "-f", "{{.State.StartedAt}}", containerId])).toStartWith(
        "0001-01-01",
      );
      const { networkOwnerContainer } = await import("../src/core/container-network-owner");
      const gateway = await networkOwnerContainer(containerId);
      expect(gateway).not.toBe(containerId);
      expect(
        await docker(["exec", gateway, "cat", "/run/orkestrator-firewall/firewall.json"]),
      ).toContain('"state":"failed"');
      expect(await docker(["exec", gateway, "iptables", "-S", "OUTPUT"])).toStartWith(
        "-P OUTPUT DROP",
      );
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "C09/readiness: a DNS-broken network fails the firewall bootstrap closed, never network-ready",
    async () => {
      pinInContainerFirewall();
      const { NETWORK_ROLE, environmentNetworkName } =
        await import("../src/core/container-network");
      const scene = await scenario({});
      const environment = launchingEnvironment(`env-${RUN}-dns`);
      const fixture = readinessContext(scene, environment);
      // The environment network exists before the start, as an interrupted
      // earlier attempt would leave it, so the backend adopts it. It is
      // internal: Docker's resolver answers only local names and nothing
      // routes out, so the firewall's bootstrap cannot resolve or fetch.
      const network = environmentNetworkName(scene.owner, environment.id);
      await docker([
        "network",
        "create",
        "--internal",
        "--label",
        RUN_LABEL,
        "--label",
        "app=orkestrator-v2",
        "--label",
        `orkestrator-owner=${scene.owner}`,
        "--label",
        `environment-id=${environment.id}`,
        "--label",
        `orkestrator-resource-role=${NETWORK_ROLE}`,
        network,
      ]);
      // A listener on the same network detects an allow-all interval: it is
      // reachable from any container there that has no firewall.
      const peer = await docker([
        "run",
        "-d",
        "--label",
        RUN_LABEL,
        "--label",
        `orkestrator-owner=${scene.owner}`,
        "--network",
        network,
        "--entrypoint",
        "node",
        IMAGE,
        "-e",
        'require("node:net").createServer(s => s.end("peer\\n")).listen(18080, "0.0.0.0")',
      ]);
      const peerIp = await docker([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        peer,
      ]);
      const reach = `timeout 2 bash -c '</dev/tcp/${peerIp}/18080' 2>/dev/null && echo REACHED || echo BLOCKED`;
      let control = "";
      for (let attempt = 0; attempt < 20 && control !== "REACHED"; attempt += 1) {
        control = await docker([
          "run",
          "--rm",
          "--label",
          RUN_LABEL,
          "--label",
          `orkestrator-owner=${scene.owner}`,
          "--network",
          network,
          "--entrypoint",
          "bash",
          IMAGE,
          "-c",
          reach,
        ]);
        if (control !== "REACHED") await Bun.sleep(250);
      }
      expect(control).toBe("REACHED");

      const outcome = startEnvironment(environment.id, fixture.context).then(
        () => null,
        (failure: unknown) => failure,
      );
      // Sample the namespace while the boot runs: phase, OUTPUT policy and
      // whether the peer answers.
      const containerId = await containerOf(scene, environment.id);
      const samples: string[] = [];
      let settled = false;
      void outcome.finally(() => {
        settled = true;
      });
      while (!settled) {
        const sample = await docker([
          "exec",
          "--user",
          "root",
          containerId,
          "bash",
          "-c",
          `printf '%s|%s|' "$(sed -n 's/.*"phase":"\\([a-z-]*\\)".*/\\1/p' ${BOOT_STATUS_PATH} 2>/dev/null)" "$(iptables -S OUTPUT 2>/dev/null | head -n 1)"; ${reach}`,
        ]).catch(() => "");
        // Before the start and after the exit there is nothing to sample.
        if (sample) samples.push(sample);
        else await Bun.sleep(100);
      }
      const error = await outcome;
      expectRefusedLaunch(fixture, environment.id, error, {
        reason: "failed",
        failureCodes: ["firewall-failed"],
      });
      expect(await waitForExit(containerId)).not.toBe(0);
      expect(await finalBootRecord(scene, containerId)).toMatchObject({
        phase: "failed",
        failureCode: "firewall-failed",
      });
      expect(await containerLogs(containerId)).toContain(
        "Restricted-network firewall initialization failed",
      );
      // Never past initializing, and once the firewall had started its
      // policy, the peer was never reachable.
      for (const sample of samples) {
        const [phase, policy, reached] = sample.split("|");
        expect(["", "initializing"]).toContain(phase!);
        if (policy === "-P OUTPUT DROP") expect(reached).toBe("BLOCKED");
      }
      console.warn(
        `[C09/readiness] DNS-broken network: backend failureCode=${(error as ContainerInitializationError).failureCode} samples=${JSON.stringify(samples)}`,
      );
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "C09/readiness: a boot status directory the entrypoint cannot write fails the launch",
    async () => {
      // A permission fault: the status directory is root-owned, so the
      // entrypoint (node) cannot record any phase, not even `failed`.
      const image = await deriveImage("status-unwritable", [
        "USER root",
        "RUN chown root:root /run/orkestrator /run/orkestrator/processes && chmod 0755 /run/orkestrator",
        "USER node",
      ]);
      const scene = await scenario({});
      const environment = launchingEnvironment(`env-${RUN}-perm`);
      const fixture = readinessContext(scene, environment, { image });
      const error = await startEnvironment(environment.id, fixture.context).then(
        () => null,
        (failure: unknown) => failure,
      );
      expectRefusedLaunch(fixture, environment.id, error, {
        reason: "failed",
        failureCodes: ["container-exited"],
      });
      const containerId = fixture.environments.get(environment.id)!.containerId!;
      expect(await waitForExit(containerId)).not.toBe(0);
      // Nothing was recorded for the boot at all.
      await expect(finalBootRecord(scene, containerId)).rejects.toThrow();
      expect(await containerLogs(containerId)).toMatch(/permission denied/i);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "C09/readiness: an interrupted status write never releases readiness and times out typed",
    async () => {
      pinInContainerFirewall();
      const scene = await scenario({});
      const environment = launchingEnvironment(`env-${RUN}-torn`);
      const fixture = readinessContext(scene, environment, { image: await heldBootImage() });
      const started = Date.now();
      const outcome = startEnvironment(environment.id, fixture.context).then(
        () => null,
        (failure: unknown) => failure,
      );
      const containerId = await containerOf(scene, environment.id);
      // The writer stalls mid-boot (held at its firewall step) after an
      // interrupted write left a complete record that never got its rename
      // (the atomic writer's temporary file) and a `ready` record cut short
      // (what a non-atomic writer would leave). Both name the current PID 1.
      const held = await heldBoot(containerId);
      await docker([
        "exec",
        "--user",
        "root",
        containerId,
        "sh",
        "-c",
        [
          `f=${BOOT_STATUS_PATH}`,
          `ready=$(sed 's/"phase":"[a-z-]*"/"phase":"ready"/' "$f")`,
          `printf '%s\\n' "$ready" > "$f.4242.tmp"`,
          `printf '%s' "$ready" | head -c 48 > "$f.torn" && mv -f "$f.torn" "$f"`,
          `chown node:node "$f" "$f.4242.tmp"`,
        ].join("\n"),
      ]);
      const observations = new Set<string>();
      let settled = false;
      void outcome.finally(() => {
        settled = true;
      });
      while (!settled) {
        const observation = await observeContainerBoot(containerId);
        observations.add(
          observation.kind === "current" ? `current:${observation.phase}` : observation.kind,
        );
        await Bun.sleep(1_000);
      }
      const error = await outcome;
      expectRefusedLaunch(fixture, environment.id, error, {
        reason: "timed-out",
        failureCodes: [null],
      });
      // The full readiness budget elapsed with the torn record in place.
      expect(Date.now() - started).toBeGreaterThanOrEqual(120_000);
      expect([...observations]).toEqual(["pending"]);
      expect(await docker(["inspect", "-f", "{{.State.Running}}", containerId])).toBe("true");

      // Released, the writer replaces the torn record and the same boot
      // becomes ready; the stray temporary file never counted.
      await releaseBoot(containerId);
      expect(await waitForContainerBoot(containerId)).toBe(held.bootId);
      expect(
        await docker(["exec", containerId, "sh", "-c", `ls ${BOOT_STATUS_PATH}.4242.tmp`]),
      ).toBe(`${BOOT_STATUS_PATH}.4242.tmp`);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "C09/readiness: a container restart during launch never releases the previous boot",
    async () => {
      pinInContainerFirewall();
      const scene = await scenario({});
      const environment = launchingEnvironment(`env-${RUN}-restart`);
      const fixture = readinessContext(scene, environment, { image: await heldBootImage() });
      const outcome = startEnvironment(environment.id, fixture.context).then(
        (result) => ({ result, error: null as unknown }),
        (error: unknown) => ({ result: null, error }),
      );
      const containerId = await containerOf(scene, environment.id);
      // The first boot is held before `ready`, then Docker restarts the
      // container while the backend waits for it. (A restart of the whole
      // daemon is not run on a shared host.)
      const held = await heldBoot(containerId);
      await docker(["restart", "-t", "2", containerId]);
      let { error } = await outcome;
      let branch = "waited-for-new-boot";
      if (error) {
        // The backend saw the container stopped: a typed, retryable refusal
        // with nothing dispatched. The retry is explicit.
        branch = "refused-then-retried";
        // The restart's SIGTERM makes the held entrypoint record its exit,
        // which the stopped container's final record then reports.
        expectRefusedLaunch(fixture, environment.id, error, {
          reason: "failed",
          failureCodes: ["container-exited", "entrypoint-failed"],
        });
        ({ error } = await startEnvironment(environment.id, fixture.context).then(
          () => ({ error: null as unknown }),
          (retryError: unknown) => ({ error: retryError }),
        ));
        expect(error).toBeNull();
      }
      await fixture.context.runtime.environments.setupTask(environment.id);
      const ready = fixture.environments.get(environment.id)!;
      expect(ready.status).toBe("running");
      expect(ready.setupPhase).toBe("ready");
      const record = lifecycleRecord(ready);
      const bootId = record.runtime?.bootId;
      expect(bootId).toBeTruthy();
      expect(bootId).not.toBe(held.bootId);
      if (branch === "waited-for-new-boot") {
        // Exactly one agent launch, into the accepted (post-restart) boot.
        expect(fixture.launches).toHaveLength(1);
        expect(fixture.launches[0]!.boot).toMatchObject({
          kind: "current",
          phase: "ready",
          bootId,
        });
      } else {
        // The refused start dropped the launch intent; the retry only starts.
        expect(fixture.launches).toEqual([]);
      }
      expect(record.setup?.runtimeGeneration).toBe(record.runtime?.runtimeGeneration);

      // A restart after readiness but before the next dispatch: the
      // pre-dispatch recheck waits for the new boot, never the old one.
      await docker(["restart", "-t", "5", containerId]);
      const recheck = await ensureCurrentBootReady(containerId);
      expect(recheck).toBeTruthy();
      expect(recheck).not.toBe(bootId);
      console.warn(`[C09/readiness] restart during launch: branch=${branch}`);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C23/readiness firewall failure after boot", () => {
  live(
    "C23/readiness: a firewall re-run that loses DNS fails closed with no allow-all interval",
    async () => {
      pinInContainerFirewall();
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const { environmentNetworkPolicy } = await import("../src/core/container-network");
      const scene = await scenario();
      const environment = lifecycleEnvironment({ id: `env-${RUN}-rerun` });
      const fixture = readinessContext(scene, environment);
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
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);
      const network = await docker(["inspect", "-f", "{{.HostConfig.NetworkMode}}", containerId]);
      const peer = await docker([
        "run",
        "-d",
        "--label",
        RUN_LABEL,
        "--label",
        `orkestrator-owner=${scene.owner}`,
        "--network",
        network,
        "--entrypoint",
        "node",
        IMAGE,
        "-e",
        'require("node:net").createServer(s => s.end("peer\\n")).listen(18080, "0.0.0.0")',
      ]);
      const peerIp = await docker([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        peer,
      ]);
      const reach = `timeout 2 bash -c '</dev/tcp/${peerIp}/18080' 2>/dev/null && echo REACHED || echo BLOCKED`;
      // The peer answers (proved from itself), and the firewall blocks it.
      let control = "";
      for (let attempt = 0; attempt < 20 && control !== "REACHED"; attempt += 1) {
        control = await docker(["exec", peer, "bash", "-c", reach]).catch(() => "");
        if (control !== "REACHED") await Bun.sleep(250);
      }
      expect(control).toBe("REACHED");
      expect(await docker(["exec", containerId, "bash", "-c", reach])).toBe("BLOCKED");
      const before = await environmentNetworkPolicy(environment.id, fixture.context);
      expect(before.effective?.state).toBe("applied");

      // DNS goes to a resolver inside the container that never answers (Docker
      // Desktop answers DNS sent to any outside address itself, so only a
      // loopback resolver can be made silent), then the firewall is re-run as
      // root (node has no grant for it; the root entrypoint runs it at boot).
      await docker([
        "exec",
        "-d",
        "--user",
        "root",
        containerId,
        "node",
        "-e",
        'require("node:dgram").createSocket("udp4").bind(53, "127.0.0.53")',
      ]);
      await docker([
        "exec",
        "--user",
        "root",
        containerId,
        "sh",
        "-c",
        "printf 'nameserver 127.0.0.53\\noptions timeout:3 attempts:1\\n' > /etc/resolv.conf",
      ]);
      expect(
        await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          "getent ahostsv4 github.com >/dev/null && echo resolved || echo unresolved",
        ]),
      ).toBe("unresolved");
      await docker([
        "exec",
        "-d",
        "--user",
        "root",
        containerId,
        "sh",
        "-c",
        "/usr/local/bin/init-firewall.sh > /tmp/rerun.log 2>&1; echo $? > /tmp/rerun.rc",
      ]);
      const samples: string[] = [];
      let rc = "";
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const sample = await docker([
          "exec",
          "--user",
          "root",
          containerId,
          "bash",
          "-c",
          `printf '%s|' "$(iptables -w 5 -S OUTPUT 2>/dev/null | head -n 1)"; ${reach}; cat /tmp/rerun.rc 2>/dev/null || true`,
        ]).catch(() => "");
        const [head = "", tail = ""] = sample.split("\n");
        if (head) samples.push(head);
        if (tail) {
          rc = tail;
          break;
        }
      }
      expect(rc).not.toBe("");
      expect(rc).not.toBe("0");
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) expect(sample.split("|")[1]).toBe("BLOCKED");
      expect(
        await docker(["exec", "--user", "root", containerId, "iptables", "-S", "OUTPUT"]),
      ).toStartWith("-P OUTPUT DROP");
      expect(await docker(["exec", containerId, "bash", "-c", reach])).toBe("BLOCKED");
      const after = await environmentNetworkPolicy(environment.id, fixture.context);
      const log = await docker(["exec", containerId, "cat", "/tmp/rerun.log"]);
      console.warn(
        `[C23/readiness] re-run rc=${rc} samples=${samples.length} effective=${JSON.stringify(after.effective)} log-tail=${JSON.stringify(log.split("\n").slice(-3))}`,
      );
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C10 setup interrupted after a possible side effect", () => {
  live(
    "C10: a setup whose terminal dies after its side effect is failed, never ready, never rerun",
    async () => {
      const { setupTerminalSessionId } = await import("../src/core/commands-terminal");
      const scene = await scenario({
        setupContainer: "date +%s%N >> /home/node/.c10-side-effects && sleep 600",
      });
      const environment = launchingEnvironment(`env-${RUN}-c10`, {
        networkAccessMode: "full",
      });
      const fixture = readinessContext(scene, environment);
      const started = await startEnvironment(environment.id, fixture.context);
      expect(started.setupStarted).toBe(true);
      const containerId = fixture.environments.get(environment.id)!.containerId!;
      const sideEffects = async () =>
        Number(
          await docker([
            "exec",
            containerId,
            "sh",
            "-c",
            "wc -l < /home/node/.c10-side-effects 2>/dev/null || echo 0",
          ]),
        );
      const deadline = Date.now() + 300_000;
      while ((await sideEffects()) < 1) {
        if (Date.now() > deadline) throw new Error("setup never reached its side effect");
        await Bun.sleep(500);
      }

      // The durable record at this instant is what a backend that died now
      // would leave: setup running, not complete, no agent launched. Startup
      // fences exactly this state as failed (index.test.ts).
      const atCrash = structuredClone(fixture.environments.get(environment.id)!);
      expect(atCrash).toMatchObject({
        status: "running",
        setupPhase: "running",
      });
      expect(atCrash.setupScriptsComplete).toBeFalsy();
      expect(atCrash.setupOverride).toBeFalsy();
      expect(lifecycleRecord(atCrash).setup).toBeUndefined();
      expect(fixture.launches).toEqual([]);

      // The setup's controlling terminal process dies, as it does with the
      // backend.
      const pty = fixture.context.runtime.terminals.process(setupTerminalSessionId(environment.id));
      expect(pty).toBeDefined();
      process.kill(pty!.pid, "SIGKILL");
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if (fixture.environments.get(environment.id)!.setupPhase !== "running") break;
        await Bun.sleep(250);
      }
      await fixture.context.runtime.environments.setupTask(environment.id)?.catch(() => undefined);
      const failed = fixture.environments.get(environment.id)!;
      expect(failed.setupPhase).toBe("failed");
      expect(failed.status).toBe("error");
      expect(failed.setupScriptsComplete).toBeFalsy();
      expect(Object.values(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES) as string[]).toContain(
        failed.lifecycleError!,
      );
      expect(failed.pendingAgentLaunch).toBe(false);
      expect(fixture.launches).toEqual([]);
      expect(lifecycleRecord(failed).setup).toBeUndefined();
      expect(fixture.context.runtime.environments.setupTask(environment.id)).toBeUndefined();

      // Nothing reruns it: not the backend, not the container.
      await Bun.sleep(20_000);
      expect(await sideEffects()).toBe(1);
      expect(
        await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          "test -e /tmp/.workspace-setup-complete && echo yes || echo no",
        ]),
      ).toBe("no");
      const orphan = await docker([
        "exec",
        containerId,
        "sh",
        "-c",
        "ps -eo args= | grep -c '^sleep 600$' || true",
      ]);
      await docker(["restart", "-t", "5", containerId]);
      await waitForContainerBoot(containerId);
      await Bun.sleep(10_000);
      expect(await sideEffects()).toBe(1);
      expect(fixture.environments.get(environment.id)!.setupPhase).toBe("failed");
      expect(fixture.launches).toEqual([]);
      console.warn(`[C10] in-container setup still running after its terminal died: ${orphan}`);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C22 live host-service reply", () => {
  live(
    "C22: the agent tools port answers a restricted runtime; another host port is refused",
    async () => {
      const { StorageService } = await import("../src/core/storage");
      const { AgentToolsServer } = await import("../src/core/agent-tools");
      const {
        CONTAINER_HOST_PROBE_SCRIPT,
        ContainerHostReachabilityService,
        classifyProbeOutput,
        containerAgentToolsUrl,
      } = await import("../src/core/container-host-reachability");
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const scene = await scenario();
      // The real agent tools server, bound as the backend binds it.
      const storage = new StorageService(path.join(scene.root, "agent-tools"));
      await storage.init();
      const server = new AgentToolsServer(storage, "0.0.0.0");
      await server.start();
      cleanups.push(() => server.stop());
      const servicePort = server.servicePort()!;
      const other = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: () => new Response("other"),
      });
      cleanups.push(() => other.stop(true));

      const messages: string[] = [];
      const service = new ContainerHostReachabilityService({
        servicePort: () => servicePort,
        ownerNamespace: scene.owner,
        fallbackImage: () => IMAGE,
        log: { info: (line) => messages.push(line), warn: (line) => messages.push(line) },
      });
      const host = await service.check("manual");
      const environment = lifecycleEnvironment({ id: `env-${RUN}-c22` });
      const fixture = readinessContext(scene, environment, { servicePort });
      fixture.context.containerHostReachability = service;
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, fixture.context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      // As the backend starts it: the egress gateway (whose firewall holds the
      // host-service rule) first. Docker refuses the runtime before that.
      const { prepareEgressGatewayForStart } = await import("../src/core/egress-gateway");
      await prepareEgressGatewayForStart(containerId);
      await docker(["start", containerId]);
      try {
        await waitForContainerBoot(containerId);
      } catch (error) {
        // This credential-free boot has no server tokens or provider secrets.
        throw new Error(
          `C22 boot failed: ${error}\n${(await containerLogs(containerId)).slice(-8000)}`,
        );
      }

      const probe = await service.checkEnvironmentContainer(containerId, {
        reason: "qualification",
      });
      const open = host.status === "reachable" || probe?.outcome === "reachable";
      if (!open) {
        throw new Error(
          `INCOMPLETE: container-host-reachability reports the agent tools path closed on this host (host=${host.status}/${host.reason ?? ""}, container=${probe?.outcome ?? "none"} ${probe?.detail ?? ""}); the reply cannot be qualified here`,
        );
      }
      // An actual HTTP reply from the agent tools server: 405 to a GET...
      expect(probe).toMatchObject({ outcome: "reachable", httpStatus: 405 });
      // ...and an authenticated MCP call from the container user succeeds.
      const connection = server.connection(environment.id, "project-1", "container");
      expect(connection.url).toBe(containerAgentToolsUrl(servicePort));
      const reply = await docker([
        "exec",
        "-u",
        "node",
        "-e",
        `ORK_TOKEN=${connection.token}`,
        containerId,
        "sh",
        "-c",
        `curl -sS --max-time 10 -X POST -H "Authorization: Bearer $ORK_TOKEN" -H 'Accept: application/json, text/event-stream' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"tools/list"}' -w '\\nHTTP=%{http_code}' ${connection.url}`,
      ]);
      expect(reply).toContain("HTTP=200");
      expect(reply).toContain('"tools"');
      // Another port on the same host stays refused by the container firewall,
      // although its listener answers the host.
      const otherProbe = classifyProbeOutput(
        await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          CONTAINER_HOST_PROBE_SCRIPT,
          "orkestrator-probe",
          `http://host.docker.internal:${other.port}/`,
          "5",
        ]),
      );
      expect(otherProbe.outcome).toBe("refused");
      const hostAnswer = await runCommand(
        "curl",
        ["-sS", "--max-time", "5", `http://127.0.0.1:${other.port}/`],
        { timeoutMs: 15_000 },
      );
      expect(hostAnswer.stdout).toBe("other");
      console.warn(
        `[C22] host check status=${host.status} reason=${host.reason ?? ""}; container probe ${probe!.outcome} HTTP ${probe!.httpStatus} in ${probe!.elapsedMs}ms`,
      );
    },
    LIVE_TIMEOUT_MS,
  );
});
