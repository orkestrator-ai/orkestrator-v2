/**
 * Part of the host side of a project's Git mirror, with real Git against real local
 * repositories: failure handling, disk bounds, concurrency, removal and review regressions. The suite is split across
 * `project-git-mirror-*.integration.test.ts` so `bun test --parallel` can run the parts
 * on separate workers; the shared fixture and helpers live in
 * `project-git-mirror-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { syncRuntimeGitHubCredential } from "../src/core/container-github-credential";
import type { Environment } from "../src/core/models";
import { withDockerScript } from "./container-lifecycle-fixtures";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import { cleanupProjectForRemoval } from "../src/core/commands-registry-projects";
import type { CommandContext } from "../src/core/commands-context";
import {
  CONTAINER_GIT_MIRROR_MOUNT,
  CONTAINER_GIT_MIRROR_PATH,
  GIT_MIRROR_REFRESH_INTERVAL_MS,
  gitMirrorContainerArguments,
  noteGitMirrorCloneOutcome,
  removeProjectGitMirror,
  sweepOrphanedProjectGitMirrors,
  stopProjectGitMirrorRefreshes,
} from "../src/core/project-git-mirror";
import type { GitMirrorAccess } from "../src/core/project-git-mirror-access";
import { runCommand } from "../src/core/shell";
import {
  registerGitMirrorFixture,
  PROJECT_ID,
  commit,
  context,
  dataDir,
  git,
  mirrorPath,
  mirrorRefs,
  mountPath,
  project,
  projectDir,
  readState,
  refresh,
  remote,
  root,
  setupScript,
  storage,
} from "./project-git-mirror-fixtures";

registerGitMirrorFixture();

describe("what never stops a launch", () => {
  test("a remote that cannot be reached leaves no partial mirror and does not throw", async () => {
    const outcome = await refresh({}, { id: PROJECT_ID, gitUrl: `file://${root}/absent.git` });

    expect(outcome).toBe("failed");
    expect(existsSync(mirrorPath())).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a failed fetch keeps the mirror it had", async () => {
    expect(await refresh()).toBe("built");
    const before = mirrorRefs();
    const away = `${remote}.away`;
    await fs.rename(remote, away);

    expect(await refresh()).toBe("failed");

    expect(mirrorRefs()).toEqual(before);
    await fs.rename(away, remote);
    expect(await refresh()).toBe("fetched");
  });

  test("a mirror left locked by a crash is rebuilt after repeated failures", async () => {
    expect(await refresh()).toBe("built");
    commit("two.txt", "two\n");
    // What a killed `git fetch` can leave behind: the ref it was updating.
    await fs.writeFile(path.join(mirrorPath(), "refs", "heads", "main.lock"), "");

    for (let attempt = 0; attempt < 3; attempt += 1) expect(await refresh()).toBe("failed");
    expect(await refresh()).toBe("built");

    expect(existsSync(path.join(mirrorPath(), "refs", "heads", "main.lock"))).toBe(false);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "log", "-1", "--format=%s", "main"])).toBe(
      "change two.txt",
    );
  });

  test("a clone's report of a corrupt mirror has the next refresh check and replace it", async () => {
    expect(await refresh()).toBe("built");
    const packDir = path.join(mirrorPath(), "objects");
    await fs.rm(packDir, { recursive: true, force: true });
    await fs.mkdir(packDir);

    await noteGitMirrorCloneOutcome(
      "\x1eORKESTRATOR_GIT_MIRROR:corrupt\x1f\n",
      dataDir,
      PROJECT_ID,
    );
    expect(await refresh()).toBe("built");

    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full"]);
  });

  test("a clone's report that the mirror was only missing marks nothing", async () => {
    expect(await refresh()).toBe("built");
    await noteGitMirrorCloneOutcome(
      "\x1eORKESTRATOR_GIT_MIRROR:missing\x1f\n",
      dataDir,
      PROJECT_ID,
    );
    const state = JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8"));
    expect(state.suspect).toBeFalsy();
    expect(await refresh()).toBe("fetched");
  });
});

describe("disk bounds", () => {
  test("a repository past the limit gets no mirror and is not tried again for a week", async () => {
    let clock = 1_000_000;
    const options = { force: false, now: () => clock };
    expect(await refresh({ ...options, maxBytes: 1 })).toBe("oversized");
    expect(existsSync(mirrorPath())).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);

    clock += GIT_MIRROR_REFRESH_INTERVAL_MS * 2;
    expect(await refresh({ ...options, maxBytes: 1 })).toBe("skipped-oversized");
    clock += 7 * 24 * 60 * 60_000;
    expect(await refresh(options)).toBe("built");
  });

  test("a mirror that grows past the limit is removed by its own refresh", async () => {
    expect(await refresh()).toBe("built");

    expect(await refresh({ maxBytes: 1 })).toBe("oversized");

    expect(existsSync(mirrorPath())).toBe(false);
    expect(existsSync(mountPath())).toBe(true);
  });

  test("a nearly full disk does not start a build, and keeps an existing mirror", async () => {
    expect(await refresh({ freeBytes: async () => 2 * 1024 ** 3 })).toBe("skipped-low-disk");
    expect(existsSync(mirrorPath())).toBe(false);

    expect(await refresh()).toBe("built");
    expect(await refresh({ freeBytes: async () => 1024 })).toBe("skipped-low-disk");
    expect(existsSync(mirrorPath())).toBe(true);
  });

  test("repeated fetches are compacted", async () => {
    expect(await refresh()).toBe("built");
    // Above the pack limit, each fetch of even one commit keeps its own pack.
    await fs.appendFile(path.join(mirrorPath(), "config"), "[fetch]\n\tunpackLimit = 1\n");
    for (let index = 0; index < 32; index += 1) {
      commit(`file-${index}.txt`, `${index}\n`);
      await refresh();
    }
    const packs = (await fs.readdir(path.join(mirrorPath(), "objects", "pack"))).filter((name) =>
      name.endsWith(".pack"),
    );
    expect(packs.length).toBeLessThanOrEqual(31);
    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full"]);
  }, 60_000);
});

describe("concurrency", () => {
  /** Runs the setup script's own clone path against the mirror, as a launch does. */
  function launchClone(dest: string): Promise<{ code: number | null; stdout: string }> {
    const harness = `
set -e
YELLOW=""; NC=""
eval "$(sed -n '/^git_mirror_problem() {/,/^}$/p; /^report_git_mirror_outcome() {/,/^}$/p; /^clone_from_git_mirror() {/,/^}$/p; /^clone_repository() {/,/^}$/p' "$1")"
clone_repository "$2" "$3"
`;
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", harness, "--", setupScript, `file://${remote}`, dest], {
        env: { ...process.env, ORKESTRATOR_GIT_MIRROR: mirrorPath() },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });
  }

  test.each(["anonymous", "github-pat"] as const)(
    "changed access to %s cancels a blocked writer and reconciles the latest reader",
    async (kind) => {
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const run: typeof runCommand = async (command, args, options) => {
        if (args?.includes("fetch")) {
          started();
          await blocked;
        }
        return runCommand(command, args, options);
      };
      const first = refresh({ run }, project(), {
        kind: "github-pat",
        token: "old-token",
        generation: "11111111-1111-1111-1111-111111111111",
        localRemote: true,
      });
      await entered;
      const second = refresh({}, project(), {
        kind,
        token: kind === "anonymous" ? undefined : "new-token",
        generation: kind === "anonymous" ? undefined : "22222222-2222-2222-2222-222222222222",
        localRemote: true,
      });
      release();
      expect(await first).toBe("built");
      expect(await second).toBe("built");
      expect(
        existsSync(
          mirrorPath(
            kind === "anonymous" ? kind : "github-pat-22222222-2222-2222-2222-222222222222",
          ),
        ),
      ).toBe(true);
      expect(existsSync(mirrorPath("github-pat-11111111-1111-1111-1111-111111111111"))).toBe(false);
      expect(await readState()).toMatchObject({ access: kind });
    },
  );

  test("fresh authenticated binds never expose either reader's predecessor", async () => {
    const alice = {
      kind: "github-pat",
      token: "alice",
      localRemote: true,
      generation: "11111111-1111-1111-1111-111111111111",
    } as const;
    const bob = { ...alice, token: "bob", generation: "22222222-2222-2222-2222-222222222222" };
    const oldMirror = mirrorPath("github-pat-" + alice.generation);
    const newMirror = mirrorPath("github-pat-" + bob.generation);
    await gitMirrorContainerArguments(dataDir, project(), alice.kind, alice.generation);
    expect(await refresh({}, project(), alice)).toBe("built");
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    await gitMirrorContainerArguments(dataDir, project(), bob.kind, bob.generation);
    const next = refresh(
      {
        accountLogin: async () => {
          started();
          await blocked;
          return "bob";
        },
      },
      project(),
      bob,
    );
    await entered;
    expect(existsSync(newMirror)).toBe(false);
    release();
    expect(await next).toBe("built");
    expect(existsSync(oldMirror)).toBe(false);
    expect(existsSync(newMirror)).toBe(true);
  });

  test("shutdown during account lookup withdraws the old mirror without publication", async () => {
    const access = { kind: "github-pat", token: "token", localRemote: true } as const;
    expect(await refresh({}, project(), access)).toBe("built");
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = refresh(
      {
        accountLogin: async () => {
          started();
          await blocked;
          return undefined;
        },
      },
      project(),
      access,
    );
    await entered;
    const stopped = stopProjectGitMirrorRefreshes(dataDir);
    release();
    expect(await next).toBe("cancelled");
    await stopped;
    expect(existsSync(mirrorPath("github-pat"))).toBe(false);
  });

  test("launches arriving during a refresh join it", async () => {
    let fetches = 0;
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) fetches += 1;
      return runCommand(command, args, options);
    };

    const outcomes = await Promise.all([refresh({ run }), refresh({ run }), refresh({ run })]);

    expect(outcomes).toEqual(["built", "built", "built"]);
    expect(fetches).toBe(1);
  });

  test("two launches and refreshes at once leave a valid mirror and whole clones", async () => {
    expect(await refresh()).toBe("built");
    // A real history, so the clones overlap the fetch and the compaction.
    for (let index = 0; index < 8; index += 1) commit(`seed-${index}.txt`, `${index}\n`);
    await refresh();

    const clones: Promise<{ code: number | null; stdout: string }>[] = [];
    const refreshes: Promise<unknown>[] = [];
    for (let round = 0; round < 6; round += 1) {
      commit(`round-${round}.txt`, `${round}\n`);
      clones.push(launchClone(path.join(root, `env-${round}-a`)));
      clones.push(launchClone(path.join(root, `env-${round}-b`)));
      refreshes.push(refresh());
      refreshes.push(refresh());
      if (round === 3) {
        refreshes.push(
          runCommand("git", [`--git-dir=${mirrorPath()}`, "gc", "--quiet"]).catch(() => undefined),
        );
      }
      await refreshes.at(-1);
    }
    const results = await Promise.all(clones);
    await Promise.all(refreshes);

    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "log", "-1", "--format=%s", "main"])).toBe(
      "change round-5.txt",
    );
    for (const [index, result] of results.entries()) {
      expect(result.code).toBe(0);
      const dest = path.join(root, `env-${Math.floor(index / 2)}-${index % 2 === 0 ? "a" : "b"}`);
      expect(existsSync(path.join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
      git(dest, ["fsck"]);
    }
    expect(results.some((result) => result.stdout.includes("ORKESTRATOR_GIT_MIRROR:used"))).toBe(
      true,
    );
  }, 120_000);
});

