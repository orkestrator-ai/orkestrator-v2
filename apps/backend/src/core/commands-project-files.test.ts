import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyProjectSeedFilesIntoContainer } from "./container-project-seed-files.js";
import { withDockerScript } from "../../tests/container-lifecycle-fixtures.js";
import {
  copyConfiguredProjectFilesToDirectory,
  stageConfiguredProjectFilesForContainer,
} from "./commands-project-files.js";

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-project-files-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWithSecret() {
  const project = await tempDir();
  await mkdir(path.join(project, "config"), { recursive: true });
  await writeFile(path.join(project, "config", "secrets.env"), "TOKEN=secret\n");
  return project;
}

test("copies a configured file into a fresh worktree", async () => {
  const project = await projectWithSecret();
  const worktree = await tempDir();
  await copyConfiguredProjectFilesToDirectory(project, worktree, ["config/secrets.env"]);
  expect(await readFile(path.join(worktree, "config", "secrets.env"), "utf8")).toBe(
    "TOKEN=secret\n",
  );
});

test("a branch's link in place of the file is not written through", async () => {
  const project = await projectWithSecret();
  const worktree = await tempDir();
  const outside = await tempDir();
  await mkdir(path.join(worktree, "config"));
  await symlink(path.join(outside, "leak.env"), path.join(worktree, "config", "secrets.env"));
  await expect(
    copyConfiguredProjectFilesToDirectory(project, worktree, ["config/secrets.env"]),
  ).rejects.toThrow("written through a link");
  await expect(readFile(path.join(outside, "leak.env"), "utf8")).rejects.toThrow();
});

test("a branch's link in place of a directory above it is not written through", async () => {
  const project = await projectWithSecret();
  const worktree = await tempDir();
  const outside = await tempDir();
  await symlink(outside, path.join(worktree, "config"));
  await expect(
    copyConfiguredProjectFilesToDirectory(project, worktree, ["config/secrets.env"]),
  ).rejects.toThrow("written through a link");
  await expect(readFile(path.join(outside, "secrets.env"), "utf8")).rejects.toThrow();
});

for (const hidden of [false, true]) {
  test(`configured container files map copy refusal to unsupported-topology (hidden=${hidden})`, async () => {
    const project = await projectWithSecret();
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$2" in
  container:/.orkestrator-copy-probe-absent) echo 'remount-ro /rootfs/git, flags: 0x1021: operation not permitted' >&2 ;;
  *) echo '${hidden ? "destination must be a directory" : "remount-ro /rootfs/git, flags: 0x1021: operation not permitted"}' >&2 ;;
esac
exit 1
`,
      async (log) => {
        await expect(
          stageConfiguredProjectFilesForContainer("container", project, ["config/secrets.env"]),
        ).rejects.toThrow("ContainerLifecycleError:unsupported-topology");
        const calls = await log.read();
        expect(calls).toContain("container:/project-files");
        expect(calls.includes("container:/.orkestrator-copy-probe-absent")).toBe(hidden);
      },
    );
  });
}

test("seed archive copy maps a hidden remount refusal to unsupported-topology", async () => {
  await withDockerScript(
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$2" = container:/.orkestrator-copy-probe-absent ]; then
  echo 'remount-ro /rootfs/git, flags: 0x1021: operation not permitted' >&2
else
  cat >/dev/null
  echo 'destination must be a directory' >&2
fi
exit 1
`,
    async (log) => {
      await expect(
        copyProjectSeedFilesIntoContainer("container", [
          { name: ".env", target: "project-env/.env", contents: Buffer.from("VALUE=fixture") },
        ]),
      ).rejects.toThrow("ContainerLifecycleError:unsupported-topology");
      const calls = await log.read();
      expect(calls).toContain("cp -a - container:/");
      expect(calls).toContain("cp container:/.orkestrator-copy-probe-absent -");
    },
  );
});
