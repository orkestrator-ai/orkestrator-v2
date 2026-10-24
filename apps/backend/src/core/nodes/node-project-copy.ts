import { randomUUID } from "node:crypto";

import { repositoryHint, type NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import {
  MAX_PROJECT_COPY_RECORDS,
  MAX_PROJECT_COPY_BYTES,
  MAX_PROJECT_COPY_FILES,
  PROJECT_COPY_CHANGED_EVENT,
  type ProjectCopyCandidate,
  type ProjectCopyFileList,
  type ProjectCopyOptions,
  type ProjectCopyRecord,
} from "@orkestrator/protocol/project-copy";

import {
  MAX_TRANSFER_BYTES,
  MAX_TRANSFER_FILES,
  type NodeFileInvoker,
  type NodeFileTransfer,
} from "./node-file-transfer.js";

/**
 * Copies a project from one machine to another (see
 * `@orkestrator/protocol/project-copy`). Runs on the command node for any
 * pair of machines it controls, itself included:
 *
 * 1. clone the project's Git remote on the target (in the background there,
 *    polled, because a clone can outlast one node call);
 * 2. expand the user's selection of untracked and ignored paths on the
 *    source and copy the files in bounded batches through the file-transfer
 *    framework, never replacing a file the target already has;
 * 3. copy the repository settings that describe the project rather than the
 *    machine.
 *
 * The source is never changed. A copy that fails after its clone keeps the
 * clone; running it again skips the clone and copies what is missing.
 */

const CLONE_POLL_MS = 1_500;
const CLONE_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_FAILED_CLONE_POLLS = 10;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function unknownCommand(error: unknown, command: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(command) && /unknown|not found|unsupported/i.test(text);
}

function repositoryName(gitUrl: string, fallback: string): string {
  const hint = repositoryHint(gitUrl);
  return hint?.split("/").at(-1) || fallback;
}

/** Settings that describe the project, not the machine. */
const COPIED_REPOSITORY_SETTINGS = [
  "defaultBranch",
  "prBaseBranch",
  "defaultPortMappings",
  "entryPort",
  "agentSettings",
] as const;

export interface NodeProjectCopiesOptions {
  selfId(): Promise<string>;
  selfName(): Promise<string>;
  summaries(nodeIds?: string[]): Promise<NodeSummariesResult>;
  invokerFor: NodeFileInvoker;
  transfer: NodeFileTransfer;
  emit(event: string, payload: unknown): void;
  /** Ran after a copy finishes, successful or not (approved coordinator requests). */
  onFinished?(record: ProjectCopyRecord): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export class NodeProjectCopies {
  private records: ProjectCopyRecord[] = [];
  private readonly running = new Map<string, Promise<void>>();
  /** Starts in flight by request key, so a resent start joins the first. */
  private readonly starting = new Map<string, Promise<ProjectCopyRecord>>();
  /** Runs per copy, so a run again clones under a fresh key rather than replaying a failure. */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: NodeProjectCopiesOptions) {}

  list(): ProjectCopyRecord[] {
    return structuredClone(this.records);
  }

  get(copyId: string): ProjectCopyRecord | null {
    const record = this.records.find((entry) => entry.copyId === copyId);
    return record ? structuredClone(record) : null;
  }

  /** Resolves when the copy's background run has finished (tests, approvals). */
  settled(copyId: string): Promise<void> {
    return this.running.get(copyId) ?? Promise.resolve();
  }

  private async nodeName(nodeId: string, self: string): Promise<string> {
    if (nodeId === self) return this.deps.selfName();
    const summaries = await this.deps.summaries([nodeId]);
    return summaries.nodes[0]?.view.displayName ?? nodeId;
  }

  private async project(nodeId: string, projectId: string): Promise<JsonRecord> {
    const project = await this.deps.invokerFor(nodeId)<unknown>("get_project", {
      projectId,
    });
    if (!isRecord(project)) throw new Error("That project does not exist on that machine.");
    return project;
  }

  /** The target's copy of a repository, if it has one. */
  private async targetProject(
    targetNodeId: string,
    hint: string | undefined,
  ): Promise<{ projectId: string; localPath: string | null } | null> {
    if (!hint) return null;
    const projects = await this.deps.invokerFor(targetNodeId)<unknown>("get_projects", {});
    const match = (Array.isArray(projects) ? projects : []).find(
      (entry): entry is JsonRecord =>
        isRecord(entry) && repositoryHint(entry.gitUrl) === hint && typeof entry.id === "string",
    );
    if (!match) return null;
    return {
      projectId: String(match.id),
      localPath: typeof match.localPath === "string" ? match.localPath : null,
    };
  }

  /** What the copy dialog needs: the source, every target and the candidate files. */
  async copyOptions(input: { nodeId: string; projectId: string }): Promise<ProjectCopyOptions> {
    const self = await this.deps.selfId();
    const source = await this.project(input.nodeId, input.projectId);
    const gitUrl = typeof source.gitUrl === "string" && source.gitUrl ? source.gitUrl : null;
    const hint = repositoryHint(gitUrl);
    const name = typeof source.name === "string" ? source.name : input.projectId;
    const [summaries, listing] = await Promise.all([
      this.deps.summaries(),
      this.deps
        .invokerFor(input.nodeId)<{
          candidates: ProjectCopyCandidate[];
          truncated: boolean;
        }>("list_project_copy_candidates", { projectId: input.projectId })
        .catch((error: unknown) => {
          if (unknownCommand(error, "list_project_copy_candidates")) {
            throw new Error("Update Orkestrator on that machine to copy its projects.");
          }
          throw error;
        }),
    ]);
    const machines = [
      { nodeId: self, nodeName: await this.deps.selfName(), available: true },
      ...summaries.nodes.map((node) => ({
        nodeId: node.nodeId,
        nodeName: node.view.displayName,
        available: node.available,
      })),
    ].filter((machine) => machine.nodeId !== input.nodeId);
    const folder = repositoryName(gitUrl ?? "", name);
    const targets = await Promise.all(
      machines.map(async (machine): Promise<ProjectCopyOptions["targets"][number]> => {
        const base = {
          ...machine,
          hasProject: false,
          projectId: null,
          defaultLocation: null,
        };
        if (!machine.available) {
          return {
            ...base,
            unavailableReason: `${machine.nodeName} is not connected.`,
          };
        }
        try {
          const existing = await this.targetProject(machine.nodeId, hint);
          if (existing) {
            return {
              ...base,
              hasProject: true,
              projectId: existing.projectId,
              defaultLocation: existing.localPath,
            };
          }
          const location = await this.deps
            .invokerFor(machine.nodeId)<{ location: string }>("get_default_project_location", {
              name: folder,
            })
            .catch(() => null);
          return { ...base, defaultLocation: location?.location ?? null };
        } catch (error) {
          return { ...base, unavailableReason: message(error) };
        }
      }),
    );
    return {
      source: {
        nodeId: input.nodeId,
        projectId: input.projectId,
        nodeName: await this.nodeName(input.nodeId, self),
        projectName: name,
        gitUrl,
      },
      targets,
      candidates: listing.candidates,
      candidatesTruncated: listing.truncated,
      limits: { files: MAX_PROJECT_COPY_FILES, bytes: MAX_PROJECT_COPY_BYTES },
    };
  }

  private publish(record: ProjectCopyRecord): void {
    this.deps.emit(PROJECT_COPY_CHANGED_EVENT, {
      copyId: record.copyId,
      stage: record.stage,
    });
  }

  private update(record: ProjectCopyRecord, change: Partial<ProjectCopyRecord>): void {
    Object.assign(record, change);
    this.publish(record);
  }

  /**
   * Start a copy, or return the one already started under this request key.
   * A failed copy started again under its key runs again, reusing whatever
   * the first attempt left on the target.
   */
  async start(input: {
    requestKey: string;
    source: { nodeId: string; projectId: string };
    target: { nodeId: string; location?: string };
    paths: string[];
    rememberFiles: boolean;
    actionRequestId?: string;
  }): Promise<ProjectCopyRecord> {
    const requestKey = input.requestKey.trim().slice(0, 200);
    if (!requestKey) throw new Error("Expected requestKey.");
    const inFlight = this.starting.get(requestKey);
    if (inFlight) return inFlight;
    const started = this.startOnce({ ...input, requestKey }).finally(() => {
      if (this.starting.get(requestKey) === started) this.starting.delete(requestKey);
    });
    this.starting.set(requestKey, started);
    return started;
  }

  private async startOnce(input: {
    requestKey: string;
    source: { nodeId: string; projectId: string };
    target: { nodeId: string; location?: string };
    paths: string[];
    rememberFiles: boolean;
    actionRequestId?: string;
  }): Promise<ProjectCopyRecord> {
    const { requestKey } = input;
    if (input.paths.length > 2_000) throw new Error("Pick at most 2,000 paths.");
    const existing = this.records.find((entry) => entry.requestKey === requestKey);
    if (existing && (existing.stage !== "failed" || this.running.has(existing.copyId))) {
      return structuredClone(existing);
    }
    if (input.source.nodeId === input.target.nodeId) {
      throw new Error("Pick a different machine to copy to.");
    }
    const self = await this.deps.selfId();
    const source = await this.project(input.source.nodeId, input.source.projectId);
    const gitUrl = typeof source.gitUrl === "string" ? source.gitUrl : "";
    if (!gitUrl) throw new Error("This project has no Git remote, so it cannot be cloned.");
    const sourceName = typeof source.name === "string" ? source.name : input.source.projectId;
    const [sourceNodeName, targetNodeName] = await Promise.all([
      this.nodeName(input.source.nodeId, self),
      this.nodeName(input.target.nodeId, self),
    ]);
    if (input.target.nodeId !== self) {
      const node = (await this.deps.summaries([input.target.nodeId])).nodes[0];
      if (!node) throw new Error("That machine is not one this command node controls.");
      if (!node.available) throw new Error(`${node.view.displayName} is not connected.`);
    }
    const location = input.target.location?.trim();
    if (location !== undefined && location !== "" && !location.startsWith("/")) {
      throw new Error("The location must be an absolute path on that machine.");
    }
    if (this.running.size >= MAX_PROJECT_COPY_RECORDS) {
      throw new Error("Too many project copies are running; retry later.");
    }
    const record: ProjectCopyRecord = existing ?? {
      copyId: randomUUID(),
      requestKey,
      source: {
        nodeId: input.source.nodeId,
        projectId: input.source.projectId,
        nodeName: sourceNodeName,
        projectName: sourceName,
      },
      target: {
        nodeId: input.target.nodeId,
        nodeName: targetNodeName,
        location: location ?? "",
        projectId: null,
      },
      paths: [...new Set(input.paths)],
      rememberFiles: input.rememberFiles,
      stage: "queued",
      reusedProject: false,
      progress: { files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 },
      skipped: 0,
      tooLarge: [],
      startedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
      ...(input.actionRequestId ? { actionRequestId: input.actionRequestId } : {}),
    };
    if (existing) {
      delete record.error;
      delete record.finishedAt;
      record.stage = "queued";
    } else {
      // Active copies remain queryable even when terminal history is full.
      const terminal = this.records.filter(
        (entry) =>
          entry.stage === "completed" ||
          (entry.stage === "failed" && !this.running.has(entry.copyId)),
      );
      const historySlots = Math.max(
        0,
        MAX_PROJECT_COPY_RECORDS - (this.records.length - terminal.length) - 1,
      );
      const retained = new Set(historySlots ? terminal.slice(-historySlots) : []);
      for (const entry of terminal) {
        if (!retained.has(entry)) this.attempts.delete(entry.copyId);
      }
      this.records = this.records.filter(
        (entry) => !terminal.includes(entry) || retained.has(entry),
      );
      this.records.push(record);
    }
    this.publish(record);
    const run = this.run(record, gitUrl)
      .catch((error: unknown) => {
        this.update(record, {
          stage: "failed",
          finishedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
          error: {
            code:
              typeof (error as { code?: unknown } | null)?.code === "string"
                ? (error as { code: string }).code
                : "failed",
            message: message(error),
          },
        });
      })
      .finally(() => {
        this.running.delete(record.copyId);
        this.deps.onFinished?.(structuredClone(record));
      });
    this.running.set(record.copyId, run);
    return structuredClone(record);
  }

  private async run(record: ProjectCopyRecord, gitUrl: string): Promise<void> {
    const target = this.deps.invokerFor(record.target.nodeId);
    const source = this.deps.invokerFor(record.source.nodeId);
    const hint = repositoryHint(gitUrl);

    // 1. The project on the target: an existing copy, or a fresh clone.
    const existing = await this.targetProject(record.target.nodeId, hint);
    if (existing) {
      this.update(record, {
        // A run again keeps what the first run found: a copy that was there before.
        reusedProject: record.reusedProject || !record.target.projectId,
        target: {
          ...record.target,
          projectId: existing.projectId,
          location: existing.localPath ?? record.target.location,
        },
      });
    } else {
      if (!record.target.location) {
        const resolved = await target<{ location: string }>("get_default_project_location", {
          name: repositoryName(gitUrl, record.source.projectName),
        }).catch((error: unknown) => {
          if (unknownCommand(error, "get_default_project_location")) {
            throw new Error(
              `Update Orkestrator on ${record.target.nodeName} to copy projects to it.`,
            );
          }
          throw error;
        });
        record.target.location = resolved.location;
      }
      this.update(record, { stage: "cloning" });
      record.target.projectId = await this.clone(record, gitUrl);
      this.publish(record);
    }
    const targetProjectId = record.target.projectId;
    if (!targetProjectId) throw new Error("The copy has no project on the target.");

    // 2. The selected files.
    let list: ProjectCopyFileList = {
      files: [],
      totalBytes: 0,
      skipped: 0,
      tooLarge: [],
    };
    if (record.paths.length > 0) {
      this.update(record, { stage: "listing" });
      list = await source<ProjectCopyFileList>("list_project_copy_files", {
        projectId: record.source.projectId,
        paths: record.paths,
      }).catch((error: unknown) => {
        if (unknownCommand(error, "list_project_copy_files")) {
          throw new Error(`Update Orkestrator on ${record.source.nodeName} to copy its projects.`);
        }
        throw error;
      });
      this.update(record, {
        stage: "copying",
        skipped: list.skipped,
        tooLarge: list.tooLarge,
        progress: {
          files: 0,
          totalFiles: list.files.length,
          bytes: 0,
          totalBytes: list.totalBytes,
        },
      });
      for (const batch of batches(list.files)) {
        const receipt = await this.deps.transfer.transfer({
          from: {
            nodeId: record.source.nodeId,
            scope: { projectId: record.source.projectId },
          },
          to: {
            nodeId: record.target.nodeId,
            scope: { projectId: targetProjectId },
          },
          files: batch.map((file) => file.path),
          overwrite: false,
          skipExisting: true,
          actor: `project copy ${record.copyId}`,
          onFile: (file) => {
            record.progress.files += 1;
            record.progress.bytes += file.bytes;
            if (file.skipped) {
              record.progress.existing = (record.progress.existing ?? 0) + 1;
              record.progress.existingBytes = (record.progress.existingBytes ?? 0) + file.bytes;
            }
            this.publish(record);
          },
        });
        if (receipt.status !== "completed") {
          throw Object.assign(new Error(receipt.error?.message ?? "Copying files failed."), {
            code: receipt.error?.code ?? "failed",
          });
        }
      }
    }

    // 3. Repository settings.
    this.update(record, { stage: "configuring" });
    await this.copySettings(record, targetProjectId, list);

    this.update(record, {
      stage: "completed",
      finishedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });
  }

  /** Clone on the target and wait for it; returns the new project's ID there. */
  private async clone(record: ProjectCopyRecord, gitUrl: string): Promise<string> {
    const target = this.deps.invokerFor(record.target.nodeId);
    const attempt = (this.attempts.get(record.copyId) ?? 0) + 1;
    this.attempts.set(record.copyId, attempt);
    const requestKey = `copy:${record.copyId}:${attempt}`;
    const started = await target<{
      state: string;
      projectId?: string;
      error?: string;
    }>("start_project_clone", {
      requestKey,
      gitUrl,
      localPath: record.target.location,
    }).catch((error: unknown) => {
      if (unknownCommand(error, "start_project_clone")) {
        throw new Error(`Update Orkestrator on ${record.target.nodeName} to copy projects to it.`);
      }
      throw error;
    });
    const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    const deadline = (this.deps.now ?? Date.now)() + CLONE_TIMEOUT_MS;
    let job = started;
    let failedPolls = 0;
    while (job.state === "running") {
      if ((this.deps.now ?? Date.now)() > deadline) {
        throw new Error(`Cloning on ${record.target.nodeName} took longer than an hour.`);
      }
      await sleep(CLONE_POLL_MS);
      try {
        job = await target<{ state: string; projectId?: string; error?: string }>(
          "get_project_clone",
          { requestKey },
        );
        failedPolls = 0;
      } catch (error) {
        // A dropped poll is not a failed clone; a node that stays away is.
        failedPolls += 1;
        if (failedPolls >= MAX_FAILED_CLONE_POLLS) throw error;
      }
    }
    if (job.state === "completed" && job.projectId) return job.projectId;
    if (job.state === "failed") {
      throw Object.assign(new Error(job.error ?? "The clone failed."), {
        code: "clone-failed",
      });
    }
    // The target restarted mid-clone: its project list is the only witness.
    const found = await this.targetProject(record.target.nodeId, repositoryHint(gitUrl));
    if (found) return found.projectId;
    throw Object.assign(
      new Error(`${record.target.nodeName} restarted while cloning. Copy again to retry.`),
      { code: "clone-unknown" },
    );
  }

  private async copySettings(
    record: ProjectCopyRecord,
    targetProjectId: string,
    list: ProjectCopyFileList,
  ): Promise<void> {
    const source = this.deps.invokerFor(record.source.nodeId);
    const target = this.deps.invokerFor(record.target.nodeId);
    const remembered = record.rememberFiles ? list.files.map((file) => file.path) : [];
    if (record.reusedProject) {
      if (remembered.length === 0) return;
      const current = await target<JsonRecord>("get_repository_config", {
        projectId: targetProjectId,
      });
      const files = Array.isArray(current.filesToCopy) ? (current.filesToCopy as string[]) : [];
      await target("update_repository_config", {
        projectId: targetProjectId,
        repoConfig: {
          ...current,
          filesToCopy: [...new Set([...files, ...remembered])],
        },
      });
      return;
    }
    const sourceConfig = await source<JsonRecord>("get_repository_config", {
      projectId: record.source.projectId,
    });
    const targetConfig = await target<JsonRecord>("get_repository_config", {
      projectId: targetProjectId,
    });
    const copied: JsonRecord = { ...targetConfig };
    for (const key of COPIED_REPOSITORY_SETTINGS) {
      if (sourceConfig[key] !== undefined) copied[key] = sourceConfig[key];
    }
    // Source requirements may name ignored files the user did not select.
    // Only the user's remembered selection becomes a requirement on a new copy.
    copied.filesToCopy = remembered;
    await target("update_repository_config", {
      projectId: targetProjectId,
      repoConfig: copied,
    });
  }
}

/** Groups of files under one transfer's limits. */
function batches(files: ProjectCopyFileList["files"]): Array<ProjectCopyFileList["files"]> {
  const result: Array<ProjectCopyFileList["files"]> = [];
  let current: ProjectCopyFileList["files"] = [];
  let bytes = 0;
  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length >= MAX_TRANSFER_FILES || bytes + file.bytes > MAX_TRANSFER_BYTES)
    ) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.bytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}