describe("removal", () => {
  test("removing the project removes its mirror through the project's cleanup", async () => {
    expect(await refresh()).toBe("built");

    await cleanupProjectForRemoval(
      PROJECT_ID,
      context as unknown as CommandContext,
      new Map() as never,
    );

    expect(existsSync(projectDir())).toBe(false);
  });

  test("a project with no mirror removes cleanly", async () => {
    await removeProjectGitMirror(context, PROJECT_ID);
    expect(existsSync(projectDir())).toBe(false);
  });

  test("a refresh in progress is stopped and leaves nothing behind", async () => {
    let started: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) {
        started();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return runCommand(command, args, options);
    };
    const refreshing = refresh({ run });
    await fetching;

    await removeProjectGitMirror(context, PROJECT_ID);

    expect(await refreshing).toBe("cancelled");
    expect(existsSync(projectDir())).toBe(false);
  });

  test("the sweep removes only mirrors whose project is gone, once settled", async () => {
    expect(await refresh()).toBe("built");
    const orphan = path.join(dataDir, "git-mirrors", "project-gone");
    await fs.mkdir(path.join(orphan, "mount", "mirror.git"), { recursive: true });
    const stray = path.join(dataDir, "git-mirrors", "not a project id");
    await fs.mkdir(stray);
    const live = new Set([PROJECT_ID]);

    expect(await sweepOrphanedProjectGitMirrors(dataDir, live, 60_000)).toBe(0);
    expect(existsSync(orphan)).toBe(true);

    const later = () => Date.now() + 120_000;
    expect(await sweepOrphanedProjectGitMirrors(dataDir, live, 60_000, later)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(mirrorPath())).toBe(true);
    expect(existsSync(stray)).toBe(true);
  });

  test("a sweep with no settling age takes a mirror changed in the current millisecond", async () => {
    const orphan = path.join(dataDir, "git-mirrors", "project-gone");
    await fs.mkdir(path.join(orphan, "mount"), { recursive: true });
    // Half a millisecond into the clock's current millisecond, as a change
    // just made reads on a filesystem with sub-millisecond timestamps.
    const changedAtMs = 1_700_000_000_000;
    await fs.utimes(orphan, (changedAtMs + 0.5) / 1000, (changedAtMs + 0.5) / 1000);
    expect((await fs.lstat(orphan)).mtimeMs).toBeGreaterThan(changedAtMs);

    expect(await sweepOrphanedProjectGitMirrors(dataDir, new Set(), 0, () => changedAtMs)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  test("the sweep's owner set comes from a store that exists, or not at all", async () => {
    await expect(storage.loadProjectIdsForCleanup()).rejects.toThrow("cleanup refused");
    await storage.addProject({
      id: PROJECT_ID,
      gitUrl: `file://${remote}`,
      name: "p",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    } as never);
    expect(await storage.loadProjectIdsForCleanup()).toEqual(new Set([PROJECT_ID]));
  });
});

describe("container arguments", () => {
  test("a read-only bind of its own access kind's mount, and the path the setup script reads", async () => {
    for (const kind of ["anonymous", "github-pat", "github-host-cli"] as const) {
      const args = await gitMirrorContainerArguments(dataDir, { id: PROJECT_ID }, kind);

      expect(args).toEqual([
        "-v",
        `${mountPath(kind)}:${CONTAINER_GIT_MIRROR_MOUNT}:ro`,
        "-e",
        `ORKESTRATOR_GIT_MIRROR=${CONTAINER_GIT_MIRROR_PATH}`,
      ]);
      expect((await fs.stat(mountPath(kind))).mode & 0o777).toBe(0o755);
    }
    // Binding one kind never creates the legacy mount every container shared.
    expect(existsSync(path.join(projectDir(), "mount"))).toBe(false);
  });

  test("a path `-v` cannot express gives no mount rather than a failed create", async () => {
    const colon = path.join(root, "da:ta");
    expect(await gitMirrorContainerArguments(colon, { id: PROJECT_ID }, "anonymous")).toEqual([]);
  });

  test("an unusable data directory gives no mount and does not throw", async () => {
    const file = path.join(root, "file");
    await fs.writeFile(file, "");
    expect(await gitMirrorContainerArguments(file, { id: PROJECT_ID }, "anonymous")).toEqual([]);
  });
});

test("a clone report during fetch survives publication and is verified next time", async () => {
  expect(await refresh()).toBe("built");
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run: typeof runCommand = async (command, args, options) => {
    if (args?.includes("fetch")) {
      started();
      await gate;
    }
    return runCommand(command, args, options);
  };
  const pending = refresh({ run });
  await fetching;
  try {
    await noteGitMirrorCloneOutcome("\x1eORKESTRATOR_GIT_MIRROR:corrupt\x1f", dataDir, PROJECT_ID);
  } finally {
    release();
  }
  expect(await pending).toBe("fetched");
  expect(JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8")).suspect).toBe(
    true,
  );
  let verified = false;
  expect(
    await refresh({
      run: (command, args, options) => {
        if (args?.includes("fsck")) verified = true;
        return runCommand(command, args, options);
      },
    }),
  ).toBe("fetched");
  expect(verified).toBe(true);
  expect(JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8")).suspect).toBe(
    false,
  );
});

describe("review regressions", () => {
  const access = (generation: string): GitMirrorAccess => ({
    kind: "github-pat",
    token: "token",
    localRemote: true,
    generation,
  });
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";

  test("oversized backoff survives a fresh authenticated generation", async () => {
    const options = { force: false, now: () => 100000000, maxBytes: 1 };
    expect(await refresh(options, project(), access(first))).toBe("oversized");
    let commands = 0;
    expect(
      await refresh(
        {
          ...options,
          run: async () => {
            commands++;
            throw new Error("unexpected transfer");
          },
        },
        project(),
        access(second),
      ),
    ).toBe("skipped-oversized");
    expect(commands).toBe(0);
    expect(existsSync(mirrorPath("github-pat-" + first))).toBe(false);
  });

  test("failed-attempt backoff survives a fresh authenticated generation", async () => {
    const options = {
      force: false,
      now: () => 100000000,
      run: async () => {
        throw new Error("refused");
      },
    };
    expect(await refresh(options, project(), access(first))).toBe("failed");
    expect(await refresh(options, project(), access(second))).toBe("skipped-recent");
  });

  test("successful-attempt interval survives a fresh authenticated generation", async () => {
    const options = { force: false, now: () => 100000000 };
    expect(await refresh(options, project(), access(first))).toBe("built");
    expect(await refresh(options, project(), access(second))).toBe("skipped-recent");
    expect(existsSync(mirrorPath("github-pat-" + first))).toBe(false);
    expect(existsSync(mirrorPath("github-pat-" + second))).toBe(false);
  });

  test.each([undefined, "less-privileged-token"])(
    "credential sync withdraws old publication and drains a blocked fetch (%s)",
    async (token) => {
      const old = access(first);
      expect(await refresh({}, project(), old)).toBe("built");
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const run: typeof runCommand = async (command, args, options) => {
        if (args?.includes("fetch")) {
          started();
          await blocked;
        }
        return runCommand(command, args, options);
      };
      const running = refresh({ run }, project(), old);
      await entered;
      try {
        await withDockerScript(
          `#!/bin/sh
[ ! -e '${mirrorPath("github-pat-" + first)}' ] || exit 1
cat >/dev/null
exit 0
`,
          async () => {
            const sync = syncRuntimeGitHubCredential(
              { projectId: PROJECT_ID } as Environment,
              "fixture-container",
              token,
              context,
            );
            release();
            await sync;
          },
        );
        expect(await running).toBe("cancelled");
        expect(existsSync(mirrorPath("github-pat-" + first))).toBe(false);
      } finally {
        release();
        await running;
      }
    },
  );

  test("outer permission failure includes the ownership remediation", async () => {
    const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    configureLogger({
      sink: (entry) => {
        if (entry.record) entries.push(entry.record);
      },
    });
    try {
      const error = Object.assign(new Error("denied"), { code: "EACCES" });
      expect(
        await refresh({
          freeBytes: async () => {
            throw error;
          },
        }),
      ).toBe("failed");
      expect(
        entries.find((entry) => entry.event === "git-mirror.refresh-failed")?.fields?.remediation,
      ).toContain("Restore backend-user ownership");
    } finally {
      resetLogger();
    }
  });
});
