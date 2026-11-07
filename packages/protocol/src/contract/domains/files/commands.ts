/**
 * `files` commands (plan item 7002): one environment's workspace files, read
 * and changed by the files panel, the editor, attachments and the web
 * annotation checks, in a local worktree (`*_local_*`, by worktree path or
 * environment) or a container (`*_container_*`, `get_file_tree`, by
 * container or environment).
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4). A key the handler required with `asString` is `Schema.String`
 * (the schema's "Expected filePath to be a string" is that helper's text); a
 * key the handler reads leniently (a digest compared for equality, a
 * `refresh === true` flag) or checks with its own message (the write
 * precondition, a path list, an attachment batch) stays
 * `optionalKey(Unknown)`, so nothing an older client sends is refused and the
 * error text is unchanged. Fields are listed in the order the handler checks
 * them, because a decode reports the first failure.
 *
 * Results describe what the handlers return, including the legacy forms a
 * current backend still answers (a bare tree without `knownDigest`).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { filesDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** One node of a workspace file tree, as `get_file_tree` and the subtree reads list it. */
export interface FileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly children?: readonly FileTreeNode[];
  /** Contents were omitted by the node cap or could not be read. */
  readonly truncated?: boolean;
  readonly extension?: string;
}

export const FileTreeNodeSchema: Schema.Codec<FileTreeNode> = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  isDirectory: Schema.Boolean,
  children: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<FileTreeNode> => FileTreeNodeSchema)),
  ),
  truncated: Schema.optionalKey(Schema.Boolean),
  extension: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "FileTreeNode" });

const FileTreeSchema = Schema.Array(FileTreeNodeSchema);

/** One truncated directory's contents, read when the files panel expands it. */
export const FileSubtreeSchema = Schema.Struct({
  children: FileTreeSchema,
  /** The directory's own entries were not all listed. */
  truncated: Schema.Boolean,
}).annotate({ identifier: "FileSubtree" });

/** A text file as the editor opens it. */
export const FileContentSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  language: Schema.String,
}).annotate({ identifier: "FileContent" });

const SnapshotFreshnessSchema = Schema.Literals(["current", "stale", "failed"]);

/**
 * `view` on a file-list or tree answer that a tracked read owner served
 * (`WorktreeReadStamp`, `@orkestrator/protocol/worktree-snapshots`).
 */
export const WorktreeReadStampSchema = Schema.Struct({
  generation: Schema.String,
  environmentId: Schema.String,
  targetGeneration: Schema.Finite,
  revision: Schema.Finite,
  freshness: SnapshotFreshnessSchema,
  watched: Schema.Boolean,
}).annotate({ identifier: "WorktreeReadStamp" });

/**
 * A conditional tree read (`knownDigest` sent): `unchanged` with no body, or
 * the new body with its digest.
 */
const ConditionalTreeSchema = Schema.Struct({
  unchanged: Schema.Boolean,
  digest: Schema.String,
  value: Schema.optionalKey(FileTreeSchema),
  view: Schema.optionalKey(WorktreeReadStampSchema),
});

/** A tree read: the bare tree without `knownDigest`, the conditional answer with it. */
export const FileTreeReadSchema = Schema.Union([FileTreeSchema, ConditionalTreeSchema]);

/** A subtree read: the bare subtree without `knownDigest`, the conditional answer with it. */
export const FileSubtreeReadSchema = Schema.Union([
  FileSubtreeSchema,
  Schema.Struct({
    unchanged: Schema.Boolean,
    digest: Schema.String,
    value: Schema.optionalKey(FileSubtreeSchema),
  }),
]);

const WorktreeSnapshotStateSchema = Schema.Struct({
  environmentId: Schema.String,
  targetGeneration: Schema.Finite,
  comparisonRef: Schema.String,
  fileListRevision: Schema.Finite,
  treeRevision: Schema.Finite,
  freshness: SnapshotFreshnessSchema,
  watched: Schema.Boolean,
  remote: Schema.optionalKey(
    Schema.Struct({
      state: Schema.String,
      lastSuccessAt: Schema.optionalKey(Schema.String),
      failure: Schema.optionalKey(Schema.String),
    }),
  ),
}).annotate({ identifier: "WorktreeSnapshotState" });

