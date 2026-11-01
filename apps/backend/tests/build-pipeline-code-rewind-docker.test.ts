/**
 * The build pipeline's "Rewind code to here" against a real container
 * environment (to-do 0405, task 7).
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * (this checkout's development image from `mise run docker:build:dev`, or the
 * CI workflow's qualification image; never `latest`).
 *
 * The pipeline runs on the service harness's fake providers, so no provider
 * turn is taken. Everything Git goes through the production wiring:
 * `createPipelineEnvironmentGit` with a real `EnvironmentMutationFence`, whose
 * runner is `docker exec -w /workspace <container> git …`. The worktree probe
 * the harness answers `headAtStart` and the preview from is fed by the same
 * script the `get_environment_uncommitted_paths` command runs in a container.
 *
 * The container carries this run's label and a private owner label; `afterAll`
 * removes exactly those resources, never a prune.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { BuildPipelineService } from "../src/core/build-pipeline-service";
import {
  codeRewindBackupRef,
  resetWorktreeToCommit,
  type EnvironmentGit,
} from "../src/core/build-pipeline-code-rewind";
import { EnvironmentUnavailableError } from "../src/core/workspace-code-rewind";
import {
  pipeline,
  startInput,
  withService,
  type FakeProvider,
} from "../src/core/build-pipeline-service-test-support";
import {
  createGitEnvironmentCommandRunner,
  createPipelineEnvironmentGit,
  parseGitPorcelainPaths,
} from "../src/core/commands-review";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { EnvironmentMutationFence } from "../src/core/environment-replacement-fence";
import {
  parseReviewWorktreeFingerprint,
  REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
} from "../src/core/review-worktree-fingerprint";
import { runCommand } from "../src/core/shell";
import type { StorageService } from "../src/core/storage";
import { removeLabelledResources } from "./container-live-cleanup";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const RUN_LABEL = `orkestrator-qualification=${RUN}`;

let dataDir = "";
let owner = "";
let containerId = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

/** A shell script run as the image's default user in `/workspace`. */
async function inContainer(script: string): Promise<string> {
  return docker(["exec", "-w", "/workspace", containerId, "sh", "-ec", script]);
}

beforeAll(async () => {
  if (!ENABLED) return;
  if (IMAGE.endsWith(":latest") || !IMAGE.includes(":")) {
    throw new Error("Use this checkout's development or qualification image, not latest");
  }
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-code-rewind-docker-"));
  owner = dockerOwnerNamespace(dataDir);
  // The image's real entrypoint in full-network mode, as the live
  // qualification suite starts it: the user, workdir and Git config a
  // container environment's `docker exec` sees.
  containerId = await docker([
    "run",
    "--detach",
    "--name",
    `ork-${RUN}-code-rewind`,
    "--label",
    RUN_LABEL,
    "--label",
    "app=orkestrator-v2",
    "--label",
    `orkestrator-owner=${owner}`,
    "--cap-add",
    "NET_ADMIN",
    "-e",
    "NETWORK_MODE=full",
    "-e",
    "GIT_URL=https://example.invalid/none.git",
    IMAGE,
  ]);
  await waitForContainerBoot(containerId);
  // A repository with a remote, as workspace setup leaves it; each case
  // works on its own branch from `main`. Commits use the identity the
  // entrypoint configured.
  await inContainer(
    [
      "git init -q --bare -b main /home/node/remote.git",
      "git init -q -b main .",
      "printf 'base\\n' > app.txt",
      "git add app.txt",
      "git commit -qm base",
      "git remote add origin /home/node/remote.git",
      "git push -q -u origin main",
    ].join("\n"),
  );
}, 180_000);

