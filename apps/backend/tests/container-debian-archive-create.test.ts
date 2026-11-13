import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "../src/core/agent-credential-files";
import { createDockerContainer } from "../src/core/commands-containers";
import { resetBackendHostPortReservations } from "../src/core/container-host-ports";
import { resetNetworkOwnerCache } from "../src/core/container-network-owner";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import type { Environment } from "../src/core/models.js";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

// Which new runtimes reach Debian's archive (to-do 7770): createDockerContainer
// adds deb.debian.org to the workload's and the gateway's ALLOWED_DOMAINS and
// labels the runtime orkestrator-debian-archive=1 only for a restricted
// runtime behind an egress gateway, from an image with apt-packages=1, whose
// project's checkout declares packages setup would install. Every other case
// leaves the allowlist and the labels as they were. The opt-in live suite
// (container-live-apt-packages.test.ts) installs through the result.

// Creates run the real create path against a fake `docker` script.
setDefaultTimeout(30_000);

const IMAGE_ID = `sha256:${"e".repeat(64)}`;
const BRANCH = "apt-create";
const ARCHIVE_LABEL = "--label orkestrator-debian-archive=1";

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
  const dir = await directory("ork-archive-create-tar-");
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

/** A host checkout whose `apt-create` branch holds this orkestrator-ai.json, or none. */
async function checkout(config: Record<string, unknown> | null): Promise<string> {
  const repo = await directory("ork-archive-create-repo-");
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  };
  git("init", "-q", "-b", BRANCH);
  await fs.writeFile(
    path.join(repo, config ? "orkestrator-ai.json" : "README.md"),
    config ? JSON.stringify(config) : "fixture\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return repo;
}

function fakeDocker(tar: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","SecurityOptions":[]}\\n' ;;
  create) printf 'created-%s\\n' "$3" ;;
  cp) cat '${tar}' ;;
  ps) ;;
  network) [ "$2" = inspect ] && { echo "network not found" >&2; exit 1; }; exit 0 ;;
esac
`;
}

interface Created {
  workload: string;
  gateway: string | null;
}

async function create(input: {
  capabilities: Record<string, number>;
  networkAccessMode?: Environment["networkAccessMode"];
  config: Record<string, unknown> | null;
}): Promise<Created> {
  const dataDir = await directory("ork-archive-create-data-");
  const environment = lifecycleEnvironment({
    branch: BRANCH,
    networkAccessMode: input.networkAccessMode ?? "restricted",
    allowedDomains: ["example.invalid"],
  });
  const localPath = await checkout(input.config);
  const { context } = memoryLifecycleContext([environment], dataDir);
  Object.assign(context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
  Object.assign(context.storage, {
    getProject: async () => ({
      id: "project-1",
      // Not a remote URL: the create path runs no host-side Git mirror.
      gitUrl: "file:///nonexistent/none.git",
      localPath,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { enabledAgentPlatforms: [], allowedDomains: ["example.invalid"] },
      repositories: {},
    }),
  });
  await fs.writeFile(path.join(dataDir, "github-ranges.txt"), "# fixture\n203.0.113.0/24\n");
  const home = await directory("ork-archive-create-home-");
  setEnvironment("ORKESTRATOR_AGENT_TEST_HOST_HOME", home);
  setEnvironment(AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV, path.join(home, ".claude"));
  setEnvironment("CODEX_HOME", path.join(home, ".codex"));
  setEnvironment("GROK_HOME", path.join(home, ".grok"));
  setEnvironment("XDG_CONFIG_HOME", path.join(home, ".config"));
  setEnvironment("XDG_DATA_HOME", path.join(home, ".local", "share"));
  setEnvironment("XDG_STATE_HOME", path.join(home, ".local", "state"));
  const tar = await manifestTar(input.capabilities);
  let created: Created | null = null;
  await withDockerScript(fakeDocker(tar), async (log) => {
    await createDockerContainer(environment, context, { imageId: IMAGE_ID });
    const creates = (await log.read())
      .split("\n")
      .filter((entry) => entry.startsWith("create --name"));
    const gateway =
      creates.find((entry) => / --label orkestrator-resource-role=egress-gateway /.test(entry)) ??
      null;
    const workload = creates.find(
      (entry) => entry !== gateway && / --label environment-id=/.test(entry),
    );
    expect(workload).toBeDefined();
    created = { workload: workload!, gateway };
  });
  return created!;
}

function allowedDomains(line: string | null): string[] | null {
  if (!line) return null;
  const value = / -e ALLOWED_DOMAINS=(\S*)/.exec(line)?.[1];
  return value === undefined ? null : value.split(",");
}

const GATEWAY_IMAGE = {
  "network-policy": 3,
  "network-refresh": 1,
  "staged-inputs": 2,
  "egress-gateway": 1,
  "apt-packages": 1,
};
const DECLARES = { aptPackages: ["libvips-dev"] };

describe("Debian's archive for a new runtime (to-do 7770)", () => {
  test("a restricted gateway runtime for a declaring project gets the archive and the label", async () => {
    const { workload, gateway } = await create({ capabilities: GATEWAY_IMAGE, config: DECLARES });
    expect(gateway).not.toBeNull();
    expect(workload).toContain(ARCHIVE_LABEL);
    expect(allowedDomains(gateway)).toContain("deb.debian.org");
    // The workload's own copy, which its firewall status and refresh read.
    expect(allowedDomains(workload)).toContain("deb.debian.org");
  });

  for (const [label, input] of [
    [
      "full network access",
      { capabilities: GATEWAY_IMAGE, networkAccessMode: "full", config: DECLARES },
    ],
    [
      "an in-container firewall",
      { capabilities: { ...GATEWAY_IMAGE, "egress-gateway": 0 }, config: DECLARES },
    ],
    [
      "an image without the installer",
      { capabilities: { ...GATEWAY_IMAGE, "apt-packages": 0 }, config: DECLARES },
    ],
    [
      "a project without the field",
      { capabilities: GATEWAY_IMAGE, config: { setupContainer: ["true"] } },
    ],
    ["a project with no orkestrator-ai.json", { capabilities: GATEWAY_IMAGE, config: null }],
    [
      "a list setup refuses outright",
      { capabilities: GATEWAY_IMAGE, config: { aptPackages: ["libvips-dev", "sudo"] } },
    ],
    ["an invalid field", { capabilities: GATEWAY_IMAGE, config: { aptPackages: "libvips-dev" } }],
  ] as const) {
    test(`${label} leaves the allowlist and the labels unchanged`, async () => {
      const { workload, gateway } = await create(input);
      expect(workload).not.toContain("orkestrator-debian-archive");
      expect(gateway ?? "").not.toContain("orkestrator-debian-archive");
      expect(allowedDomains(workload) ?? []).not.toContain("deb.debian.org");
      expect(allowedDomains(gateway) ?? []).not.toContain("deb.debian.org");
      if (input.networkAccessMode !== "full") {
        // The rest of the allowlist is still there.
        expect(allowedDomains(workload)).toContain("example.invalid");
      }
    });
  }
});
