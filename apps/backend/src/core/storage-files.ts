import { createHash, isCanonicalUuid, path } from "./storage-shared.js";

/**
 * Paths of the stores more than one repository names, and of the files kept
 * beside the database (session buffers, Kanban images).
 *
 * Each store is named by one helper here, so every repository that reads or
 * writes it, and every lease taken on it, uses the same path.
 * `storage-writer-guards.test.ts` groups writers by these helper names
 * (`kanbanFile` and so on). A store only one repository uses keeps its helper
 * in that repository.
 */
export class StorageFiles {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  file(name: string): string {
    return path.join(this.dataDir, name);
  }

  projectsFile(): string {
    return this.file("projects.json");
  }

  environmentsFile(): string {
    return this.file("environments.json");
  }

  environmentFinalPrFile(): string {
    return this.file("environment-final-pr.json");
  }

  configFile(): string {
    return this.file("config.json");
  }

  agentPlatformsFile(): string {
    return this.file("agent-platforms.json");
  }

  openCodeModelCatalogFile(): string {
    return this.file("opencode-model-catalog.json");
  }

  agentModelCatalogFile(): string {
    return this.file("agent-model-catalog.json");
  }

  sessionsFile(): string {
    return this.file("sessions.json");
  }

  paneLayoutsFile(): string {
    return this.file("pane-layouts.json");
  }

  multiReviewsFile(): string {
    return this.file("multi-reviews.json");
  }

  buildPipelinesFile(): string {
    return this.file("build-pipelines.json");
  }

  nativeAgentSessionsFile(): string {
    return this.file("native-agent-sessions.json");
  }

  agentInteractionJournalFile(): string {
    return this.file("agent-interaction-resolution-journal.json");
  }

  promptQueuesFile(): string {
    return this.file("prompt-queues.json");
  }

  composeDraftsFile(): string {
    return this.file("compose-drafts.json");
  }

  fileDraftsFile(): string {
    return this.file("file-drafts.json");
  }

  agentHandoffsFile(): string {
    return this.file("agent-handoffs.json");
  }

  agentMailFile(): string {
    return this.file("agent-mail.json");
  }

  coordinatorsFile(): string {
    return this.file("coordinators.json");
  }

  bugReportsFile(): string {
    return this.file("bug-reports.json");
  }

  kanbanFile(): string {
    return this.file("kanban.json");
  }

  projectNotesFile(): string {
    return this.file("project-notes.json");
  }

  featurePlansFile(): string {
    return this.file("feature-plans.json");
  }

  linearAuthFile(): string {
    return this.file("linear-auth.json");
  }

  linearCompletionCommentsFile(): string {
    return this.file("linear-completion-comments.json");
  }

  githubCompletionCommentsFile(): string {
    return this.file("github-completion-comments.json");
  }

  githubCompletionCommentLockTarget(pipelineId: string): string {
    const key = createHash("sha256").update(pipelineId).digest("hex");
    return this.file(path.join("github-completion-comment-locks", key));
  }

  buffersDir(): string {
    return path.join(this.dataDir, "buffers");
  }

  bufferFile(sessionId: string): string {
    return path.join(this.buffersDir(), `${sessionId}.txt`);
  }

  kanbanImagesDir(): string {
    return path.join(this.dataDir, "kanban-images");
  }

  kanbanImageFile(imageId: string): string {
    if (!isCanonicalUuid(imageId)) {
      throw new Error("Kanban image ID is invalid");
    }
    return path.join(this.kanbanImagesDir(), `${imageId}.webp`);
  }
}
