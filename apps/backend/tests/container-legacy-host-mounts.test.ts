/**
 * Images from before staged inputs (security finding M9): no new container
 * from one, while a runtime already in that shape keeps running until the user
 * rebuilds it. Every Docker call here is a fake, and `HOME` is a fixture, so
 * nothing reads the developer's real agent homes or Git configuration.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startAssignedContainerRuntimeTask } from "../src/core/commands-environment";
import { createDockerContainer } from "../src/core/commands-containers";
import {
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  environmentLifecycleErrorMessage,
} from "../src/core/commands-error-text";
import { resetResourceCaches } from "../src/core/container-resources";
import { rebuildPreview } from "../src/core/container-replacement";
import { previewDockerCleanup } from "../src/core/docker-cleanup-preview";
import { legacyExposures } from "../src/core/legacy-runtime-shape";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import { environmentInputStatus } from "../src/core/portable-input-status";
import {
  FIXTURE_IMAGE_ID,
  imageManifestArchive,
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const IMAGE_NAME = "orkestrator-v2:latest (cccccccccccc)";
const HOST_HOME_ENTRIES = [".claude", ".codex", ".pi", ".claude.json", ".gitconfig"];

let dir = "";
let home = "";
const originalHome = process.env.HOME;

beforeEach(async () => {
  dir = await tempDir("ork-legacy-mounts-");
  home = path.join(dir, "home");
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(path.join(home, ".pi"), { recursive: true });
  await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude.json"), "{}");
  await fs.writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = fixture\n");
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetResourceCaches();
  resetDockerTopologyCache();
  resetImageManifestCache();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A context outside agent-test, the shape that used to get the home mounts. */
function creationContext(environment = lifecycleEnvironment({ networkAccessMode: "full" })) {
  const fixture = memoryLifecycleContext([environment], dir);
  Object.assign(fixture.context, { runtimeFlavor: undefined, credentialSources: undefined });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      gitUrl: "https://example.invalid/repo.git",
      localPath: null,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: {
        enabledAgentPlatforms: ["claude", "codex", "pi", "opencode"],
        anthropicApiKey: "fixture-anthropic-key",
      },
      repositories: {},
    }),
  });
  return { ...fixture, environment };
}

function daemonScript(cp: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  create)
    case "$*" in
      *manifest-probe*) printf 'manifest-probe\\n' ;;
      *) printf 'created-container\\n' ;;
    esac ;;
  cp) ${cp} ;;
