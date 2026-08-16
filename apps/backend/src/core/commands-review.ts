import { fs, path, createHash, reviewArtifactDirectory, reviewValidationArtifactPaths, DOCKER_LABEL_OWNER, runCommand, workspaceFilePath, resolveGitHubRepository } from "./commands-dependencies.js";
import type { Environment, PrState, JsonRecord } from "./commands-dependencies.js";
import { deletingLocalServerEnvironments, mergingEnvironments, withContainerRuntimeCredential } from "./commands-runtime-state.js";
import { asString, asRecord, assertOnlyKeys } from "./commands-validation.js";
import { quoteShell, validateGitRefName } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import { validateWorkspaceMutationPath } from "./commands-files.js";
import type { CommandContext } from "./commands-context.js";

export type PrDetectionResult = {
  url: string;
  state: PrState;
  hasMergeConflicts: boolean | null;
};

export type MergePrResult = {
  outcome: "merged" | "pending" | "unknown";
};

export type MergeEnvironmentPrResult = MergePrResult & {
  cleanupOutcome: "not-requested" | "pending" | "completed" | "failed";
  cleanupError?: string;
};

export type GhPrListEntry = {
  url?: unknown;
  state?: unknown;
  mergeable?: unknown;
  updatedAt?: unknown;
};

export type GitHubPullRequestRef = {
  owner: string;
  repo: string;
  number: string;
};

export type GitHubPullRequestHead = {
  head?: {
    ref?: unknown;
    repo?: {
      full_name?: unknown;
    } | null;
  } | null;
};

export type GitHubPullRequestMergeResponse = {
  merged?: unknown;
};

export type GhCliRunner = (args: string[], timeoutMs?: number) => Promise<string>;

