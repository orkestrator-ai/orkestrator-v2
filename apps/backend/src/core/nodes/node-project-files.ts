import { randomBytes } from "node:crypto";

import type { BackendId } from "@orkestrator/protocol/federation";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";

import { normalizeConfiguredProjectFiles } from "../commands-project-files.js";
import type { StorageService } from "../storage.js";
import type { NodeActionRequest } from "./node-action-requests.js";
import { NodeFileTransfer, type NodeFileInvoker } from "./node-file-transfer.js";
import { NodeFiles } from "./node-files.js";
import type { NodePortal } from "./node-portal.js";
import type { NodeService } from "./node-service.js";

/**
 * A project's `.env` and selected files across the nodes that have the
 * project (matched by repository identity).
 *
 * - Seed files: an environment created on a leaf gets these files from the
 *   leaf's project root; any the leaf lacks are copied from this command
 *   node's project root into the leaf's staging area first. The leaf's own
 *   copy always wins.
 * - Compare: for each node, which files are missing, extra, the same or
 *   different, and for `.env` files which keys were added, removed or
 *   changed. Values are compared by fingerprint under a one-time key and are
 *   never returned.
 * - Update and reveal run only as approved action requests; content and
 *   values move backend to backend, never through a model.
 */

export interface FileComparison {
  nodeId: string;
  nodeName: string;
  projectId: string | null;
  available: boolean;
  files: Array<{
    path: string;
    status: "same" | "differs" | "missing-on-node" | "only-on-node" | "missing-everywhere";
    keys?: { added: string[]; removed: string[]; changed: string[]; same: number };
  }>;
  error?: string;
}

type Fingerprint = {
  path: string;
  exists: boolean;
  file?: string;
  envKeys?: Record<string, string>;
};

export class NodeProjectFiles {
  readonly transfer: NodeFileTransfer;

  constructor(
    private readonly options: {
      storage: StorageService;
      nodes: NodeService;
      portal: NodePortal;
      local: NodeFiles;
      /** Local file commands by name (the same ones a leaf registers). */
      localInvoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
      deliverToConversation(input: {
        environmentId: string;
        tabId: string;
        subject: string;
        body: string;
        requestId: string;
      }): Promise<void>;
    },
  ) {
    this.transfer = new NodeFileTransfer({ invokerFor: this.invokerFor });
  }

