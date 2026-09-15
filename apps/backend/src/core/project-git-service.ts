import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ProjectGitBranch,
  ProjectGitError,
  ProjectGitStatus,
  ProjectGitSwitchConfirmation,
  ProjectGitSwitchOptions,
} from "@orkestrator/protocol/coordinator";
import { CommandFailedError, runCommand } from "./shell.js";
import type { StorageService } from "./storage.js";

const FETCH_COOLDOWN_MS = 60_000;
const CONFIRMATION_TTL_MS = 120_000;
const MAX_ERROR_CHARS = 4_000;
const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
] as const;

type CheckoutInspection = {
  fingerprint: string;
  untrackedFiles: number;
  nestedRepositories: string[];
  dirtySubmodules: string[];
};

function isDiscardableDirty(status: ProjectGitStatus): boolean {
  return (
    (status.trackedChanges > 0 || status.untrackedChanges > 0) &&
    !status.mergeInProgress &&
    !status.rebaseInProgress &&
    !status.sequencerInProgress &&
    status.conflicts === 0
  );
}

function operationBlockedReason(
  ongoing: readonly string[],
  conflicts: number,
  dirty: boolean,
): string | null {
  if (ongoing.includes("MERGE_HEAD")) return "Finish the current merge first.";
  if (ongoing.includes("rebase-merge") || ongoing.includes("rebase-apply")) {
    return "Finish the current rebase first.";
  }
  if (ongoing.includes("CHERRY_PICK_HEAD")) return "Finish the current cherry-pick first.";
  if (ongoing.includes("REVERT_HEAD")) return "Finish the current revert first.";
  if (ongoing.includes("sequencer")) return "Finish the current sequencer operation first.";
  if (conflicts > 0) return "Resolve repository conflicts first.";
  if (dirty) return "Commit or discard local checkout changes before switching or syncing.";
  return null;
}

function cleanErrorText(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{16,}\b/gi, "[REDACTED]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+\b/gi, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

function gitError(operation: ProjectGitError["operation"], error: unknown): ProjectGitError {
  return {
    operation,
    message: cleanErrorText(error) || `Git ${operation} failed`,
    ...(error instanceof CommandFailedError && error.exitCode !== null
      ? { exitCode: error.exitCode }
      : {}),
    ...(error instanceof Error ? { stderr: cleanErrorText(error) } : {}),
    occurredAt: new Date().toISOString(),
    retryable: true,
  };
}

type Operation = ProjectGitStatus["operationState"];

export async function resolveProjectGitRoot(
  storage: StorageService,
  projectId: string,
): Promise<string> {
  const project = await storage.getProject(projectId);
  if (!project?.localPath?.trim()) throw new Error("This project has no local checkout configured");
  const requested = await fs.realpath(project.localPath).catch(() => null);
  if (!requested) throw new Error("The configured local checkout is unavailable");
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    timeoutMs: 10_000,
  }).catch(() => {
    throw new Error("The configured local checkout is not a Git repository");
  });
  const root = await fs.realpath(result.stdout.trim());
  if (path.normalize(root) !== path.normalize(requested)) {
    throw new Error("Project.localPath must identify the repository root");
  }
  return root;
}

/** Serialized, checkout-root-bound Git operations for project coordinators. */
export class ProjectGitService {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly activeMutations = new Set<string>();
  private readonly pendingTurns = new Map<string, number>();
  private readonly fetches = new Map<
    string,
    { force: boolean; promise: Promise<ProjectGitStatus> }
  >();
  private readonly confirmations = new Map<
    string,
    {
      token: string;
      ref: string;
      fingerprint: string;
      expiresAt: number;
    }
  >();

  constructor(
    private readonly storage: StorageService,
    private readonly hasActiveCoordinatorTurns: (
      projectId: string,
    ) => Promise<boolean> = async () => false,
  ) {}

  isMutationActive(projectId: string): boolean {
    return this.activeMutations.has(projectId);
  }