export function parseGitHubPullRequestUrl(url: string): GitHubPullRequestRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid PR URL: ${url}`);
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error(`Invalid PR URL: ${url}`);
  }

  const [owner, repo, pullSegment, number, ...rest] = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (!owner || !repo || pullSegment !== "pull" || !number || rest.length > 0 || !/^\d+$/.test(number)) {
    throw new Error(`Invalid PR URL: ${url}`);
  }

  return { owner, repo, number };
}

export function parseMergeMethod(value: unknown): "squash" | "merge" | "rebase" {
  if (value === undefined || value === null || value === "") return "squash";
  if (value === "squash" || value === "merge" || value === "rebase") return value;
  throw new Error(`Invalid merge method: ${String(value)}`);
}

export function encodeGitHubPathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function encodeGitRefPath(ref: string): string {
  return ref.split("/").map(encodeGitHubPathSegment).join("/");
}

export function isRemoteBranchAlreadyDeletedError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("http 404") ||
    lowered.includes("not found") ||
    lowered.includes("reference does not exist")
  );
}

export function createLocalGhRunner(cwd: string): GhCliRunner {
  return async (args, timeoutMs = 60_000) => {
    const { stdout } = await runCommand("gh", args, { cwd, timeoutMs });
    return stdout;
  };
}

export function createContainerGhRunner(containerId: string): GhCliRunner {
  return (args, timeoutMs = 60_000) =>
    dockerExec(
      containerId,
      withContainerRuntimeCredential(["gh", ...args].map(quoteShell).join(" ")),
      timeoutMs,
    );
}

export type EnvironmentCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<string>;

export type ReviewPreparationValidation = {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  durationMs: number;
  limitation: string | null;
};

export type ReviewPreparationFileNote = {
  path: string;
  reason: string;
};

export function createEnvironmentCommandRunner(
  environment: Environment,
): EnvironmentCommandRunner {
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) {
      throw new Error("Local environment worktree is not available");
    }
    return async (command, args, timeoutMs = 60_000) =>
      (await runCommand(command, args, {
        cwd: environment.worktreePath,
        timeoutMs,
      })).stdout;
  }
  if (!environment.containerId) {
    throw new Error("Container environment is not available");
  }
  return async (command, args, timeoutMs = 60_000) =>
    (await runCommand(
      "docker",
      ["exec", environment.containerId!, command, ...args],
      { timeoutMs },
    )).stdout;
}

export function parseReviewPackageId(value: unknown): string {
  const packageId = asString(value, "packageId");
  if (
    packageId.length === 0
    || packageId.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageId)
    || packageId.includes("..")
  ) {
    throw new Error("Invalid review package ID");
  }
  return packageId;
}

export function parseReviewRound(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("Expected round to be a positive integer");
  }
  return value as number;
}

/**
 * Anchors a validation artifact path to the round's artifact directory. Agents
 * routinely return the bare filename they were told to write inside that
 * directory; both forms name the same file, and the caller still enforces the
 * deterministic name, so anchoring here avoids failing a whole round over the
 * spelling of a path the backend already knows.
 */
export function resolveValidationArtifactPath(
  value: string,
  artifactDirectory: string,
  label: string,
): string {
  const relativePath = validateWorkspaceMutationPath(value, label);
  return relativePath.includes("/")
    ? relativePath
    : `${artifactDirectory}/${relativePath}`;
}

export function parseReviewPreparationValidation(
  value: unknown,
  packageId: string,
): ReviewPreparationValidation[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected validation to be an array");
  }
  return value.map((candidate, index) => {
    const entry = asRecord(candidate, `validation[${index}]`);
    assertOnlyKeys(
      entry,
      [
        "command",
        "status",
        "exitCode",
        "stdoutPath",
        "stderrPath",
        "durationMs",
        "limitation",
      ],
      `validation[${index}]`,
    );
    const command = asString(entry.command, `validation[${index}].command`);
    if (command.trim().length === 0) {
      throw new Error(`Expected validation[${index}].command to be non-empty`);
    }
    if (
      entry.status !== "passed"
      && entry.status !== "failed"
      && entry.status !== "skipped"
    ) {
      throw new Error(`Invalid validation[${index}].status`);
    }
    const status = entry.status;
    const durationMs = entry.durationMs;
    if (!Number.isInteger(durationMs) || (durationMs as number) < 0) {
      throw new Error(
        `Expected validation[${index}].durationMs to be a non-negative integer`,
      );
    }
    const limitation = entry.limitation;
    if (
      limitation !== null
      && (typeof limitation !== "string" || limitation.trim().length === 0)
    ) {
      throw new Error(
        `Expected validation[${index}].limitation to be a non-empty string or null`,
      );
    }

    if (status === "skipped") {
      if (
        entry.exitCode !== null
        || entry.stdoutPath !== null
        || entry.stderrPath !== null
        || typeof limitation !== "string"
      ) {
        throw new Error(
          `Skipped validation[${index}] has incompatible evidence metadata`,
        );
      }
      return {
        command,
        status,
        exitCode: null,
        stdoutPath: null,
        stderrPath: null,
        durationMs: durationMs as number,
        limitation,
      };
    }

    if (!Number.isInteger(entry.exitCode)) {
      throw new Error(`Expected validation[${index}].exitCode to be an integer`);
    }
    const exitCode = entry.exitCode as number;
    if (
      (status === "passed" && exitCode !== 0)
      || (status === "failed" && exitCode === 0)
    ) {
      throw new Error(`Validation[${index}] status does not match its exit code`);
    }
    const artifactDirectory = reviewArtifactDirectory(packageId);
    const {
      stdoutPath: expectedStdoutPath,
      stderrPath: expectedStderrPath,
    } = reviewValidationArtifactPaths(packageId, index);
    const stdoutPath = resolveValidationArtifactPath(
      asString(entry.stdoutPath, `validation[${index}].stdoutPath`),
      artifactDirectory,
      `validation[${index}].stdoutPath`,
    );
    const stderrPath = resolveValidationArtifactPath(
      asString(entry.stderrPath, `validation[${index}].stderrPath`),
      artifactDirectory,
      `validation[${index}].stderrPath`,
    );
    if (stdoutPath !== expectedStdoutPath || stderrPath !== expectedStderrPath) {
      throw new Error(
        `Validation[${index}] artifact paths are not deterministic: expected `
        + `${expectedStdoutPath} and ${expectedStderrPath}, received `
        + `${stdoutPath} and ${stderrPath}`,
      );
    }
    return {
      command,
      status,
      exitCode,
      stdoutPath,
      stderrPath,
      durationMs: durationMs as number,
      limitation: limitation as string | null,
    };
  });
}

export function parseReviewPreparationFileNotes(
  value: unknown,
  label: "uncommittedFiles",
): ReviewPreparationFileNote[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }
  const notes = value.map((candidate, index) => {
    const note = asRecord(candidate, `${label}[${index}]`);
    assertOnlyKeys(note, ["path", "reason"], `${label}[${index}]`);
    const filePath = validateWorkspaceMutationPath(
      asString(note.path, `${label}[${index}].path`),
      `${label}[${index}].path`,
    );
    const reason = asString(note.reason, `${label}[${index}].reason`);
    if (reason.trim().length === 0) {
      throw new Error(`Expected ${label}[${index}].reason to be non-empty`);
    }
    return { path: filePath, reason };
  });
  if (new Set(notes.map((note) => note.path)).size !== notes.length) {
    throw new Error(`${label} paths must be unique`);
  }
  return notes;
}

export function parseGitNameStatus(output: string): Array<{ path: string; status: string }> {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error("Git returned malformed changed-file status");
    if (status.startsWith("R") || status.startsWith("C")) {
      const source = fields[index++];
      const destination = fields[index++];
      if (!source || !destination) {
        throw new Error("Git returned malformed rename/copy status");
      }
      changes.push({
        status,
        path: validateWorkspaceMutationPath(destination, "changed file path"),
      });
      continue;
    }
    const changedPath = fields[index++];
    if (!changedPath) throw new Error("Git returned malformed changed-file path");
    changes.push({
      status,
      path: validateWorkspaceMutationPath(changedPath, "changed file path"),
    });
  }
  return changes;
}

/**
 * A validation artifact the preparation agent never wrote is a preparation
 * failure, not an unexplained filesystem error. Resolving the path is the first
 * thing that touches the disk, so it is where the distinction has to be made;
 * every other guard below already reports itself in review terms.
 */
export function reviewArtifactMissingError(relativePath: string, cause: unknown): Error {
  return new Error(
    `Review artifact was not written by preparation: ${relativePath}`,
    { cause },
  );
}

export async function readEnvironmentWorkspaceFile(
  environment: Environment,
  runner: EnvironmentCommandRunner,
  relativePath: string,
): Promise<Buffer> {
  if (environment.environmentType === "local") {
    const worktreePath = environment.worktreePath!;
    const [root, resolved] = await Promise.all([
      fs.realpath(worktreePath),
      fs.realpath(path.join(worktreePath, relativePath)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw reviewArtifactMissingError(relativePath, error);
        }
        throw error;
      }),
    ]);
    const relative = path.relative(root, resolved);
    if (
      relative.startsWith("..")
      || path.isAbsolute(relative)
      || relative === ""
    ) {
      throw new Error(`Review artifact escapes the environment worktree: ${relativePath}`);
    }
    if (resolved !== path.resolve(root, relativePath)) {
      throw new Error(`Review artifact must not traverse symbolic links: ${relativePath}`);
    }
    const info = await fs.stat(resolved);
    if (!info.isFile()) {
      throw new Error(`Review artifact is not a regular file: ${relativePath}`);
    }
    return fs.readFile(resolved);
  }

  const workspacePath = workspaceFilePath(relativePath);
  // realpath in the container fails the same way for a missing artifact and for
  // a broken runner, so this stays deliberately non-committal about which it
  // was; the original failure is kept as the cause either way.
  const resolved = (await runner("realpath", ["--", workspacePath], 10_000)
    .catch((error) => {
      throw new Error(
        `Review artifact could not be read from the environment workspace: ${relativePath}`,
        { cause: error },
      );
    })).trim();
  if (resolved !== workspacePath) {
    throw new Error(`Review artifact must not traverse symbolic links: ${relativePath}`);
  }
  const base64 = (await runner("base64", ["-w", "0", "--", resolved], 30_000)).trim();
  return Buffer.from(base64, "base64");
}

export async function readEnvironmentGitBlob(
  runner: EnvironmentCommandRunner,
  headRef: string,
  relativePath: string,
): Promise<{ type: string; bytes: Buffer }> {
  const object = `${headRef}:${relativePath}`;
  const type = (await runner("git", ["cat-file", "-t", object], 30_000)).trim();
  if (type !== "blob") return { type, bytes: Buffer.alloc(0) };
  const base64 = await runner(
    "sh",
    ["-lc", `git cat-file blob ${quoteShell(object)} | base64`],
    60_000,
  );
  return { type, bytes: Buffer.from(base64, "base64") };
}

export function decodeReviewText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

export function decodeValidationOutput(bytes: Buffer, artifactPath: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`Validation artifact is not valid UTF-8: ${artifactPath}`);
  }
  return text;
}

export async function verifyEnvironmentPullRequest(
  environmentId: string,
  prUrl: string,
  targetBranch: string,
  context: CommandContext,
): Promise<{
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN";
}> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const project = await context.storage.getProject(environment.projectId);
  if (!project) throw new Error(`Project not found: ${environment.projectId}`);
  const repository = resolveGitHubRepository(project.gitUrl);
  const branch = validateGitRefName(targetBranch, "target branch");
  const submittedUrl = prUrl.trim();
  const submitted = parseGitHubPullRequestUrl(submittedUrl);
  const canonical = `https://github.com/${submitted.owner}/${submitted.repo}/pull/${submitted.number}`;
  if (submittedUrl !== canonical) {
    throw new Error("Pull request URL must be a canonical github.com URL");
  }
  if (
    submitted.owner.toLowerCase() !== repository.owner.toLowerCase()
    || submitted.repo.toLowerCase() !== repository.name.toLowerCase()
  ) {
    throw new Error("Pull request belongs to a different repository");
  }

  const runner = createEnvironmentCommandRunner(environment);
  const raw = await runner(
    "gh",
    ["pr", "view", submittedUrl, "--json", "url,headRefName,baseRefName,state"],
    30_000,
  );
  let result: Record<string, unknown>;
  try {
    result = asRecord(JSON.parse(raw), "gh pr view response");
  } catch {
    throw new Error("GitHub returned malformed pull request metadata");
  }
  const verifiedUrl = asString(result.url, "pull request URL");
  const headRefName = asString(result.headRefName, "pull request head branch");
  const baseRefName = asString(result.baseRefName, "pull request base branch");
  const state = asString(result.state, "pull request state").toUpperCase();
  if (verifiedUrl !== canonical) {
    throw new Error("GitHub did not return the canonical pull request URL");
  }
  if (headRefName !== environment.branch) {
    throw new Error("Pull request head branch does not match the environment branch");
  }
  if (baseRefName !== branch) {
    throw new Error("Pull request base branch does not match the requested target branch");
  }
  if (state !== "OPEN") {
    throw new Error("Pull request is not open");
  }
  return { url: verifiedUrl, headRefName, baseRefName, state: "OPEN" };
}