  /** This node directly; another through the command node's link. */
  readonly invokerFor: NodeFileInvoker = (nodeId) => {
    return async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      const self = await this.options.nodes.selfIdentity();
      if (nodeId === self) return this.options.localInvoke<T>(command, args);
      const routed = await this.options.portal.invokeOnNode({ nodeId, command, args });
      if (routed.outcome !== "ok") {
        throw Object.assign(new Error("The connection was lost before the node answered."), {
          code: "outcome-unknown",
        });
      }
      return routed.result as T;
    };
  };

  private async localProjectByRepository(hint: string | undefined) {
    if (!hint) return null;
    const projects = await this.options.storage.loadProjects();
    return (
      projects.find((project) => repositoryHint(project.gitUrl) === hint && project.localPath) ??
      null
    );
  }

  /** The files compared and seeded for a project: `.env`, `.env.local` and its selection. */
  private async selectedFiles(localProjectId: string): Promise<string[]> {
    const config = await this.options.storage.getRepositoryConfig(localProjectId);
    return [
      ...new Set([".env", ".env.local", ...normalizeConfiguredProjectFiles(config.filesToCopy)]),
    ];
  }

  /**
   * Before a routed `create_environment` starts on a leaf: copy the seed
   * files the leaf's project root lacks from this node's copy of the project.
   */
  async seedEnvironment(
    nodeId: BackendId,
    leafProjectId: string,
    environmentId: string,
  ): Promise<void> {
    const summaries = await this.options.portal.summaries([nodeId]);
    const leafProject = summaries.nodes[0]?.projects.find(
      (project) => project.ref.projectId === leafProjectId,
    );
    const local = await this.localProjectByRepository(leafProject?.repositoryHint);
    if (!local) return;
    const invoke = this.invokerFor(nodeId);
    const seed = await invoke<Array<{ path: string; exists: boolean }>>("get_project_seed_files", {
      projectId: leafProjectId,
    });
    const selected = await this.selectedFiles(local.id);
    const leafMissing = seed
      .filter((entry) => !entry.exists && selected.includes(entry.path))
      .map((entry) => entry.path);
    const wanted = [
      ...new Set([
        ...leafMissing,
        ...selected.filter((entry) => !seed.some((item) => item.path === entry)),
      ]),
    ];
    const available: string[] = [];
    for (const entry of wanted) {
      if ((await this.options.local.stat({ projectId: local.id }, entry)).exists)
        available.push(entry);
    }
    if (available.length === 0) return;
    const self = await this.options.nodes.selfIdentity();
    const receipt = await this.transfer.transfer({
      from: { nodeId: self, scope: { projectId: local.id } },
      to: { nodeId, scope: { seedEnvironmentId: environmentId } },
      files: available,
      overwrite: true,
      actor: "environment setup",
    });
    if (receipt.status !== "completed") {
      console.warn(
        "[nodes] Seed files for a leaf environment were not all copied:",
        receipt.error?.code,
      );
    }
  }

  /** Nodes with a copy of the project, and that copy's project ID there. */
  private async nodesWithProject(localProjectId: string, nodeIds?: string[]) {
    const project = await this.options.storage.getProject(localProjectId);
    const hint = repositoryHint(project?.gitUrl);
    const summaries = await this.options.portal.summaries(nodeIds);
    return summaries.nodes.map((node) => ({
      node,
      projectId: hint
        ? (node.projects.find((candidate) => candidate.repositoryHint === hint)?.ref.projectId ??
          null)
        : null,
    }));
  }

  async compare(
    localProjectId: string,
    nodeIds?: string[],
  ): Promise<{ files: string[]; nodes: FileComparison[] }> {
    const files = await this.selectedFiles(localProjectId);
    const key = randomBytes(32);
    const mine = await this.options.local.fingerprints(localProjectId, files, key);
    const results: FileComparison[] = [];
    for (const { node, projectId } of await this.nodesWithProject(localProjectId, nodeIds)) {
      const entry: FileComparison = {
        nodeId: node.nodeId,
        nodeName: node.view.displayName,
        projectId,
        available: node.available,
        files: [],
      };
      if (!projectId || !node.available) {
        entry.error = !projectId
          ? "That node has no copy of this project."
          : "That node is not connected.";
        results.push(entry);
        continue;
      }
      try {
        const theirs = await this.invokerFor(node.nodeId)<Fingerprint[]>(
          "fingerprint_project_files",
          {
            projectId,
            files,
            key: key.toString("base64"),
          },
        );
        entry.files = files.map((file) => compareOne(file, mine, theirs));
      } catch (error) {
        entry.error = error instanceof Error ? error.message.slice(0, 200) : "Comparison failed.";
      }
      results.push(entry);
    }
    return { files, nodes: results };
  }

  /** Approved: push this node's files (or keys) to the named nodes. */
  async executeUpdate(request: NodeActionRequest) {
    const self = await this.options.nodes.selfIdentity();
    const localProjectId = request.requestedBy.projectId;
    const done: string[] = [];
    for (const target of request.targets) {
      if (!target.projectId) throw new Error(`No project on ${target.nodeName} to update.`);
      const files = target.files ?? [];
      if (target.keys?.length) {
        for (const file of files) {
          const values = await this.options.local.envValues(localProjectId, file, target.keys);
          const remove = target.keys.filter((key) => !(key in values));
          await this.invokerFor(target.nodeId)("apply_env_keys", {
            projectId: target.projectId,
            path: file,
            set: values,
            remove,
          });
        }
        done.push(`${target.keys.length} key(s) of ${files.join(", ")} on ${target.nodeName}`);
        continue;
      }
      const receipt = await this.transfer.transfer({
        from: { nodeId: self, scope: { projectId: localProjectId } },
        to: { nodeId: target.nodeId, scope: { projectId: target.projectId } },
        files,
        overwrite: true,
        actor: `approved request ${request.requestId}`,
      });
      if (receipt.status !== "completed") {
        throw Object.assign(new Error(receipt.error?.message ?? "The update failed."), {
          code: receipt.error?.code ?? "failed",
        });
      }
      done.push(`${files.join(", ")} on ${target.nodeName}`);
    }
    return { code: "updated", message: `Updated ${done.join("; ")}.` };
  }

  /** Approved: read the values and mail them to the asking conversation only. */
  async executeReveal(request: NodeActionRequest) {
    const self = await this.options.nodes.selfIdentity();
    const lines: string[] = [];
    for (const target of request.targets) {
      const file = target.files?.[0];
      if (!file || !target.keys?.length) throw new Error("A reveal names a file and keys.");
      const projectId = target.nodeId === self ? request.requestedBy.projectId : target.projectId;
      if (!projectId) throw new Error(`No project on ${target.nodeName}.`);
      const values = await this.invokerFor(target.nodeId)<Record<string, string>>(
        "read_env_values",
        {
          projectId,
          path: file,
          keys: target.keys,
        },
      );
      for (const key of target.keys) {
        lines.push(
          `${key} (${file} on ${target.nodeName}) = ${key in values ? values[key] : "(not set)"}`,
        );
      }
    }
    // The values go to the requesting conversation's mailbox only, never
    // into the request record.
    await this.options.deliverToConversation({
      environmentId: request.requestedBy.coordinatorEnvironmentId,
      tabId: request.requestedBy.coordinatorTabId,
      subject: "Approved: the values you asked for",
      body: lines.join("\n"),
      requestId: `node-reveal:${request.requestId}`,
    });
    return { code: "revealed", message: "The values were sent to the requesting conversation." };
  }
}

function compareOne(file: string, mine: Fingerprint[], theirs: Fingerprint[]) {
  const local = mine.find((entry) => entry.path === file);
  const remote = theirs.find((entry) => entry.path === file);
  if (!local?.exists && !remote?.exists)
    return { path: file, status: "missing-everywhere" as const };
  if (local?.exists && !remote?.exists) return { path: file, status: "missing-on-node" as const };
  if (!local?.exists && remote?.exists) return { path: file, status: "only-on-node" as const };
  const status = local!.file === remote!.file ? ("same" as const) : ("differs" as const);
  if (!local!.envKeys || !remote!.envKeys) return { path: file, status };
  const added = Object.keys(remote!.envKeys).filter((key) => !(key in local!.envKeys!));
  const removed = Object.keys(local!.envKeys).filter((key) => !(key in remote!.envKeys!));
  const shared = Object.keys(local!.envKeys).filter((key) => key in remote!.envKeys!);
  const changed = shared.filter((key) => local!.envKeys![key] !== remote!.envKeys![key]);
  return {
    path: file,
    status,
    keys: {
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
      same: shared.length - changed.length,
    },
  };
}
