import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  IMAGE_CAPABILITIES,
  MAX_IMAGE_MANIFEST_BYTES,
  formatCapabilityLabel,
  missingImageCapabilities,
  parseImageManifest,
} from "@orkestrator/protocol/image-manifest";
import {
  classifyDockerEndpoint,
  detectDockerTopology,
  extractSingleTarFile,
  getImageStatus,
  readImageManifest,
  resetDockerTopologyCache,
  resetImageManifestCache,
  resolveDockerImage,
} from "../../../apps/backend/src/core/docker-image";
import { resolveOperationImage } from "../../../apps/backend/src/core/commands-environment";
import { shouldAddDockerHostGatewayAlias } from "../../../apps/backend/src/core/commands-container-exec";
import {
  probeCapabilities,
  CONTRACT_FILES,
  reportedVersion,
  verifiedAgentVersion,
} from "../../../docker/image-manifest";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetImageManifestCache();
  resetDockerTopologyCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const DIGEST = `sha256:${"d".repeat(64)}`;

function validManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    appVersion: "2.17.0",
    sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
    architecture: "amd64",
    runtimes: { bun: "1.4.2", node: "24.21.0" },
    agents: { claude: "2.1.280" },
    bridges: ["claude-bridge"],
    capabilities: { "workspace-prepare": 1, "future-capability": 3 },
    stateFormats: {},
    ...overrides,
  });
}

async function tarOf(fileName: string, content: string, options: { symlink?: boolean } = {}) {
  const dir = await tempDir("ork-image-tar-");
  cleanup.push(dir);
  if (options.symlink) await fs.symlink("/etc/passwd", path.join(dir, fileName));
  else await fs.writeFile(path.join(dir, fileName), content);
  const tarPath = path.join(dir, "out.tar");
  const result = spawnSync("tar", ["-cf", tarPath, "-C", dir, fileName]);
  expect(result.status).toBe(0);
  return tarPath;
}

describe("image manifest contract", () => {
  test("parses a valid manifest and drops unknown capabilities", () => {
    const parsed = parseImageManifest(validManifest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.capabilities).toEqual({ "workspace-prepare": 1 });
    expect(missingImageCapabilities(parsed.manifest, { "workspace-prepare": 1 })).toEqual([]);
    expect(missingImageCapabilities(parsed.manifest, { "boot-status": 1 })).toEqual([
      "boot-status",
    ]);
    // A legacy image never gains a capability by default.
    expect(missingImageCapabilities(null, { "workspace-prepare": 1 })).toEqual([
      "workspace-prepare",
    ]);
  });

  test("rejects truncated, unknown-version, oversized and unsafe manifests", () => {
    expect(parseImageManifest(validManifest().slice(0, 40))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseImageManifest(validManifest({ schemaVersion: 9 }))).toEqual({
      ok: false,
      reason: "unsupported-schema",
    });
    expect(parseImageManifest(" ".repeat(MAX_IMAGE_MANIFEST_BYTES + 1))).toEqual({
      ok: false,
      reason: "oversized",
    });
    // Host paths and free text are not representable in manifest fields.
    const unsafe = parseImageManifest(
      validManifest({ agents: { claude: "/home/user/.token secret" } }),
    );
    expect(unsafe.ok && unsafe.manifest.agents).toEqual({});
  });

  test("extracts one regular file from a tar stream and refuses anything else", async () => {
    const tar = await fs.readFile(await tarOf("image-manifest.json", validManifest()));
    const extracted = extractSingleTarFile(tar, MAX_IMAGE_MANIFEST_BYTES);
    expect(extracted.ok && JSON.parse(extracted.content).appVersion).toBe("2.17.0");
    const link = await fs.readFile(await tarOf("image-manifest.json", "", { symlink: true }));
    expect(extractSingleTarFile(link, MAX_IMAGE_MANIFEST_BYTES)).toEqual({
      ok: false,
      reason: "not-a-regular-file",
    });
    expect(extractSingleTarFile(tar, 10)).toEqual({ ok: false, reason: "oversized" });
    expect(extractSingleTarFile(tar.subarray(0, 600), MAX_IMAGE_MANIFEST_BYTES)).toEqual({
      ok: false,
      reason: "truncated",
    });
  });

  test("declares only capabilities whose marker is installed", () => {
    const files = new Map([
      ["/usr/local/bin/workspace-setup.sh", "# ORKESTRATOR_CAPABILITY workspace-prepare=1\n"],
      ["/usr/local/bin/entrypoint.sh", "echo no markers here\n"],
    ]);
    const capabilities = probeCapabilities((file) => files.get(file.installed) ?? null);
    expect(capabilities).toEqual({ "workspace-prepare": 1 });
    expect(formatCapabilityLabel(capabilities)).toBe("workspace-prepare=1");
    expect(() => probeCapabilities(() => "# ORKESTRATOR_CAPABILITY invented=1\n")).toThrow(
      "Unknown capability marker",
    );
    expect(() =>
      probeCapabilities(
        () =>
          `# ORKESTRATOR_CAPABILITY workspace-prepare=${IMAGE_CAPABILITIES["workspace-prepare"] + 1}\n`,
      ),
    ).toThrow("newer than the contract");
    // Every contract source path exists in the repository or is reserved for
    // a later step; none point outside docker/.
    for (const file of CONTRACT_FILES) expect(file.source.startsWith("docker/")).toBe(true);
  });
});

