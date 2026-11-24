/**
 * Puts a Linear issue's files into an environment's workspace
 * (docs/architecture/tickets.md, "Linear files").
 *
 * Linear's file host needs the key, which only the backend holds, so the
 * backend downloads and agents receive ordinary files under
 * `.orkestrator/linear-files/` (Git-excluded). Two callers share this: a build
 * started from a Linear issue, before its first prompt, and the
 * `download_linear_files` agent tool.
 *
 * A caller never names an arbitrary file. The issue must be the one the
 * environment's build was started from, or be on the project's linked board,
 * and only files that issue itself refers to are fetched.
 *
 * Nothing here logs file names, links or contents.
 */
import path from "node:path";
import type { BuildPipeline, TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import { isBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  LINEAR_FILE_TOOL_NAME,
  LINEAR_FILES_DIRECTORY,
  MAX_LINEAR_ISSUE_FILES,
  linearFileReferences,
  linearFileUrl,
} from "@orkestrator/protocol/linear-files";
import { createLogger } from "@orkestrator/protocol/logger";
import {
  createGitEnvironmentCommandRunner,
  assertWorkspaceArtifactIsGitExcluded,
  setupWorkspaceArtifactGitExclude,
} from "../commands-review.js";
import type { EnvironmentMutationFence } from "../environments/index.js";
import { sanitizeLinearError, type LinearBoardFilter } from "../linear.js";
import type { Environment } from "../models.js";
import { writeConfinedFile } from "../path-safety.js";
import { detectedMimeTypeForImageData } from "../prompt-attachments.js";
import { runCommand } from "../shell.js";
import { linearBoardLinkKey, type StorageService } from "../storage/index.js";
import { writeContainerLinearFile } from "./container-write.js";
import { downloadLinearFile } from "./download.js";
import {
  issueFilesAreOnBoard,
  linearFileName,
  readLinearIssueFiles,
  safeFileName,
  type LinearIssueFile,
  type LinearIssueFiles,
} from "./issue-files.js";

const log = createLogger("linear");

const MEBIBYTE = 1024 * 1024;
export const MAX_LINEAR_FILE_BYTES = 50 * MEBIBYTE;
export const MAX_LINEAR_ISSUE_BYTES = 200 * MEBIBYTE;
/** Short of the minute after which providers give up on a tool call. */
export const LINEAR_FILE_TOOL_DEADLINE_MS = 50_000;
export const LINEAR_FILE_BUILD_DEADLINE_MS = 3 * 60_000;
const CONTAINER_WRITE_TIMEOUT_MS = 120_000;

/** Images kept on the build's ticket, for the prompt and the Ticket tab. */
const MAX_TICKET_IMAGES = 10;
const MAX_TICKET_IMAGE_BYTES = 2 * MEBIBYTE;
const MAX_TICKET_IMAGES_BYTES = 4 * MEBIBYTE;

export interface LinearFileScope {
  environmentId: string;
  projectId: string;
}

export interface DownloadedIssueFile {
  name: string;
  /** Relative to the workspace. */
  path: string;
  bytes: number;
  contentType?: string;
  url: string;
}

export interface FailedIssueFile {
  name?: string;
  url: string;
  reason: string;
}

export interface LinearFilesDownload {
  issue: string;
  files: DownloadedIssueFile[];
  failed: FailedIssueFile[];
}

/** What a build's first prompt gains from its ticket's files. */
export interface PreparedBuildFiles {
  section: string;
  images: TaskSnapshotImage[];
}

export interface LinearFileServiceDependencies {
  storage: Pick<
    StorageService,
    "getEnvironment" | "getProject" | "kanban" | "linear" | "listBuildPipelinesForEnvironment"
  >;
  fence: Pick<EnvironmentMutationFence, "beginMutation">;
  /** Runs Git in the workspace. */
  run?: typeof runCommand;
  writeContainer?: typeof writeContainerLinearFile;
  maxFileBytes?: number;
  maxIssueBytes?: number;
}

type LinearSource = Extract<NonNullable<BuildPipeline["source"]>, { type: "linear" }>;

function errorText(error: unknown, secret?: string): string {
  return sanitizeLinearError(error, secret).slice(0, 300);
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MEBIBYTE) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
}