export function parseGitPorcelainPaths(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry || entry.length < 4 || entry[2] !== " ") {
      throw new Error("Git returned malformed worktree status");
    }
    const status = entry.slice(0, 2);
    paths.push(
      validateWorkspaceMutationPath(entry.slice(3), "uncommitted file path"),
    );
    if (status.includes("R") || status.includes("C")) {
      if (!fields[index++]) {
        throw new Error("Git returned malformed renamed worktree status");
      }
    }
  }
  return paths;
}

export function parseNullDelimitedPaths(output: string, label: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields.map((filePath) =>
    validateWorkspaceMutationPath(filePath, label)
  );
}

export async function generateLoopedReviewPackage(
  environmentId: string,
  packageId: string,
  round: number,
  targetBranch: string,
  validation: ReviewPreparationValidation[],
  uncommittedFiles: ReviewPreparationFileNote[],
  limitations: string[],
  context: CommandContext,
): Promise<JsonRecord> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const branch = validateGitRefName(targetBranch, "target branch");
  const runner = createEnvironmentCommandRunner(environment);
  const baseName = `origin/${branch}`;
  const [headOutput, baseOutput] = await Promise.all([
    runner("git", ["rev-parse", "--verify", "HEAD^{commit}"], 30_000),
    runner("git", ["rev-parse", "--verify", `${baseName}^{commit}`], 30_000),
  ]);
  const headRef = headOutput.trim();
  const baseRef = baseOutput.trim();
  if (!/^[a-f0-9]{40}$/i.test(headRef) || !/^[a-f0-9]{40}$/i.test(baseRef)) {
    throw new Error("Git did not resolve full review package commit SHAs");
  }
  // From this point on, Git evidence is anchored to immutable object IDs. The
  // preparation agent supplies no refs, diff text, file bytes, or hashes.
  const range = `${baseRef}...${headRef}`;
  const diffArgs = [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--submodule=short",
    range,
  ];
  const [
    completeDiff,
    nameStatus,
    preparedAtOutput,
    worktreeStatus,
    commitSubject,
    committedFileOutput,
  ] = await Promise.all([
    runner("git", diffArgs, 120_000),
    runner(
      "git",
      ["diff", "--name-status", "-z", "--no-renames", range],
      60_000,
    ),
    runner("git", ["show", "-s", "--format=%cI", headRef], 30_000),
    runner(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      30_000,
    ),
    runner("git", ["show", "-s", "--format=%s", headRef], 30_000),
    runner(
      "git",
      [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "--no-renames",
        headRef,
      ],
      30_000,
    ),
  ]);

  const changes = parseGitNameStatus(nameStatus);
  const changeKeys = changes.map((file) => `${file.status}\0${file.path}`);
  if (
    new Set(changeKeys).size !== changes.length
    || (changes.length > 0 && completeDiff.length === 0)
  ) {
    throw new Error("Git returned an incomplete or ambiguous review diff");
  }

  const artifactDirectory = reviewArtifactDirectory(packageId);
  const actualUncommittedPaths = parseGitPorcelainPaths(worktreeStatus)
    .filter((filePath) =>
      filePath !== artifactDirectory
      && !filePath.startsWith(`${artifactDirectory}/`)
    );
  const submittedUncommittedPaths = uncommittedFiles.map((note) => note.path);
  const actualUncommittedSet = new Set(actualUncommittedPaths);
  const submittedUncommittedSet = new Set(submittedUncommittedPaths);
  if (
    actualUncommittedSet.size !== actualUncommittedPaths.length
    || submittedUncommittedSet.size !== submittedUncommittedPaths.length
    || actualUncommittedSet.size !== submittedUncommittedSet.size
    || [...actualUncommittedSet].some((filePath) =>
      !submittedUncommittedSet.has(filePath)
    )
  ) {
    throw new Error(
      "Preparation result does not account for every uncommitted file",
    );
  }

  const changedFiles = await Promise.all(changes.map(async (file) => {
    if (file.status === "D") {
      const omittedReason = "Deleted file has no content at the prepared HEAD.";
      return {
        ...file,
        content: null,
        contentSha256: null,
        omittedReason,
      };
    }
    const object = await readEnvironmentGitBlob(runner, headRef, file.path);
    if (object.type !== "blob") {
      const omittedReason =
        `Git object type ${object.type || "unknown"} has no text file content.`;
      return {
        ...file,
        content: null,
        contentSha256: null,
        omittedReason,
      };
    }
    const content = decodeReviewText(object.bytes);
    if (content === null) {
      const omittedReason =
        "Binary content is represented by the complete binary Git diff.";
      return {
        ...file,
        content: null,
        contentSha256: null,
        omittedReason,
      };
    }
    return {
      ...file,
      content,
      contentSha256: createHash("sha256").update(object.bytes).digest("hex"),
      omittedReason: null,
    };
  }));
  const skippedFiles = changedFiles.flatMap((file) =>
    file.omittedReason === null
      ? []
      : [{ path: file.path, reason: file.omittedReason }]
  );

  const hydratedValidation = await Promise.all(validation.map(async (entry) => {
    // The preparation agent reports `limitation: null` for a command that ran
    // without one, but the persisted contract is `limitation?: string` and its
    // guard rejects null. Carrying the null through made the finished package
    // unpersistable — the whole workflow snapshot failed validation on save and
    // the round died with a `package` failure that a retry reproduced exactly.
    const limitation = entry.limitation === null
      ? {}
      : { limitation: entry.limitation };
    if (entry.status === "skipped") {
      return {
        command: entry.command,
        status: entry.status,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: entry.durationMs,
        ...limitation,
      };
    }
    const [stdoutBytes, stderrBytes] = await Promise.all([
      readEnvironmentWorkspaceFile(environment, runner, entry.stdoutPath!),
      readEnvironmentWorkspaceFile(environment, runner, entry.stderrPath!),
    ]);
    return {
      command: entry.command,
      status: entry.status,
      exitCode: entry.exitCode,
      stdout: decodeValidationOutput(stdoutBytes, entry.stdoutPath!),
      stderr: decodeValidationOutput(stderrBytes, entry.stderrPath!),
      durationMs: entry.durationMs,
      ...limitation,
    };
  }));

  const [finalHeadOutput, finalWorktreeStatus] = await Promise.all([
    runner("git", ["rev-parse", "--verify", "HEAD^{commit}"], 30_000),
    runner(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      30_000,
    ),
  ]);
  const finalHead = finalHeadOutput.trim();
  if (finalHead !== headRef) {
    throw new Error("Environment HEAD changed while generating the review package");
  }
  const finalUncommittedPaths = parseGitPorcelainPaths(finalWorktreeStatus)
    .filter((filePath) =>
      filePath !== artifactDirectory
      && !filePath.startsWith(`${artifactDirectory}/`)
    );
  if (
    finalUncommittedPaths.length !== actualUncommittedPaths.length
    || finalUncommittedPaths.some((filePath, index) =>
      filePath !== actualUncommittedPaths[index]
    )
  ) {
    throw new Error("Environment worktree changed while generating the review package");
  }

  return {
    id: packageId,
    round,
    preparedAt: preparedAtOutput.trim(),
    targetBranch: branch,
    baseRef,
    headRef,
    commit: {
      sha: headRef,
      subject: commitSubject.trimEnd(),
      committedFiles: parseNullDelimitedPaths(
        committedFileOutput,
        "committed file path",
      ),
    },
    completeDiff,
    changedFiles,
    validation: hydratedValidation,
    skippedFiles,
    uncommittedFiles: [...uncommittedFiles].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ),
    limitations,
    // Deliberately absent rather than `null`. The context is supplied by the
    // workflow, not by package generation, and a null here is not a valid
    // `ReviewPackageContext` — persisting it would make the snapshot fail
    // validation on its next read.
  };
}