describe("image identity", () => {
  test("resolves a tag to its immutable id and registry digest", async () => {
    await withDockerScript(
      `#!/bin/sh
case "$*" in
  *"image inspect"*missing*) printf 'Error: No such image: missing\\n' >&2; exit 1 ;;
  *"image inspect"*) printf '%s\\t["ghcr.io/o/r@${DIGEST}"]\\tamd64\\n' '${IMAGE_ID}' ;;
esac
`,
      async () => {
        expect(await resolveDockerImage("orkestrator-v2:latest")).toEqual({
          kind: "present",
          imageRef: "orkestrator-v2:latest",
          imageId: IMAGE_ID,
          registryDigest: DIGEST,
          architecture: "amd64",
        });
        expect(await resolveDockerImage("missing")).toEqual({
          kind: "missing",
          imageRef: "missing",
        });
        await expect(resolveOperationImage({ dockerImage: "missing" })).rejects.toThrow(
          "No such image",
        );
        // The persisted id, not the tag, is what a create uses.
        expect(await resolveOperationImage({ dockerImage: "orkestrator-v2:latest" })).toEqual({
          imageRef: "orkestrator-v2:latest",
          imageId: IMAGE_ID,
          registryDigest: DIGEST,
        });
      },
    );
  });

  test("reads the manifest from a never-started probe container and removes it", async () => {
    const dir = await tempDir("ork-image-probe-");
    cleanup.push(dir);
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    const tarPath = await tarOf("image-manifest.json", validManifest());
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create) printf 'probe-container\\n' ;;
  cp) cat '${tarPath}' ;;
  rm) exit 0 ;;
  start|run|exec) printf 'must not run\\n' >&2; exit 9 ;;
esac
`,
      async (log) => {
        const read = await readImageManifest(IMAGE_ID, context);
        expect(read.kind).toBe("manifest");
        const calls = await log.read();
        expect(calls).toContain("--network none");
        expect(calls).toContain("orkestrator-resource-role=manifest-probe");
        expect(calls).toContain(
          "cp probe-container:/usr/local/share/orkestrator/image-manifest.json -",
        );
        expect(calls).toContain("rm -f probe-container");
        expect(calls).not.toMatch(/^(start|run|exec) /m);
        // Cached by immutable id: a second read does not create another probe.
        await readImageManifest(IMAGE_ID, context);
        expect((await log.read()).match(/^create /gm)).toHaveLength(1);
      },
    );
  });

  test("classifies a legacy image and reports compatibility", async () => {
    const dir = await tempDir("ork-image-status-");
    cleanup.push(dir);
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    await withDockerScript(
      `#!/bin/sh
