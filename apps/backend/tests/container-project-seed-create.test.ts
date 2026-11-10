import { afterEach, expect, test } from "bun:test";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDockerContainer } from "../src/core/commands-containers";
import { formatSetupTerminalIntro, spawnSetupTerminal } from "../src/core/commands-environment";
import type { PtyExitEvent, PtyProcess } from "../src/core/pty";
import {
  formatProjectSeedRefusals,
  readProjectSeedRefusals,
} from "../src/core/container-project-seed-files";
import { resetResourceCaches } from "../src/core/container-resources";
import { resetDockerTopologyCache, resetImageManifestCache } from "../src/core/docker-image";
import {
  FIXTURE_IMAGE_ID,
  imageManifestArchive,
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

/** `SETUP_DONE_OSC_SEQUENCE` as a `printf` format. */
const SETUP_DONE_PRINTF_FORMAT = "\\033]9999;setup_done\\007";

const cleanup: string[] = [];
afterEach(async () => {
  resetResourceCaches();
  resetDockerTopologyCache();
  resetImageManifestCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// The project's `.env`, `.env.local` and `opencode.json` reach a new container
// only by `docker cp` of bytes the backend read and checked, never as a bind
// mount the daemon would resolve on the host. Fake Docker extracts the stdin
// archive into a capture directory so the test sees exactly what would enter
// the container. Every link targets a throwaway file.
async function createWithProject(project: string, filesToCopy: string[] = [], seeded = false) {
  const dir = await tempDir("ork-project-seed-create-");
  cleanup.push(dir);
  if (seeded) {
    const root = path.join(dir, "node-seed", "env-lifecycle");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, ".orkestrator-seed-manifest.json"),
      JSON.stringify(filesToCopy),
    );
    for (const name of filesToCopy) await fs.writeFile(path.join(root, name), "FALLBACK=1\n");
  }
  const capture = path.join(dir, "capture");
  await fs.mkdir(capture);
  const environment = lifecycleEnvironment({ networkAccessMode: "full" });
  const { context } = memoryLifecycleContext([environment], dir);
  Object.assign(context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
  Object.assign(context.storage, {
    getProject: async () => ({
      id: "project-1",
      gitUrl: "https://example.invalid/repo.git",
      localPath: project,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { enabledAgentPlatforms: [] },
      repositories: { "project-1": { filesToCopy: seeded ? [] : filesToCopy } },
    }),
  });
  const manifest = await imageManifestArchive(dir);
  let commands: string[] = [];
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf 'unix:///var/run/docker.sock\\n' ;;
  info) printf '{"OSType":"linux","OperatingSystem":"Debian","Architecture":"x86_64","ServerVersion":"29.7.2","SecurityOptions":[]}\\n' ;;
  create)
    case "$*" in
      *manifest-probe*) printf 'manifest-probe\\n' ;;
      *) printf 'seed-container\\n' ;;
    esac ;;
  cp)
    case "$2" in manifest-probe:*) cat '${manifest}'; exit 0 ;; esac
    [ "$2" = -a ] || exit 1
    tar -xf - -C '${capture}' ;;

