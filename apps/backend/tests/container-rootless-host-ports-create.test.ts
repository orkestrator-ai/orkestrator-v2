import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "../src/core/agent-credential-files";
import { createDockerContainer } from "../src/core/commands-containers";
import { resetBackendHostPortReservations } from "../src/core/container-host-ports";
import { ingressPorts } from "../src/core/container-network";
import { resetNetworkOwnerCache } from "../src/core/container-network-owner";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

// Which container a rootless create gives backend-chosen host ports and the
// label to (to-do 7549 task 4), and that a rootful create is unchanged.

// Creates run the real create path against a fake `docker` script.
setDefaultTimeout(30_000);

const IMAGE_ID = `sha256:${"d".repeat(64)}`;
const LABEL = "orkestrator-backend-host-ports";

const cleanup: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string): void {
  if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(async () => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvironment.clear();
  resetNetworkOwnerCache();
  resetImageManifestCache();
  resetDockerTopologyCache();
  resetBackendHostPortReservations();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const dir = await tempDir(prefix);
  cleanup.push(dir);
  return dir;
}

async function manifestTar(capabilities: Record<string, number>): Promise<string> {
  const dir = await directory("ork-rootless-ports-tar-");
  await fs.writeFile(
    path.join(dir, "image-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "2.37.0",
      sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
      architecture: "amd64",
      runtimes: { bun: "1.4.4", node: "24.21.0" },
      agents: {},
      bridges: [],
      capabilities,
      stateFormats: {},
    }),
  );
  const tarPath = path.join(dir, "out.tar");
  const result = spawnSync(
    "tar",
    ["--format=ustar", "-cf", tarPath, "-C", dir, "image-manifest.json"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  expect(result.status).toBe(0);
  return tarPath;
}

function fakeDocker(tar: string, rootless: boolean, ownedLabels: string): string {
  const securityOptions = rootless ? '["name=seccomp,profile=builtin","name=rootless"]' : "[]";
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///run/user/1000/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","SecurityOptions":${securityOptions}}\\n' ;;
  create) printf 'created-%s\\n' "$3" ;;
  cp) cat '${tar}' ;;
  ps) printf '${ownedLabels}' ;;
  network) [ "$2" = inspect ] && { echo "network not found" >&2; exit 1; }; exit 0 ;;