case "$*" in
  *"image inspect"*) printf '%s\\t[]\\tarm64\\n' '${IMAGE_ID}' ;;
  create*) printf 'probe\\n' ;;
  cp*) printf 'Error response from daemon: Could not find the file /usr/local/share/orkestrator/image-manifest.json in container probe\\n' >&2; exit 1 ;;
esac
`,
      async () => {
        const status = await getImageStatus(context);
        expect(status.state).toBe("legacy");
        expect(status.imageId).toBe(IMAGE_ID);
        expect(status.registryDigest).toBeNull();
        expect(status.missingCapabilities).toEqual(["workspace-prepare"]);
        expect(status.remediation).toContain("predates image manifests");
      },
    );
  });
});

describe("daemon topology", () => {
  test("classifies endpoints without trusting an unset DOCKER_HOST", () => {
    expect(classifyDockerEndpoint("unix:///var/run/docker.sock", "Debian")).toBe("local-engine");
    expect(
      classifyDockerEndpoint("unix:///Users/me/.docker/run/docker.sock", "Docker Desktop"),
    ).toBe("desktop");
    expect(classifyDockerEndpoint("tcp://127.0.0.1:2375", "Ubuntu")).toBe("local-engine");
    expect(classifyDockerEndpoint("tcp://build-host.internal:2376", "Ubuntu")).toBe("remote");
    expect(classifyDockerEndpoint("ssh://user@build-host", "Ubuntu")).toBe("remote");
    expect(shouldAddDockerHostGatewayAlias("linux", "local-engine")).toBe(true);
    expect(shouldAddDockerHostGatewayAlias("linux", "desktop")).toBe(false);
    expect(shouldAddDockerHostGatewayAlias("darwin", "desktop")).toBe(false);
  });

  test("reports rootless and remote daemons without exposing the endpoint", async () => {
    await withDockerScript(
      `#!/bin/sh
case "$1" in
  context) printf 'ssh://secret-user@private-host\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Ubuntu","Architecture":"aarch64","ServerVersion":"27.0.1","SecurityOptions":["name=seccomp","name=rootless"]}\\n' ;;
esac
`,
      async () => {
        const topology = await detectDockerTopology({ refresh: true });
        expect(topology).toMatchObject({
          kind: "remote",
          rootless: true,
          supportsLocalResources: false,
          serverVersion: "27.0.1",
        });
        expect(JSON.stringify(topology)).not.toContain("secret-user");
        expect(JSON.stringify(topology)).not.toContain("private-host");
      },
    );
  });
});

describe("topology gate", () => {
  test("an unsupported remote daemon is refused before anything is created", async () => {
    const dir = await tempDir("ork-topology-gate-");
    cleanup.push(dir);
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    Object.assign(context.storage, {
      getProject: async () => ({
        id: "project-1",
        name: "Project",
        gitUrl: "https://github.com/example/project.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      }),
      loadConfig: async () => ({
        version: "1.0.0",
        global: { allowedDomains: [] },
        repositories: {},
      }),
    });
    const { createDockerContainer } =
      await import("../../../apps/backend/src/core/commands-containers");
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'tcp://10.0.0.5:2376\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Ubuntu","Architecture":"x86_64","ServerVersion":"27.0.1","SecurityOptions":[]}\\n' ;;
esac
`,
      async (log) => {
        await expect(createDockerContainer(lifecycleEnvironment(), context)).rejects.toThrow(
          "ContainerLifecycleError:unsupported-topology",
        );
        expect(await log.read()).not.toMatch(/^create /m);
      },
    );
  });
});