const WorktreeSnapshotRevisionsSnapshotSchema = Schema.Struct({
  generation: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.Finite),
  entries: Schema.Array(WorktreeSnapshotStateSchema),
}).annotate({ identifier: "WorktreeSnapshotRevisionsSnapshot" });

const viewStamp = { generation: Schema.String, revision: Schema.Finite };

/**
 * `get_worktree_snapshot_revisions`: the whole snapshot without known
 * revision arguments, the conditional `ViewSnapshotOutcome`
 * (`@orkestrator/protocol/view-sync`) with them.
 */
export const WorktreeSnapshotRevisionsReadSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unchanged"), ...viewStamp }),
  Schema.Struct({
    status: Schema.Literal("snapshot"),
    ...viewStamp,
    snapshot: WorktreeSnapshotRevisionsSnapshotSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("reset"),
    ...viewStamp,
    snapshot: WorktreeSnapshotRevisionsSnapshotSchema,
    reason: Schema.Literals(["generation", "ahead", "invalid-request"]),
  }),
  Schema.Struct({ status: Schema.Literal("deleted"), ...viewStamp }),
  WorktreeSnapshotRevisionsSnapshotSchema,
]);

/** Where a file the agent reported is, without reading it (web annotation checks). */
export const WorkspacePathCheckStatusSchema = Schema.Literals([
  "exists",
  "missing",
  "outside-workspace",
  "unavailable",
]);

/** One staged initial-prompt attachment. */
export const SavedInitialPromptAttachmentSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "SavedInitialPromptAttachment" });

// --- Trees ---

export const getFileTreeCommand = defineCommand({
  domain: filesDomain,
  name: "get_file_tree",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    containerId: Schema.String,
    // Compared for equality only; any other value reads as "changed".
    knownDigest: optionalUnknown,
    refresh: optionalUnknown,
  }),
  result: FileTreeReadSchema,
  critical: [],
});

export const getLocalFileTreeCommand = defineCommand({
  domain: filesDomain,
  name: "get_local_file_tree",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    worktreePath: Schema.String,
    knownDigest: optionalUnknown,
    refresh: optionalUnknown,
  }),
  result: FileTreeReadSchema,
  critical: [],
});

export const getFileSubtreeCommand = defineCommand({
  domain: filesDomain,
  name: "get_file_subtree",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    directory: Schema.String,
    containerId: Schema.String,
    knownDigest: optionalUnknown,
  }),
  result: FileSubtreeReadSchema,
  critical: [],
});

export const getLocalFileSubtreeCommand = defineCommand({
  domain: filesDomain,
  name: "get_local_file_subtree",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    worktreePath: Schema.String,
    directory: Schema.String,
    knownDigest: optionalUnknown,
  }),
  result: FileSubtreeReadSchema,
  critical: [],
});

/** File-list and tree revisions of every tracked environment. */
export const getWorktreeSnapshotRevisionsCommand = defineCommand({
  domain: filesDomain,
  name: "get_worktree_snapshot_revisions",
  since: 1,
  access: "workspace",
  read: true,
  // Checked together by `parseViewSnapshotRequest`: a malformed pair answers
  // a `reset`, never an error.
  args: Schema.Struct({ knownGeneration: optionalUnknown, knownRevision: optionalUnknown }),
  result: WorktreeSnapshotRevisionsReadSchema,
  critical: [],
});

// --- Reads ---

export const readLocalFileCommand = defineCommand({
  domain: filesDomain,
  name: "read_local_file",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ filePath: Schema.String, worktreePath: Schema.String }),
  result: FileContentSchema,
  critical: [],
});

export const readLocalFileAtBranchCommand = defineCommand({
  domain: filesDomain,
  name: "read_local_file_at_branch",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    worktreePath: Schema.String,
    filePath: Schema.String,
    branch: Schema.String,
  }),
  // `null`: the branch has no such file.
  result: Schema.NullOr(FileContentSchema),
  critical: [],
});

