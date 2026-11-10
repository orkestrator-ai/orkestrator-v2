import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { stageConfiguredProjectFilesForContainer } from "../src/core/commands-project-files";
import { copyProjectSeedFilesIntoContainer } from "../src/core/container-project-seed-files";
import { copyOutBounded } from "../src/core/docker-copy-out";
import { isDockerCopyRefusedError } from "../src/core/docker-copy-refusal";
import { copyGithubRangesSeed } from "../src/core/github-ranges-cache";
import { runCommand } from "../src/core/shell";

// Opt-in (to-do 7549 task 1): point DOCKER_HOST at a rootless daemon
// (`mise run docker:disposable -- start`) and set
// ORKESTRATOR_COPY_REFUSAL_TEST_IMAGE to an image with `sleep`. A container
// gets a read-only bind from a directory on a nosuid/nodev filesystem (the
// tmpfs /tmp, or ORKESTRATOR_COPY_REFUSAL_NOSUID_DIR), and every copy path
// the backend runs against a runtime is driven at it. Nothing else is mounted
// and the container has no network.
const image = process.env.ORKESTRATOR_COPY_REFUSAL_TEST_IMAGE?.trim();
const nosuidParent = process.env.ORKESTRATOR_COPY_REFUSAL_NOSUID_DIR?.trim() || os.tmpdir();
const created: string[] = [];
const directories: string[] = [];

afterAll(async () => {
  for (const id of created) {
    await runCommand("docker", ["rm", "-f", id], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
}, 120_000);

async function mountOptions(directory: string): Promise<string[]> {
  // The longest mount point that contains the directory.
  const mounts = (await readFile("/proc/self/mounts", "utf8")).split("\n");
  let best: { point: string; options: string[] } | null = null;
  for (const line of mounts) {
    const [, point, , options] = line.split(" ");
    if (!point || !options) continue;
    const inside = directory === point || directory.startsWith(point === "/" ? "/" : `${point}/`);
    if (inside && (!best || point.length > best.point.length)) {
      best = { point, options: options.split(",") };
    }
  }
  return best?.options ?? [];
}

test.skipIf(!image || process.platform !== "linux")(
  "every copy into or out of a container with a read-only nosuid/nodev bind is the typed refusal",
  async () => {
    const source = await mkdtemp(path.join(nosuidParent, "ork-copy-refusal-"));
    directories.push(source);
    const options = await mountOptions(source);
    expect(options.includes("nosuid") || options.includes("nodev")).toBe(true);
    await writeFile(path.join(source, "input"), "x\n");
    const project = await mkdtemp(path.join(os.tmpdir(), "ork-copy-refusal-project-"));
    directories.push(project);
    await writeFile(path.join(project, "config.json"), "{}\n");
    const seed = path.join(project, "github-ranges.txt");
    await writeFile(seed, "# github-ranges 2026-11-10T00:00:00.000Z\n192.30.252.0/22\n");

    const { stdout } = await runCommand(
      "docker",
      [
        "create",
        "--name",
        `ork-copy-refusal-${crypto.randomUUID().slice(0, 8)}`,
        "--network",
        "none",
        "--mount",
        `type=bind,src=${source},dst=/input,readonly`,
        "--entrypoint",
        "sleep",
        image!,
        "120",
      ],
      { timeoutMs: 60_000 },
    );
    const id = stdout.trim();
    created.push(id);

    // Created, not started: the creation-time copies.
    const seedFiles = await copyProjectSeedFilesIntoContainer(id, [
      { name: ".env", target: "project-env/.env", contents: Buffer.from("A=1\n") },
    ]).catch((error: unknown) => error);
    expect(isDockerCopyRefusedError(seedFiles)).toBe(true);
    expect(parseContainerLifecycleError(seedFiles)?.code).toBe("unsupported-topology");
    const projectFiles = await stageConfiguredProjectFilesForContainer(id, project, [
      "config.json",
    ]).catch((error: unknown) => error);
    expect(isDockerCopyRefusedError(projectFiles)).toBe(true);
    expect(await copyGithubRangesSeed(id, seed)).toBe(false);

    // Running, then stopped: the boot record read and the rebuild's source.
    await runCommand("docker", ["start", id], { timeoutMs: 60_000 });
    expect((await copyOutBounded(id, "/etc/hostname", 4096)).kind).toBe("refused");
    await runCommand("docker", ["stop", "-t", "1", id], { timeoutMs: 60_000 });
    expect((await copyOutBounded(id, "/etc/hostname", 4096)).kind).toBe("refused");
  },
  180_000,
);
