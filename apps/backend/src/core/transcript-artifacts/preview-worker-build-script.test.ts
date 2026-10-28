import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WORKER_CONTEXT_LABEL, workerContextDigest } from "./preview-worker-context-digest.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("build.sh labels the built context and records its digest with the inspected image id", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ork-worker-build-script-"));
  roots.push(root);
  const repo = path.resolve(import.meta.dir, "../../../../..");
  const here = path.join(root, "docker/artifact-preview-worker");
  mkdirSync(here, { recursive: true });
  // Run the real shell and digest CLI; only staging and the Docker boundary are fakes.
  for (const file of ["build.sh", "context-digest.ts"])
    copyFileSync(path.join(repo, "docker/artifact-preview-worker", file), path.join(here, file));
  const digestModule =
    "apps/backend/src/core/transcript-artifacts/preview-worker-context-digest.ts";
  mkdirSync(path.dirname(path.join(root, digestModule)), { recursive: true });
  copyFileSync(path.join(repo, digestModule), path.join(root, digestModule));
  writeFileSync(
    path.join(here, "stage-context.ts"),
    `
    await Bun.write(process.argv[2] + "/Dockerfile", "FROM scratch\\n");
  `,
  );
  const expectedContext = path.join(root, "expected");
  mkdirSync(expectedContext);
  writeFileSync(path.join(expectedContext, "Dockerfile"), "FROM scratch\n");
  const digest = await workerContextDigest(expectedContext);
  const id = `sha256:${"a".repeat(64)}`;
  const docker = path.join(root, "docker-cli");
  mkdirSync(docker);
  writeFileSync(
    path.join(docker, "docker"),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> '${root}/calls'
case "$1" in
  build) test -f "\${!#}/Dockerfile" ;;
  image) echo '${id}' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(path.join(docker, "docker"), 0o755);
  const tag = "worker:build-script-test";
  const result = Bun.spawnSync(["bash", path.join(here, "build.sh"), tag], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${docker}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(path.join(here, "image-pin.json"), "utf8"))).toEqual({
    tag,
    id,
    contextDigest: digest,
  });
  const calls = readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
  const staged = calls[0]!.split(" ").at(-1)!;
  expect(calls).toEqual([
    `build --pull=false --label orkestrator.artifact-preview-worker=1 --label ${WORKER_CONTEXT_LABEL}=${digest} -t ${tag} ${staged}`,
    `image inspect --format {{.Id}} ${tag}`,
  ]);
  expect(existsSync(staged)).toBe(false);
});