export const readContainerFileCommand = defineCommand({
  domain: filesDomain,
  name: "read_container_file",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ filePath: Schema.String, containerId: Schema.String }),
  result: FileContentSchema,
  critical: [],
});

export const readFileAtBranchCommand = defineCommand({
  domain: filesDomain,
  name: "read_file_at_branch",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    filePath: Schema.String,
    branch: Schema.String,
    containerId: Schema.String,
  }),
  result: Schema.NullOr(FileContentSchema),
  critical: [],
});

/** A container workspace file, base64. */
export const readContainerFileBase64Command = defineCommand({
  domain: filesDomain,
  name: "read_container_file_base64",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ filePath: Schema.String, containerId: Schema.String }),
  result: Schema.String,
  critical: [],
});

/** A readable host file (attachments, images), base64. */
export const readFileBase64Command = defineCommand({
  domain: filesDomain,
  name: "read_file_base64",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ filePath: Schema.String }),
  result: Schema.String,
  critical: [],
});

/** A local environment's worktree file, base64. Strict (`assertOnlyKeys`) before. */
export const readEnvironmentFileBase64Command = defineCommand({
  domain: filesDomain,
  name: "read_environment_file_base64",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, filePath: Schema.String }),
  result: Schema.String,
  critical: [],
});

// --- Writes ---

/** Saves an editor buffer into a registered local worktree; answers the written path. */
export const writeLocalFileCommand = defineCommand({
  domain: filesDomain,
  name: "write_local_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    worktreePath: Schema.String,
    // The editor's precondition `{ sha256 }`, checked by `parseFileWritePrecondition`.
    expected: optionalUnknown,
    filePath: Schema.String,
    base64Data: Schema.String,
  }),
  result: Schema.String,
  // expected: the write happens only while the file still has the content the
  // editor loaded; a receiver ignoring it would overwrite a concurrent change.
  critical: ["expected"],
});

export const writeContainerFileCommand = defineCommand({
  domain: filesDomain,
  name: "write_container_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    containerId: Schema.String,
    filePath: Schema.String,
    expected: optionalUnknown,
    base64Data: Schema.String,
  }),
  result: Schema.String,
  critical: ["expected"],
});

/** Stages a prompt's pasted images in the workspace; answers where each landed. */
export const writeInitialPromptAttachmentsCommand = defineCommand({
  domain: filesDomain,
  name: "write_initial_prompt_attachments",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    // 1 to 20 `{ id, name, base64Data }`, checked by the handler with its own text.
    attachments: optionalUnknown,
  }),
  result: Schema.Array(SavedInitialPromptAttachmentSchema),
  critical: [],
});

/** Copies a file dropped from outside into the workspace; answers its workspace path. */
export const copyExternalFileCommand = defineCommand({
  domain: filesDomain,
  name: "copy_external_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    destinationDirectory: Schema.String,
    fileName: Schema.String,
    base64Data: Schema.String,
  }),
  result: Schema.String,
  critical: [],
});

// --- Mutations by environment: each answers the affected workspace path ---

const pathMutation = { environmentId: Schema.String, filePath: Schema.String };

export const revertLocalFileCommand = defineCommand({
  domain: filesDomain,
  name: "revert_local_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pathMutation, targetBranch: Schema.String }),
  result: Schema.String,
  critical: [],
});

export const revertContainerFileCommand = defineCommand({
  domain: filesDomain,
  name: "revert_container_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pathMutation, targetBranch: Schema.String }),
  result: Schema.String,
  critical: [],
});

export const deleteLocalFileCommand = defineCommand({
  domain: filesDomain,
  name: "delete_local_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct(pathMutation),
  result: Schema.String,
  critical: [],
});

export const deleteContainerFileCommand = defineCommand({
  domain: filesDomain,
  name: "delete_container_file",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct(pathMutation),
  result: Schema.String,
  critical: [],
});

