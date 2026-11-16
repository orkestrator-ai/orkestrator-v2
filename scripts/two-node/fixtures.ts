/**
 * Shared fixtures for the two-backend checks (`harness.ts`): created on first
 * use and reused.
 *
 * - `project(node)`: a Git checkout with a local bare `origin`, added to the
 *   node with the same repository identity ({@link REPOSITORY_URL}) on both
 *   nodes, so the nodes pair the two copies (ticket boards, coordinator mail).
 *   Each checkout has `fixtures/from-<role>.json`, distinct per node.
 * - `worker(node)`: a local environment whose worktree is ready, with one
 *   Agent (native) tab that never starts: the backends have no toolchain and
 *   no credentials.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { runSetup, until, type PeerNode } from "./harness.ts";

/** Both nodes' project copies name this remote, so they pair by repository. */
export const REPOSITORY_URL = "https://github.com/orkestrator-qualification/two-node.git";

export interface ProjectFixture {
  readonly node: PeerNode;
  readonly projectId: string;
  /** The checkout on disk (the project root). */
  readonly dir: string;
  /** The fixture file only this node's checkout has, relative to the root. */
  readonly ownFile: string;
  readonly ownContent: string;
}

export interface WorkerFixture {
  readonly node: PeerNode;
  readonly environmentId: string;
  readonly tabId: string;
  readonly worktree: string;
}

const git = (cwd: string, ...args: string[]) =>
  runSetup(
    "git",
    ["-c", "user.email=qualification@invalid.local", "-c", "user.name=Qualification", ...args],
    cwd,
  );

export class PairFixtures {
  private readonly projects = new Map<PeerNode, Promise<ProjectFixture>>();
  private readonly workers = new Map<PeerNode, Promise<WorkerFixture>>();

  constructor(
    /** Where fixture checkouts are written. */
    private readonly root: string,
  ) {}

  project(node: PeerNode): Promise<ProjectFixture> {
    let created = this.projects.get(node);
    if (!created) {
      created = this.createProject(node);
      this.projects.set(node, created);
    }
    return created;
  }

  worker(node: PeerNode): Promise<WorkerFixture> {
    let created = this.workers.get(node);
    if (!created) {
      created = this.createWorker(node);
      this.workers.set(node, created);
    }
    return created;
  }

  private async createProject(node: PeerNode): Promise<ProjectFixture> {
    const base = path.join(this.root, `${node.role}-repository`);
    const dir = path.join(base, "two-node");
    await mkdir(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    await writeFile(path.join(dir, "README.md"), "# two-node check\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    git(base, "clone", "-q", "--bare", dir, `${dir}.git`);
    git(dir, "remote", "add", "origin", `${dir}.git`);
    git(dir, "fetch", "-q", "origin");
    // Untracked, so only the project root has it (a transfer source).
    const ownFile = `fixtures/from-${node.role}.json`;
    const ownContent = `${JSON.stringify({ from: node.role })}\n`;
    await mkdir(path.join(dir, "fixtures"), { recursive: true });
    await writeFile(path.join(dir, ownFile), ownContent);
    const created = await node.invoke<{ id: string }>("add_project", {
      gitUrl: REPOSITORY_URL,
      localPath: dir,
    });
    return { node, projectId: created.id, dir, ownFile, ownContent };
  }

  private async createWorker(node: PeerNode): Promise<WorkerFixture> {
    const { projectId } = await this.project(node);
    const created = await node.invoke<{ id: string }>("create_environment", {
      projectId,
      name: `${node.role}-worker`,
      environmentType: "local",
    });
    await node.invoke("save_pane_layout", {
      environmentId: created.id,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [
            {
              id: "worker-tab",
              type: "agent-native",
              nativeAgentData: { environmentId: created.id, platform: "claude" },
            },
          ],
          activeTabId: "worker-tab",
        },
      },
      expectedRevision: 0,
    });
    await node.invoke("start_environment", { environmentId: created.id });
    const environment = await until(
      `${node.label}'s worker worktree`,
      () =>
        node.invoke<{ id: string; worktreePath?: string }>("get_environment", {
          environmentId: created.id,
        }),
      (value) => Boolean(value.worktreePath) && existsSync(value.worktreePath!),
      120_000,
    );
    return {
      node,
      environmentId: environment.id,
      tabId: "worker-tab",
      worktree: environment.worktreePath!,
    };
  }
}