esac
exit 0
`;
}

const NO_MANIFEST = `printf 'Error response from daemon: Could not find the file /usr/local/share/orkestrator/image-manifest.json in container probe\\n' >&2; exit 1`;

describe("creating a container", () => {
  for (const [name, cp] of [
    ["has no manifest", async () => NO_MANIFEST],
    [
      "declares no staged inputs",
      async () =>
        `cat '${await imageManifestArchive(dir, { "persistent-workspace": 1, "network-policy": 3 })}'`,
    ],
  ] as const) {
    test(`an image that ${name} is refused by name and nothing is mounted`, async () => {
      const { context, environment } = creationContext();
      const script = daemonScript(await cp());
      await withDockerScript(script, async (log) => {
        let refusal: Error | undefined;
        await createDockerContainer(environment, context, {
          imageId: FIXTURE_IMAGE_ID,
        }).catch((error: Error) => {
          refusal = error;
        });
        expect(refusal?.message).toContain("ContainerLifecycleError:capability-unavailable:");
        expect(refusal?.message).toContain(IMAGE_NAME);
        expect(refusal?.message).toContain("Nothing was created");
        expect(refusal?.message).toContain("current image");
        // What a failed start persists for the environment names it too.
        expect(environmentLifecycleErrorMessage(refusal)).toContain(IMAGE_NAME);

        const calls = await log.read();
        expect(calls).not.toMatch(/^create --name/m);
        expect(calls).not.toMatch(/^(network create|volume create|run) /m);
        for (const entry of HOST_HOME_ENTRIES) {
          expect(calls).not.toContain(path.join(home, entry));
        }
        expect(calls).not.toContain("/tmp/gitconfig");
      });
      // Nothing was staged for a container that does not exist.
      await expect(fs.stat(path.join(dir, "environment-inputs"))).rejects.toThrow();
    });
  }

  test("a newer manifest is refused without claiming the image is old", async () => {
    const { context, environment } = creationContext();
    const archive = await imageManifestArchive(dir, { "staged-inputs": 5 }, 999);
    await withDockerScript(daemonScript(`cat '${archive}'`), async (log) => {
      let refusal: Error | undefined;
      await createDockerContainer(environment, context, { imageId: FIXTURE_IMAGE_ID }).catch(
        (error: Error) => {
          refusal = error;
        },
      );
      expect(refusal?.message).toContain("ContainerLifecycleError:capability-unavailable:");
      expect(refusal?.message).toContain(IMAGE_NAME);
      expect(refusal?.message).toContain("cannot be used by this Orkestrator version");
      expect(refusal?.message).not.toContain("too old");
      expect(await log.read()).not.toMatch(/^create --name/m);
    });
    await expect(fs.stat(path.join(dir, "environment-inputs"))).rejects.toThrow();
  });

  test("an image Docker cannot read is not called old and is not created from", async () => {
    const { context, environment } = creationContext();
    await withDockerScript(
      daemonScript(`printf 'Cannot connect to the Docker daemon\\n' >&2; exit 1`),
      async (log) => {
        let refusal: Error | undefined;
        await createDockerContainer(environment, context, {
          imageId: FIXTURE_IMAGE_ID,
        }).catch((error: Error) => {
          refusal = error;
        });
        expect(refusal?.message).toContain("ContainerLifecycleError:daemon-unavailable:");
        expect(refusal?.message).not.toContain("too old");
        expect(environmentLifecycleErrorMessage(refusal)).toBe(
          ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
        );
        expect(await log.read()).not.toMatch(/^create --name/m);
      },
    );
  });

  test("an image that could not be resolved is not created from", async () => {
    const { context, environment } = creationContext();
    await withDockerScript(daemonScript("exit 1"), async (log) => {
      await expect(createDockerContainer(environment, context)).rejects.toThrow(
        "ContainerLifecycleError:daemon-unavailable:",
      );
      expect(await log.read()).not.toMatch(/^create /m);
    });
  });

  test("a current image is created as before, with staged inputs and no home mounts", async () => {
    const { context, environment } = creationContext();
    const archive = await imageManifestArchive(dir, { "staged-inputs": 5, "boot-status": 1 });
    await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "fixture memory\n");
    await withDockerScript(daemonScript(`cat '${archive}'`), async (log) => {
      expect(await createDockerContainer(environment, context, { imageId: FIXTURE_IMAGE_ID })).toBe(
        "created-container",
      );
      const create = (await log.read())
        .split("\n")
        .find((line) => line.startsWith("create --name"));
      expect(create).toBeTruthy();
      expect(create?.endsWith(FIXTURE_IMAGE_ID)).toBe(true);
      expect(create).toContain("--label orkestrator-inputs-revision=");
      expect(create).toMatch(/--mount type=bind,src=[^,]+,dst=\/claude-config,readonly/);
      expect(create).toContain("-e NETWORK_MODE=full");
      for (const entry of HOST_HOME_ENTRIES) {
        expect(create).not.toContain(path.join(home, entry));
      }
      expect(create).not.toContain(":/claude-config:ro");
      // The key reaches the bridge through the staged file, not `docker inspect`.
      expect(create).not.toContain("ANTHROPIC_API_KEY");
      expect(create).not.toContain("fixture-anthropic-key");
    });
  });
});

const LEGACY_MOUNTS = JSON.stringify([
  { Type: "bind", Source: "/home/someone/.claude", Destination: "/claude-config", RW: false },
  { Type: "bind", Source: "/home/someone/.gitconfig", Destination: "/tmp/gitconfig", RW: false },
]);

describe("a runtime already in the old shape", () => {
  function legacyEnvironment(owner: string) {
    return lifecycleEnvironment({
      containerId: "legacy-runtime",
      status: "stopped",
      networkAccessMode: "full",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 1,
        lastRuntimeGeneration: 1,
        runtime: {
          containerId: "legacy-runtime",
          runtimeGeneration: 1,
          owner,
          imageId: FIXTURE_IMAGE_ID,
        },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
      },
    });
  }

  test("starts, keeps its mounts and is not migrated by a start or a read", async () => {
    const owner = dockerOwnerNamespace(dir);
    const { context, environment, environments } = creationContext(legacyEnvironment(owner));
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *boot-status.json*) printf 'ORKESTRATOR_NO_BOOT_DIR\\n1\\n'; exit 0 ;;
esac
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  image) printf '${FIXTURE_IMAGE_ID}\\t[]\\tamd64\\n' ;;
  create) printf 'manifest-probe\\n' ;;
  cp) ${NO_MANIFEST} ;;
  inspect)
    case "$*" in
      *.Mounts*) printf '<no value>\\t<no value>\\t%s\\n' '${LEGACY_MOUNTS}' ;;
      *orkestrator-inputs-revision*) printf '<no value>\\n' ;;
      *orkestrator-owner*) printf '${owner}\\trunning\\torkestrator-v2\\tlegacy-runtime\\n' ;;
      *) printf 'running\\n' ;;
    esac ;;
esac
exit 0
`,
      async (log) => {
        expect(await startAssignedContainerRuntimeTask(environment.id, context)).toBe(
          "legacy-runtime",
        );
        // A read of its inputs, its rebuild preview and the cleanup review.
        expect((await environmentInputStatus(environment.id, context)).mode).toBe("host-mounts");
        await rebuildPreview(environment.id, context);
        await previewDockerCleanup(context).catch(() => undefined);

        const calls = (await log.read()).split("\n");
        expect(calls).toContain("start legacy-runtime");
        // No new runtime and nothing removed: only the manifest probe is created.
        expect(calls.filter((line) => line.startsWith("create --name"))).toEqual([]);
        expect(calls.filter((line) => /^(rm|stop|rename|volume create) /.test(line))).toEqual(
          calls.filter((line) => line === "rm -f manifest-probe"),
        );

        const after = environments.get(environment.id);
        expect(after?.containerId).toBe("legacy-runtime");
        expect(after?.containerLifecycle?.runtime?.containerId).toBe("legacy-runtime");
        expect(after?.containerLifecycle?.runtime?.runtimeGeneration).toBe(1);
        expect(after?.containerLifecycle?.storage.format).toBe("legacy-layer");
      },
    );
  });

  test("a rebuild is offered only once the configured image is current", async () => {
    const owner = dockerOwnerNamespace(dir);
    const { context, environment } = creationContext(legacyEnvironment(owner));
    const script = (cp: string) => `#!/bin/sh
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  image) printf '${FIXTURE_IMAGE_ID}\\t[]\\tamd64\\n' ;;
  create) printf 'manifest-probe\\n' ;;
  cp) ${cp} ;;
esac
exit 0
`;
    await withDockerScript(script(NO_MANIFEST), async () => {
      const preview = await rebuildPreview(environment.id, context);
      expect(preview.available).toBe(false);
      expect(preview.unavailableReason).toBe("image-without-storage-contract");
    });
    resetImageManifestCache();
    // A hand-built manifest with storage but no staged inputs gets the same answer.
    const storageOnly = await imageManifestArchive(dir, { "persistent-workspace": 1 });
    await withDockerScript(script(`cat '${storageOnly}'`), async () => {
      const preview = await rebuildPreview(environment.id, context);
      expect(preview.available).toBe(false);
      expect(preview.unavailableReason).toBe("image-without-storage-contract");
    });
    resetImageManifestCache();
    const current = await imageManifestArchive(dir, {
      "persistent-workspace": 1,
      "staged-inputs": 5,
    });
    await withDockerScript(script(`cat '${current}'`), async () => {
      const preview = await rebuildPreview(environment.id, context);
      expect(preview.available).toBe(true);
      expect(preview.containerId).toBe("legacy-runtime");
      expect(preview.kind).toBe("migrate");
    });
  });
});