export class LinearFileService {
  constructor(private readonly dependencies: LinearFileServiceDependencies) {}

  /** Whether the tool is worth listing: a Linear-sourced build, or a linked board. */
  async offered(scope: LinearFileScope): Promise<boolean> {
    if (await this.boardFor(scope.projectId)) return true;
    return (await this.sourceFor(scope)) !== null;
  }

  /** The `download_linear_files` tool. */
  async download(
    scope: LinearFileScope,
    input: { issueId?: string; urls?: readonly string[] } = {},
    deadlineMs = LINEAR_FILE_TOOL_DEADLINE_MS,
  ): Promise<LinearFilesDownload> {
    const deadline = Date.now() + deadlineMs;
    const signal = AbortSignal.timeout(deadlineMs);
    const source = await this.sourceFor(scope);
    const issueId = input.issueId ?? source?.issueId;
    if (!issueId) {
      throw new Error(
        "Name the Linear issue with issueId: this environment was not built from one.",
      );
    }
    const apiKey = await this.requireApiKey();
    const issue = await this.readIssue(apiKey, issueId, signal);
    if (issue.issueId !== source?.issueId) {
      const board = await this.boardFor(scope.projectId);
      if (!board || !issueFilesAreOnBoard(issue, board)) {
        throw new Error(
          `${issue.identifier ?? "That issue"} is not on this project's linked Linear board.`,
        );
      }
    }
    let files = issue.files;
    if (input.urls?.length) {
      files = [];
      for (const requested of input.urls) {
        const url = linearFileUrl(requested);
        const file = url ? issue.files.find((candidate) => candidate.url === url) : undefined;
        if (!file) {
          throw new Error(
            `${issue.identifier ?? "The issue"} does not refer to one of those files. Omit urls to download everything it refers to.`,
          );
        }
        if (!files.includes(file)) files.push(file);
      }
    }
    const { result } = await this.fetchInto(
      scope.environmentId,
      apiKey,
      issue,
      files,
      signal,
      deadline,
    );
    return result;
  }

  /**
   * Downloads the files a Linear-sourced build's ticket refers to, before its
   * first prompt. Null when there are none. Never throws: a build starts
   * without a file and is told why it is missing.
   */
  async prepareBuild(
    pipeline: Pick<BuildPipeline, "environmentId" | "projectId" | "source" | "taskSnapshot">,
    deadlineMs = LINEAR_FILE_BUILD_DEADLINE_MS,
    interrupted?: AbortSignal,
  ): Promise<PreparedBuildFiles | null> {
    const source = pipeline.source;
    if (source?.type !== "linear") return null;
    const { description, acceptanceCriteria, comments } = pipeline.taskSnapshot;
    // What the user chose to send: a build without comments gets no comment files.
    const quoted = linearFileReferences(
      [description, acceptanceCriteria, ...comments.map((comment) => comment.text)].join("\n\n"),
    );
    if (quoted.length === 0) return null;
    let apiKey: string | undefined;
    try {
      const deadline = Date.now() + deadlineMs;
      const timeout = AbortSignal.timeout(deadlineMs);
      const signal = interrupted ? AbortSignal.any([interrupted, timeout]) : timeout;
      apiKey = await this.requireApiKey();
      const issue = await this.readIssue(apiKey, source.issueId, signal);
      const files = quoted.flatMap((reference) => {
        const file = issue.files.find((candidate) => candidate.url === reference.url);
        return file ? [file] : [];
      });
      const { result, images } = await this.fetchInto(
        pipeline.environmentId,
        apiKey,
        issue,
        files,
        signal,
        deadline,
      );
      for (const reference of quoted) {
        if (files.some((file) => file.url === reference.url)) continue;
        result.failed.push({ ...reference, reason: "The Linear issue no longer refers to it." });
      }
      log.info("build-files.prepared", {
        downloaded: result.files.length,
        failed: result.failed.length,
      });
      return { section: buildFilesSection(result), images };
    } catch (error) {
      log.warn("build-files.failed", { files: quoted.length });
      const reason = errorText(error, apiKey);
      return {
        section: buildFilesSection({
          issue: source.issueIdentifier,
          files: [],
          failed: quoted.map((reference) => ({ ...reference, reason })),
        }),
        images: [],
      };
    }
  }