  beginCoordinatorTurn(projectId: string): () => void {
    if (this.activeMutations.has(projectId)) {
      throw new Error("The project checkout is changing; wait for the Git operation to finish");
    }
    this.pendingTurns.set(projectId, (this.pendingTurns.get(projectId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pendingTurns.get(projectId) ?? 1) - 1;
      if (remaining > 0) this.pendingTurns.set(projectId, remaining);
      else this.pendingTurns.delete(projectId);
    };
  }

  private serialize<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(root) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(root, settled);
    void settled.finally(() => {
      if (this.operations.get(root) === settled) this.operations.delete(root);
    });
    return next;
  }

  private async root(projectId: string): Promise<string> {
    return resolveProjectGitRoot(this.storage, projectId);
  }

  private async operationState(projectId: string, state: Operation): Promise<void> {
    await this.storage.mutateCoordinatorWorkspace(projectId, (workspace) =>
      workspace
        ? {
            ...workspace,
            repositoryStatus: workspace.repositoryStatus
              ? { ...workspace.repositoryStatus, operationState: state }
              : undefined,
            updatedAt: new Date().toISOString(),
          }
        : null,
    );
  }

  private async occupiedBranches(root: string): Promise<Map<string, string>> {
    const output = (await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: root }))
      .stdout;
    const occupied = new Map<string, string>();
    let worktree = "";
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) worktree = line.slice(9);
      if (line.startsWith("branch refs/heads/") && worktree) {
        occupied.set(line.slice("branch refs/heads/".length), worktree);
      }
      if (!line.trim()) worktree = "";
    }
    return occupied;
  }

  private async branches(root: string): Promise<ProjectGitBranch[]> {
    const [refs, occupied] = await Promise.all([
      runCommand(
        "git",
        [
          "for-each-ref",
          "--format=%(refname)%00%(refname:short)%00%(upstream:short)",
          "refs/heads",
          "refs/remotes",
        ],
        { cwd: root, timeoutMs: 10_000 },
      ),
      this.occupiedBranches(root),
    ]);
    return refs.stdout
      .split("\n")
      .flatMap((line): ProjectGitBranch[] => {
        if (!line) return [];
        const [ref, name, upstream] = line.split("\0");
        if (!ref || !name || ref.endsWith("/HEAD")) return [];
        if (ref.startsWith("refs/heads/")) {
          const localName = ref.slice("refs/heads/".length);
          const occupiedPath = occupied.get(localName);
          return [
            {
              ref,
              name: localName,
              kind: "local",
              ...(upstream ? { trackingBranch: upstream } : {}),
              ...(occupiedPath && path.normalize(occupiedPath) !== path.normalize(root)
                ? { occupiedWorktreePath: occupiedPath }
                : {}),
            },
          ];
        }
        if (ref.startsWith("refs/remotes/")) {
          const remoteName = ref.slice("refs/remotes/".length);
          const slash = remoteName.indexOf("/");
          if (slash <= 0) return [];
          return [{ ref, name: remoteName, kind: "remote", remote: remoteName.slice(0, slash) }];
        }
        return [];
      })
      .slice(0, 2_000);
  }

  private async inspectCheckout(root: string, status: ProjectGitStatus): Promise<CheckoutInspection> {
    const [indexTree, trackedDiff, unstagedDiff, untrackedList, cleanPreview, submoduleStatus] =
      await Promise.all([
        runCommand("git", ["write-tree"], { cwd: root, timeoutMs: 10_000 }).catch(() => ({
          stdout: "",
        })),
        status.headCommit
          ? runCommand("git", ["diff-index", "--raw", "-z", "HEAD"], {
              cwd: root,
              timeoutMs: 10_000,
            }).catch(() => ({ stdout: "" }))
          : runCommand("git", ["diff", "--cached", "--raw", "-z"], {
              cwd: root,
              timeoutMs: 10_000,
            }).catch(() => ({ stdout: "" })),
        runCommand("git", ["diff", "--raw", "-z"], { cwd: root, timeoutMs: 10_000 }).catch(() => ({
          stdout: "",
        })),
        runCommand("git", ["ls-files", "-z", "-o", "--exclude-standard"], {
          cwd: root,
          timeoutMs: 10_000,
        }),
        runCommand("git", ["clean", "-ndff"], { cwd: root, timeoutMs: 10_000 }).catch(() => ({
          stdout: "",
        })),
        runCommand("git", ["submodule", "status", "--recursive"], {
          cwd: root,
          timeoutMs: 10_000,
        }).catch(() => ({ stdout: "" })),
      ]);
    const untrackedPaths = untrackedList.stdout.split("\0").filter(Boolean);
    const untrackedHashes = await Promise.all(
      untrackedPaths.map(async (relative) => {
        const hashed = await runCommand("git", ["hash-object", "--", relative], {
          cwd: root,
          timeoutMs: 10_000,
        }).catch(() => ({ stdout: "" }));
        return `${relative}\0${hashed.stdout.trim()}`;
      }),
    );
    const nestedFromClean = cleanPreview.stdout.split("\n").flatMap((line) => {
      const match = /(?:Would skip|Skipping) repository (.+)$/.exec(line.trim());
      return match?.[1] ? [match[1].replace(/\/$/, "")] : [];
    });
    const nestedFromWorktree = (
      await Promise.all(
        untrackedPaths.map(async (relative) => {
          const abs = path.resolve(root, relative);
          const stat = await fs.lstat(abs).catch(() => null);
          if (!stat?.isDirectory()) return null;
          return fs.access(path.join(abs, ".git")).then(
            () => relative.replace(/\/$/, ""),
            () => null,
          );
        }),
      )
    ).filter((item): item is string => Boolean(item));
    const nestedRepositories = [...new Set([...nestedFromClean, ...nestedFromWorktree])];
    const dirtyFromStatus = submoduleStatus.stdout.split("\n").flatMap((line) => {
      const match = /^[+\-U][0-9a-f]+\s+(\S+)/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
    const dirtyFromWorktrees = (
      await runCommand(
        "git",
        [
          "submodule",
          "foreach",
          "--recursive",
          "--quiet",
          'test -z "$(git status --porcelain)" || printf "%s\\n" "$displaypath"',
        ],
        { cwd: root, timeoutMs: 20_000 },
      ).catch(() => ({ stdout: "" }))
    ).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const dirtySubmodules = [...new Set([...dirtyFromStatus, ...dirtyFromWorktrees])];
    const fingerprint = createHash("sha256")
      .update(status.headCommit ?? "unborn")
      .update("\0")
      .update(indexTree.stdout.trim())
      .update("\0")
      .update(trackedDiff.stdout)
      .update("\0")
      .update(unstagedDiff.stdout)
      .update("\0")
      .update(untrackedHashes.join("\n"))
      .update("\0")
      .update(nestedRepositories.join("\n"))
      .update("\0")
      .update(dirtySubmodules.join("\n"))
      .update("\0")
      .update(
        [
          status.mergeInProgress ? "merge" : "",
          status.rebaseInProgress ? "rebase" : "",
          status.sequencerInProgress ? "sequencer" : "",
          String(status.conflicts),
        ].join(","),
      )
      .digest("hex");
    return {
      fingerprint,
      untrackedFiles: untrackedPaths.length,
      nestedRepositories,
      dirtySubmodules,
    };
  }

  private consumeConfirmation(
    projectId: string,
    ref: string,
    token: string | undefined,
    inspection: CheckoutInspection,
  ): void {
    if (!token) {
      throw new Error("Confirm the current checkout before discarding changes.");
    }
    const pending = this.confirmations.get(projectId);
    this.confirmations.delete(projectId);
    if (!pending || pending.token !== token) {
      throw new Error("Confirm the current checkout before discarding changes.");
    }
    if (pending.ref !== ref) {
      throw new Error("The discard confirmation does not match this branch switch.");
    }
    if (pending.expiresAt <= Date.now()) {
      throw new Error(
        "The discard confirmation expired. Review the current changes and confirm again.",
      );
    }
    if (pending.fingerprint !== inspection.fingerprint) {
      throw new Error(
        `The checkout changed after confirmation (${inspection.untrackedFiles} untracked files). Review the updated changes and confirm again.`,
      );
    }
  }

  private async readStatus(
    projectId: string,
    root: string,
    previous?: ProjectGitStatus,
  ): Promise<ProjectGitStatus> {
    const [porcelain, head, upstream, operations, branches] = await Promise.all([
      runCommand("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], {
        cwd: root,
        timeoutMs: 10_000,
      }),
      runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, timeoutMs: 10_000 }).catch(
        () => ({ stdout: "", stderr: "" }),
      ),
      runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
        cwd: root,
        timeoutMs: 10_000,
      }).catch(() => ({ stdout: "", stderr: "" })),
      Promise.all(
        OPERATION_MARKERS.map(async (name) => {
          const gitPath = (
            await runCommand("git", ["rev-parse", "--git-path", name], {
              cwd: root,
              timeoutMs: 10_000,
            })
          ).stdout.trim();
          return fs.access(path.resolve(root, gitPath)).then(
            () => name,
            () => null,
          );
        }),
      ),
      this.branches(root),
    ]);
    let branch: string | null = null;
    let detached = false;
    let unborn = false;
    let ahead: number | null = null;
    let behind: number | null = null;
    let trackedChanges = 0;
    let untrackedChanges = 0;
    let conflicts = 0;
    for (const line of porcelain.stdout.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice(14).trim();
        detached = value === "(detached)";
        unborn = value === "(initial)";
        branch = detached || unborn ? null : value;
      } else if (line.startsWith("# branch.ab ")) {
        const match = /\+(\d+)\s+-(\d+)/.exec(line);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (line.startsWith("? ")) untrackedChanges += 1;
      else if (line.startsWith("u ")) conflicts += 1;
      else if (line.startsWith("1 ") || line.startsWith("2 ")) trackedChanges += 1;
    }
    const upstreamName = upstream.stdout.trim() || null;
    const remote = upstreamName?.includes("/")
      ? upstreamName.slice(0, upstreamName.indexOf("/"))
      : null;
    const ongoing = operations.filter(
      (item): item is (typeof OPERATION_MARKERS)[number] => item !== null,
    );
    const mergeInProgress = ongoing.includes("MERGE_HEAD");
    const rebaseInProgress = ongoing.includes("rebase-merge") || ongoing.includes("rebase-apply");
    const sequencerInProgress =
      ongoing.includes("CHERRY_PICK_HEAD") ||
      ongoing.includes("REVERT_HEAD") ||
      ongoing.includes("sequencer");
    const blockedReason = operationBlockedReason(
      ongoing,
      conflicts,
      trackedChanges + untrackedChanges > 0,
    );
    return {
      projectId,
      repositoryRoot: root,
      revision: (previous?.revision ?? 0) + 1,
      branch,
      detached,
      unborn,
      headCommit: head.stdout.trim() || null,
      upstream: upstreamName,
      remote,
      ahead: upstreamName ? ahead : null,
      behind: upstreamName ? behind : null,
      remoteState: previous?.fetchedAt ? previous.remoteState : "unknown",
      fetchedAt: previous?.fetchedAt ?? null,
      trackedChanges,
      untrackedChanges,
      conflicts,
      mergeInProgress,
      rebaseInProgress,
      sequencerInProgress,
      operationState: "idle",
      repositoryOperationBlockedReason: blockedReason,
      branches,
      lastError: previous?.lastError ?? null,
    };
  }

  private async persist(projectId: string, status: ProjectGitStatus): Promise<ProjectGitStatus> {
    let persisted = status;
    await this.storage.mutateCoordinatorWorkspace(projectId, (workspace) => {
      if (!workspace) return null;
      const previous = workspace.repositoryStatus;
      if (previous) {
        const { revision: _previousRevision, ...previousMaterial } = previous;
        const { revision: _nextRevision, ...nextMaterial } = status;
        if (JSON.stringify(previousMaterial) === JSON.stringify(nextMaterial)) {
          persisted = previous;
          return workspace;
        }
      }
      const changedContext =
        previous &&
        (previous.headCommit !== status.headCommit || previous.branch !== status.branch);
      const repositoryContextRevision =
        workspace.repositoryContextRevision + (changedContext ? 1 : 0);
      return {
        ...workspace,
        repositoryStatus: status,
        repositoryContextRevision,
        ...(changedContext
          ? {
              repositoryContextEvents: [
                ...(workspace.repositoryContextEvents ?? []),
                {
                  revision: repositoryContextRevision,
                  branch: status.branch,
                  headCommit: status.headCommit,
                  occurredAt: new Date().toISOString(),
                },
              ].slice(-32),
            }
          : {}),
        updatedAt: new Date().toISOString(),
      };
    });
    return persisted;
  }

  async status(projectId: string): Promise<ProjectGitStatus> {
    const root = await this.root(projectId);
    return this.serialize(root, async () => {
      const workspace = await this.storage.getCoordinatorWorkspace(projectId);
      try {
        return await this.persist(
          projectId,
          await this.readStatus(projectId, root, workspace?.repositoryStatus),
        );
      } catch (error) {
        const previous = workspace?.repositoryStatus;
        if (!previous) throw error;
        return this.persist(projectId, {
          ...previous,
          operationState: "idle",
          lastError: gitError("status", error),
        });
      }
    });
  }

  async fetch(projectId: string, force = false): Promise<ProjectGitStatus> {
    const existing = this.fetches.get(projectId);
    if (existing) {
      if (existing.force || !force) return existing.promise;
      return existing.promise.then(() => this.fetch(projectId, true));
    }
    const operation = (async () => {
      const root = await this.root(projectId);
      return this.serialize(root, async () => {
        const before = await this.readStatus(
          projectId,
          root,
          (await this.storage.getCoordinatorWorkspace(projectId))?.repositoryStatus,
        );
        await this.persist(projectId, before);
        if (
          !force &&
          before.fetchedAt &&
          Date.now() - Date.parse(before.fetchedAt) < FETCH_COOLDOWN_MS
        ) {
          return before;
        }
        const configuredRemotes = before.remote
          ? [before.remote]
          : (
              await runCommand("git", ["remote"], {
                cwd: root,
                timeoutMs: 10_000,
              })
            ).stdout
              .split("\n")
              .map((remote) => remote.trim())
              .filter(Boolean);
        if (configuredRemotes.length === 0) {
          return this.persist(projectId, {
            ...before,
            remoteState: "unknown",
            // A repository without remotes is a valid local-only state, so do
            // not retain an error that makes the checkout look broken.
            lastError: null,
          });
        }
        await this.operationState(projectId, "fetching");
        try {
          await runCommand(
            "git",
            before.remote ? ["fetch", "--prune", before.remote] : ["fetch", "--prune", "--all"],
            {
              cwd: root,
              timeoutMs: 60_000,
            },
          );
          const refreshed = await this.readStatus(projectId, root, before);
          refreshed.remoteState = "fresh";
          refreshed.fetchedAt = new Date().toISOString();
          refreshed.lastError = null;
          return this.persist(projectId, refreshed);
        } catch (error) {
          return this.persist(projectId, {
            ...before,
            operationState: "idle",
            remoteState: "stale",
            lastError: gitError("fetch", error),
          });
        }
      });
    })().finally(() => {
      if (this.fetches.get(projectId)?.promise === operation) this.fetches.delete(projectId);
    });
    this.fetches.set(projectId, { force, promise: operation });
    return operation;
  }

  private async mutation(
    projectId: string,
    state: "syncing" | "switching",
    action: (root: string, status: ProjectGitStatus) => Promise<void>,
    options: { allowDirty?: boolean } = {},
  ): Promise<ProjectGitStatus> {
    if (this.activeMutations.has(projectId)) {
      throw new Error("The project checkout is already changing");
    }
    if ((this.pendingTurns.get(projectId) ?? 0) > 0) {
      throw new Error("Wait for the coordinator turn to start before changing the checkout");
    }
    this.activeMutations.add(projectId);
    try {
      const root = await this.root(projectId);
      return await this.serialize(root, async () => {
        const before = await this.readStatus(
          projectId,
          root,
          (await this.storage.getCoordinatorWorkspace(projectId))?.repositoryStatus,
        );
        const dirty = before.trackedChanges > 0 || before.untrackedChanges > 0;
        const discardableDirty = isDiscardableDirty(before);
        if (before.repositoryOperationBlockedReason && !discardableDirty) {
          throw new Error(before.repositoryOperationBlockedReason);
        }
        if (dirty && !options.allowDirty) {
          throw new Error("Confirm the current checkout before discarding changes.");
        }
        await this.operationState(projectId, state);
        if (await this.hasActiveCoordinatorTurns(projectId)) {
          await this.operationState(projectId, "idle");
          throw new Error("Stop the active coordinator turn before changing the checkout");
        }
        try {
          await action(root, before);
          const refreshed = await this.readStatus(projectId, root, before);
          refreshed.lastError = null;
          return this.persist(projectId, refreshed);
        } catch (error) {
          const refreshed = await this.readStatus(projectId, root, before).catch(() => before);
          const lastError = gitError(state === "syncing" ? "sync" : "switch", error);
          refreshed.operationState = "idle";
          refreshed.lastError = lastError;
          await this.persist(projectId, refreshed);
          throw new Error(lastError.message);
        }
      });
    } finally {
      this.activeMutations.delete(projectId);
    }
  }

  async sync(projectId: string): Promise<ProjectGitStatus> {
    return this.mutation(projectId, "syncing", async (root, status) => {
      if (!status.branch || !status.upstream || !status.remote) {
        throw new Error("A tracking branch is required before syncing");
      }
      if ((status.ahead ?? 0) > 0 && (status.behind ?? 0) > 0) {
        throw new Error("The branch has diverged; automatic fast-forward sync is unavailable");
      }
      const remoteBranch = status.upstream.slice(status.remote.length + 1);
      await runCommand(
        "git",
        [
          "-c",
          "rebase.autoStash=false",
          "pull",
          "--ff-only",
          "--no-rebase",
          "--no-autostash",
          status.remote,
          remoteBranch,
        ],
        { cwd: root, timeoutMs: 60_000 },
      );
    });
  }

  async prepareSwitchBranch(
    projectId: string,
    ref: string,
  ): Promise<ProjectGitSwitchConfirmation> {
    if (this.activeMutations.has(projectId)) {
      throw new Error("The project checkout is already changing");
    }
    if ((this.pendingTurns.get(projectId) ?? 0) > 0) {
      throw new Error("Wait for the coordinator turn to start before changing the checkout");
    }
    const root = await this.root(projectId);
    return this.serialize(root, async () => {
      const before = await this.readStatus(
        projectId,
        root,
        (await this.storage.getCoordinatorWorkspace(projectId))?.repositoryStatus,
      );
      await this.persist(projectId, before);
      if (!isDiscardableDirty(before)) {
        throw new Error(
          before.repositoryOperationBlockedReason ??
            "There are no local changes to discard.",
        );
      }
      const branch = before.branches.find((item) => item.ref === ref);
      if (!branch) throw new Error("The selected branch is no longer available");
      if (branch.occupiedWorktreePath) {
        throw new Error("That branch is checked out in another worktree");
      }
      if (branch.kind === "remote") {
        if (!branch.remote) throw new Error("Remote branch identity is invalid");
        const remoteBranch = branch.name.slice(branch.remote.length + 1);
        if (before.branches.some((item) => item.kind === "local" && item.name === remoteBranch)) {
          throw new Error("A local branch with that name already exists");
        }
      }
      const inspection = await this.inspectCheckout(root, before);
      const token = randomUUID();
      const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
      this.confirmations.set(projectId, {
        token,
        ref,
        fingerprint: inspection.fingerprint,
        expiresAt,
      });
      return {
        token,
        projectId,
        ref,
        expiresAt: new Date(expiresAt).toISOString(),
        trackedChanges: before.trackedChanges,
        untrackedFiles: inspection.untrackedFiles,
        nestedRepositories: inspection.nestedRepositories,
        dirtySubmodules: inspection.dirtySubmodules,
        requiresEnhancedConfirmation:
          inspection.nestedRepositories.length > 0 || inspection.dirtySubmodules.length > 0,
      };
    });
  }

  async switchBranch(
    projectId: string,
    ref: string,
    discard: boolean | ProjectGitSwitchOptions = false,
  ): Promise<ProjectGitStatus> {
    const options: ProjectGitSwitchOptions =
      typeof discard === "boolean" ? {} : (discard ?? {});
    const confirmationToken =
      typeof discard === "boolean" ? undefined : options.confirmationToken;
    const allowDirty = Boolean(confirmationToken);
    return this.mutation(
      projectId,
      "switching",
      async (root, status) => {
        const branch = status.branches.find((item) => item.ref === ref);
        if (!branch) throw new Error("The selected branch is no longer available");
        if (branch.occupiedWorktreePath)
          throw new Error("That branch is checked out in another worktree");

        let switchArgs: string[];
        if (branch.kind === "local") {
          await runCommand("git", ["check-ref-format", "--branch", branch.name], { cwd: root });
          switchArgs = ["switch", branch.name];
        } else {
          if (!branch.remote) throw new Error("Remote branch identity is invalid");
          const remoteBranch = branch.name.slice(branch.remote.length + 1);
          await runCommand("git", ["check-ref-format", "--branch", remoteBranch], { cwd: root });
          if (status.branches.some((item) => item.kind === "local" && item.name === remoteBranch)) {
            throw new Error("A local branch with that name already exists");
          }
          switchArgs = ["switch", "--track", "-c", remoteBranch, branch.ref];
        }

        const dirty = status.trackedChanges > 0 || status.untrackedChanges > 0;
        if (dirty) {
          const inspection = await this.inspectCheckout(root, status);
          this.consumeConfirmation(projectId, ref, confirmationToken, inspection);
          const enhanced =
            options.includeNestedRepositories === true &&
            (inspection.nestedRepositories.length > 0 || inspection.dirtySubmodules.length > 0);
          if (
            (inspection.nestedRepositories.length > 0 || inspection.dirtySubmodules.length > 0) &&
            !enhanced
          ) {
            const names = [...inspection.nestedRepositories, ...inspection.dirtySubmodules].join(
              ", ",
            );
            throw new Error(
              `This checkout has nested repositories or dirty submodules (${names}) that a normal discard will not remove. Confirm deletion of those repositories to continue.`,
            );
          }
          if (enhanced) switchArgs.splice(1, 0, "--discard-changes", "--recurse-submodules");
          else switchArgs.splice(1, 0, "--discard-changes");
          await runCommand("git", switchArgs, { cwd: root, timeoutMs: 30_000 });
          await runCommand("git", ["clean", enhanced ? "-ff" : "-f", "-d"], {
            cwd: root,
            timeoutMs: 30_000,
          });
          return;
        }
        await runCommand("git", switchArgs, { cwd: root, timeoutMs: 30_000 });
      },
      { allowDirty },
    );
  }
}