esac
exit 0
`,
    async (log) => {
      expect(await createDockerContainer(environment, context, { imageId: FIXTURE_IMAGE_ID })).toBe(
        "seed-container",
      );
      commands = (await log.read())
        .split("\n")
        .filter((line) => Boolean(line) && !line.includes("manifest-probe"));
    },
  );
  const create = commands.find((line) => line.startsWith("create "));
  if (!create) throw new Error("no docker create was issued");
  return { create, commands, capture };
}

test("regular project files are copied into the container, not bind-mounted", async () => {
  const project = await tempDir("ork-project-seed-project-");
  cleanup.push(project);
  await fs.writeFile(path.join(project, ".env"), "A=1\n");
  await fs.writeFile(path.join(project, ".env.local"), "B=2\n");
  await fs.writeFile(path.join(project, "opencode.json"), '{"model":"x"}');

  const { create, commands, capture } = await createWithProject(project);

  expect(create).not.toContain(project);
  expect(create).not.toContain("/project-env");
  expect(create).not.toContain("/opencode-project-json");
  expect(create).not.toContain("orkestrator-project-seed-refused");
  const copies = commands.filter((line) => line.startsWith("cp "));
  expect(copies).toEqual(["cp -a - seed-container:/"]);
  expect(await fs.readFile(path.join(capture, "project-env", ".env"), "utf8")).toBe("A=1\n");
  expect(await fs.readFile(path.join(capture, "project-env", ".env.local"), "utf8")).toBe("B=2\n");
  expect(await fs.readFile(path.join(capture, "opencode-project-json"), "utf8")).toBe(
    '{"model":"x"}',
  );
});

test("links, directories and files outside the project never reach the container", async () => {
  const project = await tempDir("ork-project-seed-project-");
  const outside = await tempDir("ork-project-seed-outside-");
  cleanup.push(project, outside);
  const secret = path.join(outside, "host-secret");
  await fs.writeFile(secret, "HOST_ONLY=1\n");
  await fs.symlink(secret, path.join(project, ".env")); // absolute link
  await fs.symlink(path.relative(project, outside), path.join(project, ".env.local")); // relative
  await fs.mkdir(path.join(project, "opencode.json"));

  const { create, commands, capture } = await createWithProject(project);

  expect(create).not.toContain(project);
  expect(create).not.toContain(outside);
  expect(create).not.toContain("/project-env");
  expect(create).toContain(
    "--label orkestrator-project-seed-refused=.env=symlink,.env.local=symlink,opencode.json=not-a-file",
  );
  expect(commands.filter((line) => line.startsWith("cp "))).toEqual([]);
  expect(await fs.readdir(capture)).toEqual([]);
});

test("a refused file does not stop its regular siblings", async () => {
  const project = await tempDir("ork-project-seed-project-");
  const outside = await tempDir("ork-project-seed-outside-");
  cleanup.push(project, outside);
  await fs.writeFile(path.join(outside, "host-secret"), "HOST_ONLY=1\n");
  await fs.symlink(path.join(outside, "host-secret"), path.join(project, ".env"));
  await fs.writeFile(path.join(project, ".env.local"), "B=2\n");

  const { create, capture } = await createWithProject(project);

  expect(create).toContain("--label orkestrator-project-seed-refused=.env=symlink");
  expect(await fs.readdir(path.join(capture, "project-env"))).toEqual([".env.local"]);
  expect(await fs.readFile(path.join(capture, "project-env", ".env.local"), "utf8")).toBe("B=2\n");
});

test("the setup terminal intro explains each refusal recorded on the container", async () => {
  let notices: string[] = [];
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf '.env=symlink,opencode.json=not-a-file\\n' ;;
esac
exit 0
`,
    async (log) => {
      notices = formatProjectSeedRefusals(await readProjectSeedRefusals("seed-container"));
      expect(await log.read()).toContain("orkestrator-project-seed-refused");
    },
  );
  const intro = formatSetupTerminalIntro(
    lifecycleEnvironment({ containerId: "seed-container" }),
    ["/usr/local/bin/workspace-setup.sh"],
    notices,
  );
  expect(intro).toContain(
    "[orkestrator] Skipped .env from the project folder: it is a symbolic link.",
  );
  expect(intro).toContain(
    "[orkestrator] Skipped opencode.json from the project folder: it is not a regular file.",
  );
});

test("a container without the label has nothing to explain", async () => {
  await withDockerScript(
    `#!/bin/sh
case "$1" in
  inspect) printf '<no value>\\n' ;;
esac
exit 0
`,
    async () => {
      expect(await readProjectSeedRefusals("legacy-container")).toEqual([]);
    },
  );
});