  private async sourceFor(scope: LinearFileScope): Promise<LinearSource | null> {
    const records = await this.dependencies.storage.listBuildPipelinesForEnvironment(
      scope.projectId,
      scope.environmentId,
    );
    const pipelines = records
      .map((record) => record.snapshot)
      .filter(
        (snapshot): snapshot is BuildPipeline =>
          isBuildPipeline(snapshot) &&
          snapshot.environmentId === scope.environmentId &&
          snapshot.projectId === scope.projectId &&
          snapshot.source?.type === "linear",
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const source = pipelines[0]?.source;
    return source?.type === "linear" ? source : null;
  }

  private async boardFor(projectId: string): Promise<LinearBoardFilter | null> {
    const project = await this.dependencies.storage.getProject(projectId);
    if (!project) return null;
    const link = await this.dependencies.storage.linear.getLinearBoardLink(
      linearBoardLinkKey(project),
    );
    if (!link?.teamId) return null;
    return {
      teamId: link.teamId,
      ...(link.linearProjectId ? { linearProjectId: link.linearProjectId } : {}),
    };
  }

  private async requireApiKey(): Promise<string> {
    const auth = await this.dependencies.storage.kanban.getLinearAuth();
    if (!auth?.apiKey) {
      throw new Error(
        "Linear is not connected on this machine. Ask the user to connect it from the project's Linear tab.",
      );
    }
    return auth.apiKey;
  }

  private async readIssue(
    apiKey: string,
    issueId: string,
    signal: AbortSignal,
  ): Promise<LinearIssueFiles> {
    try {
      return await readLinearIssueFiles(apiKey, issueId, { signal });
    } catch (error) {
      if (signal.aborted) throw new Error("Reading the Linear issue timed out.", { cause: error });
      // No cause: the original may hold the key this text had removed.
      throw new Error(errorText(error, apiKey));
    }
  }

  private async requireEnvironment(environmentId: string): Promise<Environment> {
    const environment = await this.dependencies.storage.getEnvironment(environmentId);
    const available =
      environment?.environmentType === "local"
        ? !!environment.worktreePath
        : !!environment?.containerId;
    if (!environment || !available) {
      throw new Error("This session has no workspace to download files into.");
    }
    return environment;
  }

  private async fetchInto(
    environmentId: string,
    apiKey: string,
    issue: LinearIssueFiles,
    files: readonly LinearIssueFile[],
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ result: LinearFilesDownload; images: TaskSnapshotImage[] }> {
    const label = issue.identifier ?? issue.issueId;
    const result: LinearFilesDownload = { issue: label, files: [], failed: [] };
    const images: TaskSnapshotImage[] = [];
    if (files.length === 0) return { result, images };
    const environment = await this.requireEnvironment(environmentId);
    const directory = `${LINEAR_FILES_DIRECTORY}/${safeFileName(label, 60) || "issue"}`;
    const runner = createGitEnvironmentCommandRunner(
      environment,
      this.dependencies.fence,
      signal,
      this.dependencies.run,
    );
    let setup = false;
    const maxFileBytes = this.dependencies.maxFileBytes ?? MAX_LINEAR_FILE_BYTES;
    let remaining = this.dependencies.maxIssueBytes ?? MAX_LINEAR_ISSUE_BYTES;
    let imageBytes = 0;
    for (const [index, { url, name }] of files.entries()) {
      const displayName = name ? safeFileName(name) || undefined : undefined;
      try {
        if (signal.aborted) throw new Error("There was no time left to download it.");
        if (index >= MAX_LINEAR_ISSUE_FILES) {
          throw new Error(
            `Only ${MAX_LINEAR_ISSUE_FILES} files can be downloaded at once. Request this file by URL.`,
          );
        }
        if (remaining <= 0) throw new Error("The issue's files together are too large.");
        const downloaded = await downloadLinearFile(apiKey, url, {
          maxBytes: Math.min(maxFileBytes, remaining),
          signal,
          onBytes: (bytes) => {
            remaining -= bytes;
          },
        });
        const { contents, contentType } = downloaded;
        const fileName = linearFileName(url);
        const filePath = `${directory}/${fileName}`;
        const release = this.dependencies.fence.beginMutation(environment.id);
        try {
          if (!setup) {
            await setupWorkspaceArtifactGitExclude(environment, runner, signal);
            setup = true;
          }
          if (await runner("git", ["ls-files", "--cached", "--", filePath], 10_000)) {
            throw new Error("The Linear file path is tracked by Git.");
          }
          await assertWorkspaceArtifactIsGitExcluded(runner, filePath, "Linear file path");
          signal.throwIfAborted();
          await this.write(environment, filePath, contents, maxFileBytes, signal, deadline);
        } finally {
          release();
        }
        result.files.push({
          name: name || safeFileName(downloaded.filename ?? "") || fileName,
          path: filePath,
          bytes: contents.byteLength,
          ...(contentType ? { contentType } : {}),
          url,
        });
        if (
          images.length < MAX_TICKET_IMAGES &&
          contents.byteLength <= MAX_TICKET_IMAGE_BYTES &&
          imageBytes + contents.byteLength <= MAX_TICKET_IMAGES_BYTES &&
          detectedMimeTypeForImageData(contents.subarray(0, 18).toString("base64"))
        ) {
          imageBytes += contents.byteLength;
          images.push({ filename: fileName, data: contents.toString("base64") });
        }
      } catch (error) {
        result.failed.push({
          url,
          ...(displayName ? { name: displayName } : {}),
          reason: signal.aborted
            ? "The file download timed out or was stopped."
            : errorText(error, apiKey),
        });
      }
    }
    return { result, images };
  }

  private async write(
    environment: Environment,
    filePath: string,
    contents: Buffer,
    maxBytes: number,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    try {
      if (environment.environmentType === "local") {
        await writeConfinedFile(environment.worktreePath!, filePath, contents, {
          exclusive: false,
          label: "Linear file path",
          maxBytes,
          fileMode: 0o644,
          signal,
        });
      } else {
        const publishBy = Math.min(deadline, Date.now() + CONTAINER_WRITE_TIMEOUT_MS);
        await (this.dependencies.writeContainer ?? writeContainerLinearFile)(
          environment.containerId!,
          path.posix.dirname(filePath),
          path.posix.basename(filePath),
          contents,
          signal,
          publishBy,
        );
      }
    } catch {
      // The writers' messages name host paths and other writers.
      throw new Error("The file could not be written to the workspace.");
    }
  }
}

/** Every value here is the backend's own text, a checked link or a sanitized name. */
function buildFilesSection(result: LinearFilesDownload): string {
  const lines = ["**Ticket files**"];
  if (result.files.length > 0) {
    lines.push(
      "Orkestrator downloaded these files of the ticket into the workspace. The directory is Git-excluded; copy what the change needs out of it.",
      ...result.files.map(
        (file) =>
          `- \`${file.path}\` (${safeFileName(file.name) || "file"}, ${sizeText(file.bytes)}): ${file.url}`,
      ),
    );
  }
  if (result.failed.length > 0) {
    lines.push(
      `${result.files.length > 0 ? "These files" : "The ticket refers to these files, which"} could not be downloaded:`,
      ...result.failed.map(
        (file) =>
          `- ${file.name ? `${safeFileName(file.name) || "file"} (${file.url})` : file.url}: ${file.reason}`,
      ),
      `Try the Orkestrator \`${LINEAR_FILE_TOOL_NAME}\` tool once. If the work depends on a file you still cannot get, stop and report the build blocked, saying which file is missing and why.`,
    );
  }
  return lines.join("\n");
}