afterAll(async () => {
  if (!ENABLED) return;
  const leftovers = await removeLabelledResources(docker, [
    `label=${RUN_LABEL}`,
    `label=orkestrator-owner=${owner}`,
  ]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

const advanceUntil = async (
  service: BuildPipelineService,
  storage: StorageService,
  id: string,
  done: (snapshot: BuildPipeline) => boolean,
  beforeEach: () => Promise<void>,
): Promise<BuildPipeline> => {
  for (let pass = 0; pass < 60; pass += 1) {
    const snapshot = await pipeline(storage, id);
    if (done(snapshot)) return snapshot;
    await beforeEach();
    await service.advanceNow(id);
  }
  throw new Error(
    `The pipeline did not reach the expected state: ${(await pipeline(storage, id)).phase}`,
  );
};

const head = async () => (await inContainer("git rev-parse HEAD")).trim();

interface ContainerPipeline {
  service: BuildPipelineService;
  storage: StorageService;
  provider: FakeProvider;
  fence: EnvironmentMutationFence;
  git: EnvironmentGit;
  /** Fills the harness's worktree probe answers from the container. */
  syncProbe: () => Promise<void>;
  /** Runs before each Git command the service sends to the container. */
  beforeGit: { current?: (args: string[]) => Promise<void> };
}

/**
 * The service harness on a container environment backed by the fixture
 * container. Git goes through `createPipelineEnvironmentGit` and the real
 * fence. The harness answers the worktree probe from its controls, so they
 * are filled with what the `get_environment_uncommitted_paths` script reads
 * in the container: before every supervisor pass, and right after a reset
 * because the restart starts the step in the same call.
 */
async function withContainerPipeline(run: (context: ContainerPipeline) => Promise<void>) {
  const fence = new EnvironmentMutationFence();
  let storageRef: StorageService | undefined;
  let syncProbe = async () => undefined;
  const beforeGit: ContainerPipeline["beforeGit"] = {};
  const git: EnvironmentGit = async (environmentId, args) => {
    await beforeGit.current?.(args);
    const output = await createPipelineEnvironmentGit(storageRef!, fence)(environmentId, args);
    if (args[0] === "reset") await syncProbe();
    return output;
  };
  await withService(
    async (service, storage, provider, _invocations, controls) => {
      storageRef = storage;
      await storage.updateEnvironment("env-1", { containerId, worktreePath: null });
      const environment = (await storage.getEnvironment("env-1"))!;
      syncProbe = async () => {
        const runner = createGitEnvironmentCommandRunner(environment, fence);
        const captured = parseReviewWorktreeFingerprint(
          await runner("node", ["-e", REVIEW_WORKTREE_FINGERPRINT_SCRIPT], 30_000),
        );
        controls.currentHead = captured.head;
        controls.uncommittedPaths = parseGitPorcelainPaths(captured.status);
      };
      await run({ service, storage, provider, fence, git, syncProbe, beforeGit });
    },
    { environmentType: "containerized", environmentGit: git, environmentFence: fence },
  );
}

/**
 * Checks out a new `branch` tracking the remote, then runs a pipeline to
 * completion while its Build "agent" commits twice in the container, pushing
 * the first, as a Ship or the agent itself would.
 */
async function completedPipeline(
  { service, storage, syncProbe }: ContainerPipeline,
  branch: string,
) {
  await inContainer(`git checkout -q -b ${branch} main && git push -q -u origin ${branch}`);
  const base = await head();
  await syncProbe();
  const started = await service.start(startInput({ environmentType: "containerized" }));
  await advanceUntil(service, storage, started.id, (p) => p.sessions.length > 0, syncProbe);
  await inContainer(
    [
      "printf 'one\\n' >> app.txt && git commit -qam 'build: one'",
      "git push -q",
      "printf 'two\\n' >> app.txt && git commit -qam 'build: two'",
    ].join("\n"),
  );
  const tip = await head();
  const completed = await advanceUntil(
    service,
    storage,
    started.id,
    (snapshot) => snapshot.phase === "complete",
    syncProbe,
  );
  const build = completed.sessions.find((session) => session.phase === "build")!;
  expect(build.headAtStart).toBe(base);
  return { id: started.id, base, tip, build };
}

describe("Rewind code to here in a container environment", () => {
  live(
    "resets the container's branch to the step's start, keeps the backup ref and restarts the step",
    async () => {
      await withContainerPipeline(async (context) => {
        const { service, storage, provider, fence, git, syncProbe } = context;
        const { id, base, tip, build } = await completedPipeline(context, "build");

        // An untracked file blocks the preview and the rewind, changing nothing.
        await inContainer("printf 'stray\\n' > stray.txt");
        await syncProbe();
        const dirty = await service.previewCodeRewind(id, build.sessionKey);
        expect(dirty.blocked).toContain("uncommitted changes");
        expect(dirty.uncommittedPaths).toEqual(["stray.txt"]);
        await expect(service.rewindCode(id, build.sessionKey, tip)).rejects.toThrow(
          "uncommitted changes",
        );
        expect(await head()).toBe(tip);
        await inContainer("rm stray.txt");

        await syncProbe();
        const preview = await service.previewCodeRewind(id, build.sessionKey);
        expect(preview.blocked).toBeUndefined();
        expect(preview).toMatchObject({
          targetCommit: base,
          head: tip,
          commitCount: 2,
          upstream: { ref: "origin/build", droppedCommits: 1 },
        });
        expect(preview.commits?.map((commit) => commit.subject)).toEqual([
          "build: two",
          "build: one",
        ]);

        const created = provider.created.length;
        const rewound = await service.rewindCode(id, build.sessionKey, tip);
        const rewind = rewound.rewinds!.at(-1)!;
        expect(rewind.code).toEqual({
          from: tip,
          to: base,
          droppedCommits: 2,
          backupRef: codeRewindBackupRef(id, rewind.id),
          upstream: "origin/build",
          upstreamCommitsDropped: 1,
        });
        const backupRef = rewind.code!.backupRef;
        // Inside the container: HEAD is the step's start, the backup ref
        // holds the old tip, the branch is still checked out, and the
        // worktree is clean.
        expect(await head()).toBe(base);
        expect((await inContainer(`git rev-parse ${backupRef}`)).trim()).toBe(tip);
        expect((await inContainer("git symbolic-ref --short HEAD")).trim()).toBe("build");
        expect(await inContainer("git status --porcelain --untracked-files=all")).toBe("");
        expect(await inContainer("cat app.txt")).toBe("base");
        // The pipeline restarted from the Build.
        expect(provider.created.slice(created).map((entry) => entry.phase)).toEqual(["build"]);
        expect(rewound.sessions.at(-1)?.headAtStart).toBe(base);

        // A repeated confirmation is a no-op, and a retry of the reset
        // itself (a crash before the final save) proves the backup in the
        // container instead of moving anything.
        const repeated = await service.rewindCode(id, build.sessionKey, tip);
        expect(repeated.rewinds).toHaveLength(1);
        await resetWorktreeToCommit(git, "env-1", { from: tip, to: base, backupRef });
        expect(await head()).toBe(base);
        await expect(
          resetWorktreeToCommit(git, "env-1", {
            from: tip,
            to: base,
            backupRef: codeRewindBackupRef(id, "unrelated"),
          }),
        ).rejects.toThrow("The pending rewind's backup ref is missing.");
        expect(fence.isBeingMoved("env-1")).toBe(false);

        // The dropped commit was pushed, so the next Ship force-pushes with lease.
        const finished = await advanceUntil(
          service,
          storage,
          id,
          (snapshot) => snapshot.phase === "complete",
          syncProbe,
        );
        const ship = finished.sessions.at(-1)!;
        expect(ship.phase).toBe("pr");
        const shipPrompt = provider.sent.find((entry) => entry.sessionId === ship.sdkSessionId);
        expect(shipPrompt?.prompt).toContain("git push --force-with-lease");
        expect(shipPrompt?.prompt).toContain("`origin/build`");
      });
    },
    240_000,
  );

  live(
    "a container that stops answering refuses the rewind with a readable reason and changes nothing",
    async () => {
      await withContainerPipeline(async (context) => {
        const { service, storage, fence, syncProbe } = context;
        const { id, tip, build } = await completedPipeline(context, "paused");
        await syncProbe();
        await docker(["pause", containerId]);
        let refused: unknown;
        try {
          refused = await service.rewindCode(id, build.sessionKey, tip).then(
            () => undefined,
            (error: unknown) => error,
          );
        } finally {
          await docker(["unpause", containerId]);
        }
        // The state Docker reports, not its daemon text naming the container.
        expect(refused).toBeInstanceOf(EnvironmentUnavailableError);
        expect((refused as Error).message).toBe(
          "The environment's container is paused. Unpause it, then try again.",
        );
        const after = await pipeline(storage, id);
        expect(after.rewinds ?? []).toHaveLength(0);
        expect(after.phase).toBe("complete");
        expect(await head()).toBe(tip);
        expect(fence.isBeingMoved("env-1")).toBe(false);
      });
    },
    240_000,
  );

  live(
    "a container that stops after the reset is journaled finishes the reset once it answers again",
    async () => {
      await withContainerPipeline(async (context) => {
        const { service, storage, provider, fence, syncProbe, beforeGit } = context;
        const { id, base, tip, build } = await completedPipeline(context, "journaled");
        await syncProbe();
        // The intent is saved before any Git mutation; pause the container
        // just as the backup ref is about to be written.
        let paused = false;
        beforeGit.current = async (args) => {
          if (args[0] === "update-ref" && !paused) {
            paused = true;
            await docker(["pause", containerId]);
          }
        };
        const created = provider.created.length;
        let failure: unknown;
        try {
          failure = await service.rewindCode(id, build.sessionKey, tip).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(paused).toBe(true);
          expect((failure as Error).message).toBe(
            `The code rewind to ${base.slice(0, 12)} has not finished, so this build cannot continue yet. The environment's container is paused. Unpause it, then try again.`,
          );
          const pending = await pipeline(storage, id);
          expect(pending.rewinds?.at(-1)?.code?.pending).toBe(true);
          // Nothing starts on the old code while the reset is outstanding,
          // and a control says what it is waiting for.
          await service.advanceNow(id);
          expect(provider.created.length).toBe(created);
          expect((await pipeline(storage, id)).rewinds?.at(-1)?.code?.pending).toBe(true);
          await expect(service.cancel(id)).rejects.toThrow(
            "has not finished, so this build cannot continue yet. The environment's container is paused.",
          );
        } finally {
          beforeGit.current = undefined;
          await docker(["unpause", containerId]);
        }
        expect(await head()).toBe(tip);

        // The supervisor's next pass finishes the journaled reset; the one
        // after starts the Build on the rewound code.
        await syncProbe();
        await service.advanceNow(id);
        const resumed = await pipeline(storage, id);
        const code = resumed.rewinds!.at(-1)!.code!;
        expect(code.pending).toBeUndefined();
        expect(await head()).toBe(base);
        expect((await inContainer(`git rev-parse ${code.backupRef}`)).trim()).toBe(tip);
        expect(provider.created.length).toBe(created);
        await syncProbe();
        await service.advanceNow(id);
        expect(provider.created.slice(created).map((entry) => entry.phase)).toEqual(["build"]);
        expect((await pipeline(storage, id)).sessions.at(-1)?.headAtStart).toBe(base);
        expect(fence.isBeingMoved("env-1")).toBe(false);
      });
    },
    240_000,
  );
});