export async function markPullRequestReadyIfDraft(prUrl: string, runGh: GhCliRunner): Promise<void> {
  const draftStatus = (await runGh([
    "pr",
    "view",
    prUrl,
    "--json",
    "isDraft",
    "--jq",
    ".isDraft",
  ], 30_000)).trim().toLowerCase();

  if (draftStatus === "true") {
    await runGh(["pr", "ready", prUrl], 30_000);
  }
}

export async function loadPullRequestHead(pullEndpoint: string, runGh: GhCliRunner): Promise<GitHubPullRequestHead> {
  const stdout = await runGh(["api", pullEndpoint], 30_000);
  return JSON.parse(stdout) as GitHubPullRequestHead;
}

export async function deleteRemoteBranchForPullRequestHead(
  head: GitHubPullRequestHead | null,
  runGh: GhCliRunner,
): Promise<void> {
  const headRefName = typeof head?.head?.ref === "string" ? head.head.ref : "";
  const headRepositoryNameWithOwner = typeof head?.head?.repo?.full_name === "string" ? head.head.repo.full_name : "";
  const [headOwner, headRepo] = headRepositoryNameWithOwner.split("/");
  if (!headRefName || !headOwner || !headRepo) return;

  try {
    await runGh([
      "api",
      `repos/${encodeGitHubPathSegment(headOwner)}/${encodeGitHubPathSegment(headRepo)}/git/refs/heads/${encodeGitRefPath(headRefName)}`,
      "--method",
      "DELETE",
    ], 30_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRemoteBranchAlreadyDeletedError(message)) {
      throw error;
    }
  }
}