esac
`;
}

async function fixture(capabilities: Record<string, number>) {
  const dataDir = await directory("ork-rootless-ports-data-");
  const environment = lifecycleEnvironment({
    portMappings: [
      { containerPort: 5173, hostPort: 45173, protocol: "tcp" },
      { containerPort: 3000, hostPort: 0, hostPortMode: "auto", protocol: "tcp" },
    ],
  });
  const { context } = memoryLifecycleContext([environment], dataDir);
  Object.assign(context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
  Object.assign(context.storage, {
    getProject: async () => ({
      id: "project-1",
      gitUrl: "https://example.invalid/project.git",
      localPath: null,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { enabledAgentPlatforms: [], allowedDomains: ["example.invalid"] },
      repositories: {},
    }),
  });
  await fs.writeFile(path.join(dataDir, "github-ranges.txt"), "# fixture\n203.0.113.0/24\n");
  const home = await directory("ork-rootless-ports-home-");
  setEnvironment("ORKESTRATOR_AGENT_TEST_HOST_HOME", home);
  setEnvironment(AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV, path.join(home, ".claude"));
  setEnvironment("CODEX_HOME", path.join(home, ".codex"));
  setEnvironment("GROK_HOME", path.join(home, ".grok"));
  setEnvironment("XDG_CONFIG_HOME", path.join(home, ".config"));
  setEnvironment("XDG_DATA_HOME", path.join(home, ".local", "share"));
  setEnvironment("XDG_STATE_HOME", path.join(home, ".local", "state"));
  return {
    tar: await manifestTar(capabilities),
    create: () => createDockerContainer(environment, context, { imageId: IMAGE_ID }),
  };
}

/** The `-p` values of one `docker create` line. */
function published(line: string): string[] {
  return [...line.matchAll(/ -p (\S+)/g)].map((match) => match[1]!);
}

function label(line: string): string | null {
  return new RegExp(` --label ${LABEL}=(\\S+)`).exec(line)?.[1] ?? null;
}

function ingress(line: string): string | null {
  return / -e ORKESTRATOR_INGRESS_PORTS=(\S*)/.exec(line)?.[1] ?? null;
}

const STAGED = { "network-policy": 3, "network-refresh": 1, "staged-inputs": 2 };

async function createLines(
  capabilities: Record<string, number>,
  rootless: boolean,
  ownedLabels = "",
): Promise<{ workload: string; gateway: string | null; docker: string }> {
  const { tar, create } = await fixture(capabilities);
  let result: { workload: string; gateway: string | null; docker: string } | null = null;
  await withDockerScript(fakeDocker(tar, rootless, ownedLabels), async (log) => {
    await create();
    const docker = await log.read();
    const creates = docker.split("\n").filter((entry) => entry.startsWith("create --name"));
    const gateway = creates.find((entry) =>
      / --label orkestrator-resource-role=egress-gateway /.test(entry),
    );
    const workload = creates.find(
      (entry) => entry !== gateway && / --label environment-id=/.test(entry),
    );
    expect(workload).toBeDefined();
    result = { workload: workload!, gateway: gateway ?? null, docker };
  });
  return result!;
}

describe("host ports of a new container", () => {
  test("a rootful create leaves automatic ports to Docker and adds no label", async () => {
    const { workload, docker } = await createLines(STAGED, false);
    expect(published(workload)).toContain("127.0.0.1::3000/tcp");
    expect(published(workload)).toContain("127.0.0.1:45173:5173/tcp");
    expect(label(workload)).toBeNull();
    // No owned-port listing on a rootful daemon. The lines themselves are
    // compared so a failure names which `ps` was issued (flake 9963).
    expect(docker.split("\n").filter((entry) => entry.startsWith("ps "))).toEqual([]);
  });

  test("a rootless create fixes every automatic port, labels them, and keeps ingress", async () => {
    const { workload, docker } = await createLines(STAGED, true, "40001\\n");
    const ports = published(workload);
    expect(ports).toContain("127.0.0.1:45173:5173/tcp");
    expect(ports.some((value) => value.startsWith("127.0.0.1::"))).toBe(false);
    const chosen = label(workload)!.split(",").map(Number);
    const automatic = ports.filter((value) => value !== "127.0.0.1:45173:5173/tcp");
    expect(chosen).toHaveLength(automatic.length);
    expect(automatic.map((value) => Number(value.split(":")[1]))).toEqual(chosen);
    // Never the request's fixed port, nor a port another owned container holds.
    expect(chosen).not.toContain(45173);
    expect(chosen).not.toContain(40001);
    // The firewall's ingress rule still names container ports, not host ports.
    expect(ingress(workload)!.split(",").map(Number)).toEqual(
      ingressPorts(ports.flatMap((value) => ["-p", value])),
    );
    expect(ingress(workload)!.split(",")).toContain("3000");
    expect(docker).toContain(`ps -a --filter label=orkestrator-owner=`);
  });

  test("with an egress gateway, only the gateway publishes and carries the label", async () => {
    const { workload, gateway } = await createLines({ ...STAGED, "egress-gateway": 1 }, true);
    expect(gateway).not.toBeNull();
    expect(published(workload)).toEqual([]);
    expect(label(workload)).toBeNull();
    const ports = published(gateway!);
    expect(ports).toContain("127.0.0.1:45173:5173/tcp");
    expect(ports.some((value) => value.startsWith("127.0.0.1::"))).toBe(false);
    expect(label(gateway!)).not.toBeNull();
    expect(ingress(gateway!)!.split(",")).toContain("3000");
  });
});