describe("the cleanup review's list", () => {
  function reviewContext(environments: ReturnType<typeof lifecycleEnvironment>[]) {
    const fixture = memoryLifecycleContext(environments, dir);
    return fixture.context;
  }

  const reviewScript = `#!/bin/sh
case "$1" in
  inspect)
    case "$*" in
      *legacy-container*) printf '\\t\\t%s\\n' '${LEGACY_MOUNTS}' ;;
      *bridge-container*) printf 'rev-1\\t\\t[]\\n' ;;
      *staged-container*) printf 'rev-2\\t3\\t%s\\n' '[{"Type":"bind","Destination":"/claude-config"}]' ;;
      *empty-container*) printf '<no value>\\t2\\t[]\\n' ;;
      *gone-container*) printf 'Error: No such object: gone-container\\n' >&2; exit 1 ;;
      *mystery-container*) printf 'Error response from daemon: boom\\n' >&2; exit 1 ;;
    esac ;;
esac
exit 0
`;

  test("names each environment with host mounts or the shared bridge, and only those", async () => {
    const running = {
      schemaVersion: 1,
      revision: 2,
      lastRuntimeGeneration: 1,
      storage: { format: "legacy-layer", workspaceGeneration: 1 },
      operation: { operationId: "op-1", kind: "migrate", phase: "copying" },
      outcomes: [],
    } as never;
    const context = reviewContext([
      lifecycleEnvironment({ id: "b", name: "Beta", containerId: "bridge-container" }),
      lifecycleEnvironment({
        id: "a",
        name: "Alpha",
        containerId: "legacy-container",
        containerLifecycle: running,
      }),
      lifecycleEnvironment({ id: "c", name: "Current", containerId: "staged-container" }),
      lifecycleEnvironment({ id: "d", name: "No mounts", containerId: "empty-container" }),
      lifecycleEnvironment({ id: "e", name: "Gone", containerId: "gone-container" }),
      lifecycleEnvironment({ id: "f", name: "Unreadable", containerId: "mystery-container" }),
      lifecycleEnvironment({ id: "g", name: "No container", containerId: null }),
      lifecycleEnvironment({
        id: "h",
        name: "Local",
        containerId: "legacy-container",
        environmentType: "local",
      }),
    ]);
    await withDockerScript(reviewScript, async () => {
      const preview = await previewDockerCleanup(context);
      expect(preview.legacyRuntimes).toEqual([
        {
          environmentId: "a",
          environmentName: "Alpha",
          containerId: "legacy-container",
          exposures: ["host-mounts", "shared-bridge"],
          busy: true,
        },
        {
          environmentId: "b",
          environmentName: "Beta",
          containerId: "bridge-container",
          exposures: ["shared-bridge"],
          busy: false,
        },
      ]);
      // Docker's silence is reported, not read as "nothing to rebuild".
      expect(preview.legacyRuntimesUnchecked).toBe(1);
      // A list of environments, never a removal candidate.
      expect(preview.rows).toEqual([]);
      expect(JSON.stringify(preview)).not.toContain("/home/someone");
    });
  });

  test("is empty when every runtime is current", async () => {
    const context = reviewContext([
      lifecycleEnvironment({ id: "c", name: "Current", containerId: "staged-container" }),
    ]);
    await withDockerScript(reviewScript, async () => {
      const preview = await previewDockerCleanup(context);
      expect(preview.legacyRuntimes).toEqual([]);
      expect(preview.legacyRuntimesUnchecked).toBe(0);
    });
  });

  test("the inputs section reads the same evidence, and Docker's silence is unknown", async () => {
    const environments = [
      lifecycleEnvironment({ id: "a", containerId: "legacy-container" }),
      lifecycleEnvironment({ id: "b", containerId: "bridge-container" }),
      lifecycleEnvironment({ id: "d", containerId: "empty-container" }),
      lifecycleEnvironment({ id: "e", containerId: "gone-container" }),
      lifecycleEnvironment({ id: "f", containerId: "mystery-container" }),
      lifecycleEnvironment({ id: "u", containerId: "unparsable-container" }),
      lifecycleEnvironment({ id: "g", containerId: null }),
    ];
    const context = reviewContext(environments);
    Object.assign(context.storage, {
      loadConfig: async () => ({ global: { enabledAgentPlatforms: [] } }),
    });
    const script = reviewScript.replace(
      "    esac ;;",
      "      *unparsable-container*) printf '\\t\\tnot json\\n' ;;\n    esac ;;",
    );
    await withDockerScript(script, async () => {
      const modes: Record<string, string> = {};
      for (const environment of environments) {
        const status = await environmentInputStatus(environment.id, context);
        modes[environment.id] = status.mode;
        // Nothing about the mounts' host paths leaves the backend.
        expect(JSON.stringify(status)).not.toContain("/home/someone");
      }
      expect(modes).toEqual({
        // No label and a bind at an old mount point: what the review lists.
        a: "host-mounts",
        // A revision label and no record of it: the record is unavailable.
        b: "unknown",
        // No label but no old bind either: nothing was mounted.
        d: "none",
        // Docker says the container is gone.
        e: "none",
        // Docker did not answer, or answered something unreadable.
        f: "unknown",
        u: "unknown",
        g: "none",
      });
      const preview = await previewDockerCleanup(context);
      expect(
        (preview.legacyRuntimes ?? [])
          .filter((row) => row.exposures.includes("host-mounts"))
          .map((row) => row.environmentId),
      ).toEqual(["a"]);
    });
  });

  test("a staged runtime binding the same target is not a host mount", () => {
    const mounts = '[{"Type":"bind","Destination":"/codex-home"}]';
    expect(legacyExposures("rev-1", "3", mounts)).toEqual([]);
    expect(legacyExposures("", "3", mounts)).toEqual(["host-mounts"]);
    expect(legacyExposures("", "3", '[{"Type":"volume","Destination":"/codex-home"}]')).toEqual([]);
  });
});