const moveArgs = Schema.Struct({
  environmentId: Schema.String,
  sourcePath: Schema.String,
  destinationDirectory: Schema.String,
});

export const moveLocalFileCommand = defineCommand({
  domain: filesDomain,
  name: "move_local_file",
  since: 1,
  access: "workspace",
  read: false,
  args: moveArgs,
  result: Schema.String,
  critical: [],
});

export const moveContainerFileCommand = defineCommand({
  domain: filesDomain,
  name: "move_container_file",
  since: 1,
  access: "workspace",
  read: false,
  args: moveArgs,
  result: Schema.String,
  critical: [],
});

const renameArgs = Schema.Struct({ ...pathMutation, newName: Schema.String });

export const renameLocalFileCommand = defineCommand({
  domain: filesDomain,
  name: "rename_local_file",
  since: 1,
  access: "workspace",
  read: false,
  args: renameArgs,
  result: Schema.String,
  critical: [],
});

export const renameContainerFileCommand = defineCommand({
  domain: filesDomain,
  name: "rename_container_file",
  since: 1,
  access: "workspace",
  read: false,
  args: renameArgs,
  result: Schema.String,
  critical: [],
});

const folderArgs = Schema.Struct({
  environmentId: Schema.String,
  parentDirectory: Schema.String,
  folderName: Schema.String,
});

export const createLocalFolderCommand = defineCommand({
  domain: filesDomain,
  name: "create_local_folder",
  since: 1,
  access: "workspace",
  read: false,
  args: folderArgs,
  result: Schema.String,
  critical: [],
});

export const createContainerFolderCommand = defineCommand({
  domain: filesDomain,
  name: "create_container_folder",
  since: 1,
  access: "workspace",
  read: false,
  args: folderArgs,
  result: Schema.String,
  critical: [],
});

// --- Web annotation evidence and checks (backend-internal callers) ---

/** Containment and existence of agent-reported container paths; runs `stat` only. */
export const checkContainerWorkspacePathsCommand = defineCommand({
  domain: filesDomain,
  name: "check_container_workspace_paths",
  since: 1,
  access: "internal",
  read: true,
  // Both checked by the handler with its own text: a non-blank Docker name or
  // id, and at most 200 workspace-relative paths.
  args: Schema.Struct({ containerId: optionalUnknown, paths: optionalUnknown }),
  result: Schema.Array(WorkspacePathCheckStatusSchema),
  critical: [],
});

/** Removes an app-generated evidence file only while it still has `digest`. */
export const deleteContainerAnnotationEvidenceCommand = defineCommand({
  domain: filesDomain,
  name: "delete_container_annotation_evidence",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    containerId: Schema.String,
    filePath: Schema.String,
    digest: Schema.String,
  }),
  result: Schema.Literals(["removed", "missing", "mismatch"]),
  // digest: the file is removed only while it is the evidence the record
  // names; a receiver ignoring it could delete a replaced file.
  critical: ["digest"],
});

/** Every `files` command definition, for the registry tests and the manifest checks. */
export const FILES_COMMANDS = [
  getFileTreeCommand,
  getLocalFileTreeCommand,
  getFileSubtreeCommand,
  getLocalFileSubtreeCommand,
  getWorktreeSnapshotRevisionsCommand,
  readLocalFileCommand,
  readLocalFileAtBranchCommand,
  readContainerFileCommand,
  readFileAtBranchCommand,
  readContainerFileBase64Command,
  readFileBase64Command,
  readEnvironmentFileBase64Command,
  writeLocalFileCommand,
  writeContainerFileCommand,
  writeInitialPromptAttachmentsCommand,
  copyExternalFileCommand,
  revertLocalFileCommand,
  revertContainerFileCommand,
  deleteLocalFileCommand,
  deleteContainerFileCommand,
  moveLocalFileCommand,
  moveContainerFileCommand,
  renameLocalFileCommand,
  renameContainerFileCommand,
  createLocalFolderCommand,
  createContainerFolderCommand,
  checkContainerWorkspacePathsCommand,
  deleteContainerAnnotationEvidenceCommand,
] as const;