export async function deletePullRequestHeadBranchViaGitHubApi(prUrl: string, runGh: GhCliRunner): Promise<void> {
  const pr = parseGitHubPullRequestUrl(prUrl);
  const pullEndpoint = `repos/${encodeGitHubPathSegment(pr.owner)}/${encodeGitHubPathSegment(pr.repo)}/pulls/${pr.number}`;
  const head = await loadPullRequestHead(pullEndpoint, runGh);
  await deleteRemoteBranchForPullRequestHead(head, runGh);
}

export async function mergePullRequestViaGitHubApi(
  prUrl: string,
  method: "squash" | "merge" | "rebase",
  deleteBranch: boolean,
  cwd: string,
): Promise<MergePrResult> {
  const pr = parseGitHubPullRequestUrl(prUrl);
  const pullEndpoint = `repos/${encodeGitHubPathSegment(pr.owner)}/${encodeGitHubPathSegment(pr.repo)}/pulls/${pr.number}`;
  const mergeEndpoint = `${pullEndpoint}/merge`;
  const runGh = createLocalGhRunner(cwd);

  await markPullRequestReadyIfDraft(prUrl, runGh);

  let head: GitHubPullRequestHead | null = null;
  if (deleteBranch) {
    head = await loadPullRequestHead(pullEndpoint, runGh);
  }

  const mergeOutput = await runGh([
    "api",
    mergeEndpoint,
    "--method",
    "PUT",
    "-f",
    `merge_method=${method}`,
  ], 120_000);

  let mergeResponse: GitHubPullRequestMergeResponse;
  try {
    mergeResponse = JSON.parse(mergeOutput) as GitHubPullRequestMergeResponse;
  } catch {
    return { outcome: "unknown" };
  }

  if (mergeResponse.merged !== true) return { outcome: "unknown" };

  if (deleteBranch) {
    await deleteRemoteBranchForPullRequestHead(head, runGh);
  }
  return { outcome: "merged" };
}

