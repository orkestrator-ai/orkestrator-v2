import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type IsolatedBackend, removeTree } from "../../scenarios/harness.js";
import { type Options, runOne } from "../../scripts/run-scenarios.js";

export const scenarioOptions: Options = {
  scenarios: [],
  environmentType: "container",
  dockerImage: "test:owned",
  keepOnFailure: false,
  list: false,
};

/** Real disposable files; controlled backend readiness without launching a service. */
export function scenarioRuntime() {
  let time = 1_000;
  const roots: string[] = [];
  const removed: string[] = [];
  const stopped: string[] = [];
  const dependencies: NonNullable<Parameters<typeof runOne>[3]> = {
    now: () => time,
    async newScenarioRoot() {
      const root = await mkdtemp(path.join(os.tmpdir(), "ork-scenario-runner-"));
      roots.push(root);
      return root;
    },
    async startIsolatedBackend({ root }) {
      time += 125;
      const worktreeDir = path.join(root, "worktrees");
      await mkdir(worktreeDir);
      return {
        root,
        worktreeDir,
        async stop() {
          stopped.push(root);
          return 0;
        },
      } as IsolatedBackend;
    },
    async removeTree(root) {
      removed.push(root);
      await removeTree(root);
    },
  };
  return {
    dependencies,
    roots,
    removed,
    stopped,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