for (const seeded of [false, true]) {
  for (const kind of ["internal", "external", "directory"]) {
    test(`refused configured seeds cannot re-enter staging (${kind}, manifest=${seeded})`, async () => {
      const project = await tempDir("ork-seed-overlap-");
      const outside = await tempDir("ork-seed-outside-");
      cleanup.push(project, outside);
      await fs.writeFile(path.join(project, "shared.env"), "INTERNAL=1");
      await fs.writeFile(path.join(outside, "shared.env"), "OUTSIDE=1");
      for (const name of [".env", ".env.local", "opencode.json"]) {
        if (kind === "directory") await fs.mkdir(path.join(project, name));
        else
          await fs.symlink(
            path.join(kind === "internal" ? project : outside, "shared.env"),
            path.join(project, name),
          );
      }
      const { commands, create, capture } = await createWithProject(
        project,
        [".env", ".env.local", "opencode.json"],
        seeded,
      );
      expect(create).toContain("orkestrator-project-seed-refused");
      expect(commands.filter((line) => line.startsWith("cp "))).toEqual([]);
      expect(await fs.readdir(capture)).toEqual([]);
    });
  }
}

test("missing project seeds use validated command-node snapshots", async () => {
  const project = await tempDir("ork-seed-fallback-");
  cleanup.push(project);
  const { capture } = await createWithProject(project, [".env", "opencode.json"], true);
  expect(await fs.readFile(path.join(capture, "project-env", ".env"), "utf8")).toBe("FALLBACK=1\n");
  expect(await fs.readFile(path.join(capture, "opencode-project-json"), "utf8")).toBe(
    "FALLBACK=1\n",
  );
});

/**
 * The terminal a previous setup run left open: exits when terminated, as a
 * real one does, so a new run retires it and starts its own.
 */
function finishedSetupPty(pid: number): { pty: PtyProcess; terminated: () => boolean } {
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let terminated = false;
  const pty = {
    pid,
    onExit: (callback: (event: PtyExitEvent) => void) => {
      exitListeners.add(callback);
      return { dispose: () => exitListeners.delete(callback) };
    },
    terminate: async () => {
      terminated = true;
      for (const listener of Array.from(exitListeners)) listener({ exitCode: 0 });
      return true;
    },
    kill: () => undefined,
  } as unknown as PtyProcess;
  return { pty, terminated: () => terminated };
}

test("spawnSetupTerminal reads the container label and emits its notices", async () => {
  const dir = await tempDir("ork-seed-terminal-");
  cleanup.push(dir);
  const environment = lifecycleEnvironment({ containerId: "seed-container" });
  const { context, events } = memoryLifecycleContext([environment], dir);
  const sessionId = `${environment.id}:setup`;
  const terminals = context.runtime.terminals;
  const previous = finishedSetupPty(fakePid(123));
  terminals.registerProcess(sessionId, previous.pty);
  // The fake `docker exec` is the setup shell: it reports success at once.
  await withDockerScript(
    `#!/bin/sh
case "$*" in
  *orkestrator-project-seed-refused*) printf '.env=symlink\\n' ;;
  exec\\ -it*)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
    printf '${SETUP_DONE_PRINTF_FORMAT}'
    ;;
  *) printf 'running\\n' ;;
esac
`,
    async (log) => {
      const result = await spawnSetupTerminal(environment, ["echo setup"], context);
      expect(result.sessionId).toBe(sessionId);
      expect(previous.terminated()).toBe(true);
      expect(JSON.stringify(events)).toContain("Skipped .env from the project folder");
      const shell = terminals.containerShell(sessionId);
      expect(shell?.containerId).toBe("seed-container");
      expect(await result.completion).toBe(true);
      const exec = await log.read();
      expect(exec).toContain(
        `--env ORKESTRATOR_TERMINAL_SESSION=${shell?.token} seed-container bash -c`,
      );
    },
  );
});