export async function mergePullRequestInContainer(
  containerId: string,
  method: "squash" | "merge" | "rebase",
  deleteBranch: boolean,
): Promise<MergePrResult> {
  const runGh = createContainerGhRunner(containerId);
  const prUrl = (await runGh(["pr", "view", "--json", "url", "--jq", ".url"], 30_000)).trim();
  parseGitHubPullRequestUrl(prUrl);

  await markPullRequestReadyIfDraft(prUrl, runGh);

  await runGh([
    "pr",
    "merge",
    prUrl,
    `--${method}`,
    ...(deleteBranch ? ["--delete-branch"] : []),
  ], 120_000);

  let state: string;
  try {
    state = (await runGh(["pr", "view", prUrl, "--json", "state", "--jq", ".state"], 30_000)).trim().toUpperCase();
  } catch {
    return { outcome: "unknown" };
  }

  if (state === "MERGED") return { outcome: "merged" };
  if (state === "OPEN") return { outcome: "pending" };
  return { outcome: "unknown" };
}

export async function runStoredEnvironmentMerge<T>(
  environment: Environment,
  method: "squash" | "merge" | "rebase",
  deleteBranch: boolean,
  context: CommandContext,
  onResult: (result: MergePrResult) => Promise<T>,
): Promise<T> {
  if (environment.deletionRequestedAt || deletingLocalServerEnvironments.has(environment.id)) {
    throw new Error(`Environment is already being deleted: ${environment.id}`);
  }
  if (mergingEnvironments.has(environment.id)) {
    throw new Error(`Environment is already being merged: ${environment.id}`);
  }
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) {
      throw new Error("Local environment worktree is not available");
    }
    if (!environment.prUrl) {
      throw new Error("Local environment PR URL is not available");
    }
  } else if (!environment.containerId) {
    throw new Error("Container environment is not available");
  }

  mergingEnvironments.add(environment.id);
  try {
    await context.storage.updateEnvironment(environment.id, {
      lifecycleOperation: "merging",
      lifecycleOperationStartedAt: new Date().toISOString(),
    });
    const result = environment.environmentType === "local"
      ? await mergePullRequestViaGitHubApi(
        environment.prUrl!,
        method,
        deleteBranch,
        environment.worktreePath!,
      )
      : await mergePullRequestInContainer(
        environment.containerId!,
        method,
        deleteBranch,
      );
    // The callback runs before the merge guard is released. A confirmed
    // merge-and-cleanup can therefore transition directly into the deletion
    // tombstone without a user delete racing through the middle.
    return await onResult(result);
  } finally {
    mergingEnvironments.delete(environment.id);
    await context.storage.updateEnvironment(environment.id, {
      lifecycleOperation: null,
      lifecycleOperationStartedAt: null,
    }).catch(() => undefined);
  }
}

export function isExpectedPrAbsenceOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === "[]") return true;

  const lowered = trimmed.toLowerCase();
  return (
    lowered.includes("no pull request") ||
    lowered.includes("no pull requests match your search") ||
    lowered.includes("could not resolve") ||
    lowered.includes("not found")
  );
}

export function parsePrState(value: unknown): PrState | null {
  if (typeof value !== "string") return null;
  switch (value.toUpperCase()) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return null;
  }
}

export function prStateRank(state: PrState): number {
  switch (state) {
    case "open":
      return 2;
    case "merged":
      return 1;
    case "closed":
      return 0;
  }
}

export function isValidPrUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("https://") &&
    value.includes("github.com/") &&
    value.includes("/pull/")
  );
}

export function buildPrDetectionCandidate(entry: GhPrListEntry): { rank: number; updatedAt: string; result: PrDetectionResult } | null {
  const state = parsePrState(entry.state);
  if (!state || !isValidPrUrl(entry.url)) return null;
  const mergeable = typeof entry.mergeable === "string"
    ? entry.mergeable.toUpperCase()
    : null;
  return {
    rank: prStateRank(state),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
    result: {
      url: entry.url,
      state,
      hasMergeConflicts: mergeable === "CONFLICTING"
        ? true
        : mergeable === "MERGEABLE"
          ? false
          : null,
    },
  };
}