describe("pinned image identity", () => {
  test("a create uses the id resolved at admission even after the tag moves", async () => {
    const dir = await tempDir("ork-pinned-image-");
    cleanup.push(dir);
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    Object.assign(context.storage, {
      getProject: async () => ({
        id: "project-1",
        name: "Project",
        gitUrl: "https://github.com/example/project.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      }),
      loadConfig: async () => ({
        version: "1.0.0",
        global: { allowedDomains: [] },
        repositories: {},
      }),
    });
    const { createDockerContainer } =
      await import("../../../apps/backend/src/core/commands-containers");
    const retagged = `sha256:${"e".repeat(64)}`;
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  image) printf '%s\\t[]\\tamd64\\n' '${retagged}' ;;
  create) printf 'created-from-pinned\\n' ;;
esac
`,
      async (log) => {
        await createDockerContainer(lifecycleEnvironment(), context, {
          imageId: IMAGE_ID,
          operationId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
          runtimeGeneration: 2,
        });
        const create = (await log.read())
          .split("\n")
          .find((line) => line.startsWith("create --name"));
        expect(create?.endsWith(IMAGE_ID)).toBe(true);
        expect(create).not.toContain(retagged);
        expect(create).toContain("orkestrator-runtime-generation=2");
        expect(create).toContain("orkestrator-operation-id=0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
        expect(create).toMatch(/--name ork-[0-9a-f]{16}-env-lifecycle-g2 /);
        // Restricted runtimes get the capability the firewall needs...
        expect(create).toContain("--cap-add NET_ADMIN");
        await fs.writeFile(log.path, "");
        await createDockerContainer(lifecycleEnvironment({ networkAccessMode: "full" }), context, {
          imageId: IMAGE_ID,
          runtimeGeneration: 3,
        });
        const full = (await log.read())
          .split("\n")
          .find((line) => line.startsWith("create --name"));
        // ...and full access, which never runs it, does not.
        expect(full).toBeTruthy();
        expect(full).not.toContain("NET_ADMIN");
      },
    );
  });
});

describe("registry digests", () => {
  test("a local build's repo digest is not reported as a registry digest", async () => {
    await withDockerScript(
      `#!/bin/sh
case "$*" in
  *local-only*) printf '%s\\t["local-only@${IMAGE_ID}"]\\tamd64\\n' '${IMAGE_ID}' ;;
  *) printf '%s\\t["local-only@${IMAGE_ID}","ghcr.io/owner/repo@${DIGEST}"]\\tarm64\\n' '${IMAGE_ID}' ;;
esac
`,
      async () => {
        expect(await resolveDockerImage("local-only:latest")).toMatchObject({
          registryDigest: null,
        });
        expect(await resolveDockerImage("ghcr.io/owner/repo:2.17.0")).toMatchObject({
          registryDigest: DIGEST,
          architecture: "arm64",
        });
      },
    );
  });
});

describe("manifest versions come from the installed binaries", () => {
  test("a CLI's reported version must match the image's pin", () => {
    expect(reportedVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
    expect(reportedVersion("codex-cli 0.155.1")).toBe("0.155.1");
    expect(reportedVersion("grok 1.0.41 (4220f3b224a6)")).toBe("1.0.41");
    expect(reportedVersion("Version 1.63.0")).toBe("1.63.0");
    expect(verifiedAgentVersion("node", "24.21.0", () => "v24.21.0\n")).toBe("24.21.0");
    expect(() => verifiedAgentVersion("claude", "2.1.280", () => "2.1.279 (Claude Code)")).toThrow(
      "claude reports 2.1.279; the image pins 2.1.280",
    );
    expect(() => verifiedAgentVersion("pi", "0.87.0", () => null)).toThrow("no version");
    // Unpinned: whatever is installed, or unknown.
    expect(verifiedAgentVersion("x", "unknown", () => "x 3.2.1")).toBe("3.2.1");
    expect(verifiedAgentVersion("x", "unknown", () => null)).toBe("unknown");
  });
});

describe("storage formats an image may write", () => {
  test("volume storage needs the image to declare it writes every role's current version", async () => {
    const { imageWritesVolumeStorage } =
      await import("../../../apps/backend/src/core/docker-image");
    const both = { read: [1], write: [1] };
    expect(imageWritesVolumeStorage({ workspace: both, "provider-state": both })).toBe(true);
    expect(imageWritesVolumeStorage({ workspace: both })).toBe(false);
    expect(
      imageWritesVolumeStorage({ workspace: both, "provider-state": { read: [1], write: [] } }),
    ).toBe(false);
    expect(imageWritesVolumeStorage({})).toBe(false);
    expect(imageWritesVolumeStorage(null)).toBe(false);
  });
});
