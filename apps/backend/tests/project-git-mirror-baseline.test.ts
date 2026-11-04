import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { establishCreatedFromCommit } from "../src/core/commands-local-server-lifecycle";
import {
  CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL,
} from "../src/core/container-scripts";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

test("baseline capture records the mirror fallback from workspace preparation", async () => {
  const dir = await tempDir("ork-mirror-baseline-");
  directories.push(dir);
  const mirror = path.join(dir, "git-mirrors", "project-1");
  await fs.mkdir(mirror, { recursive: true });
  const env = lifecycleEnvironment({ containerId: "test-container" });
  const { context } = memoryLifecycleContext([env], dir);
  const commit = "a".repeat(40);
  await withDockerScript(
    `#!/bin/sh
case "$*" in
  *inspect*) printf 'running' ;;
  *rev-parse*) printf '${commit}' ;;
  *) printf '${CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL}\\n\\036ORKESTRATOR_GIT_MIRROR:corrupt\\037\\n${CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL}\\n' ;;
esac
`,
    async () => {
      const result = await establishCreatedFromCommit(env, context);
      expect(result.createdFromCommit).toBe(commit);
      expect(JSON.parse(await fs.readFile(path.join(mirror, "state.json"), "utf8")).suspect).toBe(
        true,
      );
    },
  );
});