export function parsePrDetectionOutput(stdout: string, branch: string): PrDetectionResult | null {
  const trimmed = stdout.trim();
  if (isExpectedPrAbsenceOutput(trimmed)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Failed to parse gh pr list output");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Failed to parse gh pr list output");
  }

  const candidates = parsed
    .map((entry) => buildPrDetectionCandidate(entry as GhPrListEntry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  candidates.sort((left, right) => {
    const rankDelta = right.rank - left.rank;
    if (rankDelta !== 0) return rankDelta;
    return right.updatedAt.localeCompare(left.updatedAt);
  });

  const result = candidates[0]?.result;
  if (!result) {
    console.debug("[ElectronBackend] Unexpected output from gh pr list", { branch, output: trimmed });
    throw new Error("Failed to parse gh pr list output");
  }
  return result;
}

export function parseKnownPrDetectionOutput(
  stdout: string,
  expectedUrl: string,
): PrDetectionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Failed to parse gh pr view output");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Failed to parse gh pr view output");
  }
  const candidate = buildPrDetectionCandidate(parsed as GhPrListEntry);
  if (!candidate || candidate.result.url !== expectedUrl) {
    throw new Error("GitHub returned unexpected pull request metadata");
  }
  return candidate.result;
}

export function validatePrDetectionBranch(branch: unknown): string {
  const value = asString(branch, "branch").trim();
  if (!value) throw new Error("Branch name cannot be empty");
  return value;
}

export function containerIdMatches(known: string, candidate: string): boolean {
  const left = known.trim();
  const right = candidate.trim();
  return left.length > 0 && right.length > 0 && (left === right || left.startsWith(right) || right.startsWith(left));
}

export function findEnvironmentByContainerId(environments: Environment[], containerId: string): Environment | undefined {
  return environments.find((environment) => environment.containerId && containerIdMatches(environment.containerId, containerId));
}

/**
 * Reads one label out of the flat `key=value,key=value` string Docker emits for
 * `{{.Labels}}`. Match the complete key so similarly suffixed labels are not
 * confused with the ownership label.
 */
export function dockerLabelValue(labels: unknown, key: string): string | undefined {
  if (typeof labels !== "string") return undefined;
  for (const label of labels.split(",")) {
    const separator = label.indexOf("=");
    const candidateKey = separator < 0 ? label : label.slice(0, separator);
    if (candidateKey === key) return separator < 0 ? "" : label.slice(separator + 1);
  }
  return undefined;
}

/**
 * Whether a container belongs to this backend registry.
 *
 * Containers created before the owner label existed carry no owner, and Docker
 * cannot add a label to an existing container. Treating an absent owner as
 * "someone else's" would strand every pre-upgrade container: invisible in the
 * listing and unreachable by the orphan sweep, with no way to reclaim the disk.
 * So adopt them. Only the `app` label gates the query, and this app is the sole
 * writer of that label, so adoption can never reach a container it did not
 * create.
 */
export function dockerOwnerMatches(labels: unknown, owner: string, requireExactOwner = false): boolean {
  const value = dockerLabelValue(labels, DOCKER_LABEL_OWNER);
  return value === owner || (!requireExactOwner && value === undefined);
}

/**
 * Counts the ids listed under a `docker … prune` report's `Deleted …:` heading.
 * A prune that removed nothing prints the reclaimed-space line alone, so the
 * absent heading is the zero case rather than a parse failure.
 */
export function countPrunedDockerResources(stdout: string): number {
  const lines = stdout.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => /^Deleted .+:$/.test(line));
  if (start < 0) return 0;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (!line || /^Total reclaimed space:/i.test(line) || /^Deleted .+:$/.test(line)) break;
    count += 1;
  }
  return count;
}

export function parseDockerByteSize(value: string): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?i?b)\s*$/i.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const prefix = unit.replace(/i?b$/, "");
  const power = ["", "k", "m", "g", "t", "p"].indexOf(prefix);
  const base = unit.includes("i") ? 1024 : 1000;
  return Number.isFinite(amount) && power >= 0
    ? Math.round(amount * base ** power)
    : 0;
}
/** Explicit list projection: renderer hydration never receives backend internals. */

