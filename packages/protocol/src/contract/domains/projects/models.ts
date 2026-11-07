/**
 * The project model and the other records the `projects` commands answer
 * (plan item 7005): `Project` of `apps/backend/src/core/models.ts` field for
 * field, the GitHub clone browser (`github-clone.ts`), the host folder picker
 * (`commands-host-files.ts`), project copies between machines
 * (`project-copy.ts`) and the AGENTS.md section proposals
 * (`agents-md-orkestrator.ts`). Plan item 7010 makes these the single
 * definition the backend and the renderer infer their types from; `Project`
 * already is (`models.ts` and `apps/web/src/types/index.ts` re-export it).
 *
 * Rules (docs/architecture/version-compatibility.md#defining-commands-and-events),
 * as in `environments/models.ts`: numbers are `Schema.Finite`, the schemas
 * are JSON-shaped, optional record fields are `Schema.optional` (a handler's
 * record may carry a field set to `undefined`), and arrays are mutable so the
 * inferred types stay assignable to today's model types. A client decodes
 * results tolerantly (unknown keys dropped), so every field a caller reads is
 * declared; a new literal in one of the vocabularies below is a change an
 * older client cannot decode, so it bumps the domain.
 *
 * {@link openRecord} is for records a client writes back whole (the settings
 * in `config/models.ts`) and for records another backend part extends: it
 * checks the declared fields and keeps every other key, so a decode never
 * loses a field a newer backend added.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { mutableArray, openRecord } from "../../model-schema.js";
import type { Mutable } from "effect/Types";

const optionalString = Schema.optional(Schema.String);
const optionalNullableString = Schema.optional(Schema.NullOr(Schema.String));

/** The project fields; also the base of a node summary's row. */
export const projectFields = {
  id: Schema.String,
  name: Schema.String,
  gitUrl: Schema.String,
  localPath: Schema.NullOr(Schema.String),
  addedAt: Schema.String,
  /** Display order in the sidebar (lower values appear first). */
  order: Schema.Finite,
  /**
   * Sidebar folder this project is grouped under, or null/absent for the root
   * level. The name is the folder's whole identity — see
   * `@orkestrator/protocol/project-folders`.
   */
  folder: optionalNullableString,
  /**
   * Sidebar icon: a small raster image as a base64 data URL, or absent for
   * the default. See `@orkestrator/protocol/project-icon`.
   */
  icon: optionalNullableString,
};

/**
 * One registered project: the single definition of `Project`, which
 * `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts`
 * re-export (plan items 7005 and 7010). The type is the schema's, mutable as
 * the model always was.
 */
export const ProjectSchema = Schema.Struct(projectFields).annotate({ identifier: "Project" });
export type Project = Mutable<typeof ProjectSchema.Type>;

/**
 * A `get_projects` row for a command node's summary of this node
 * (`includeDefaultBranch`): the project with its configured default branch,
 * when it has one.
 */
export const ProjectSummaryRowSchema = Schema.Struct({
  ...projectFields,
  defaultBranch: optionalString,
});
export type ProjectSummaryRow = typeof ProjectSummaryRowSchema.Type;

export const ProjectListSchema = mutableArray(ProjectSchema);

// --- Adding a project from GitHub (`github-clone.ts`) -------------------------

export const GitHubCloneAccountSchema = Schema.Struct({
  login: Schema.String,
  /** The signed-in user's own account, or an organization they belong to. */
  kind: Schema.Literals(["user", "organization"]),
});

export const GitHubCloneRepositorySchema = Schema.Struct({
  name: Schema.String,
  /** `owner/name`. */
  fullName: Schema.String,
  description: Schema.NullOr(Schema.String),
  isPrivate: Schema.Boolean,
  isFork: Schema.Boolean,
  isArchived: Schema.Boolean,
  /** ISO timestamp of the most recent push or metadata change. */
  updatedAt: Schema.NullOr(Schema.String),
  /** Remote URL in the protocol the GitHub CLI is configured to use. */
  cloneUrl: Schema.String,
});

export const GitHubCloneRepositoryListSchema = Schema.Struct({
  repositories: mutableArray(GitHubCloneRepositorySchema),
  /** True when more pages are available for this account. */
  truncated: Schema.Boolean,
  /** Opaque cursor for the next page; absent on the final page. */
  nextCursor: optionalString,
});

// --- The host folder picker (`commands-host-files.ts`) ------------------------

export const HostDirectoryEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  isDirectory: Schema.Boolean,
});

/** `HostDirectoryListing`: one directory of the backend's host. */
export const HostDirectoryListingSchema = Schema.Struct({
  /** Absolute directory that was actually listed (the nearest existing ancestor of the request). */
  path: Schema.String,
  /** Normalized explicitly requested non-directory, independent of the listing cap. */
  requestedFile: Schema.NullOr(Schema.String),
  /** Parent directory, or null at a filesystem root. */
  parent: Schema.NullOr(Schema.String),
  home: Schema.String,
  /** Top-level locations to jump to: `/` on POSIX, existing drive letters on Windows. */
  roots: mutableArray(Schema.String),
  entries: mutableArray(HostDirectoryEntrySchema),
  /** True when the directory held more than the listing cap of visible entries. */
  truncated: Schema.Boolean,
});
export type HostDirectoryListing = typeof HostDirectoryListingSchema.Type;

export const CreatedHostDirectorySchema = Schema.Struct({ path: Schema.String });

/** `HostImageFile`: one image of the backend's host, for a project icon. */
export const HostImageFileSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  base64: Schema.String,
});
export type HostImageFile = typeof HostImageFileSchema.Type;

// --- Copying a project between machines (`project-copy.ts`) -------------------

/** Where a copy of a project lands on this machine. */
export const ProjectLocationSchema = Schema.Struct({
  directory: Schema.String,
  location: Schema.String,
  /** The configured folder, the most common parent of the projects, or `~/Projects`. */
  source: Schema.Literals(["setting", "projects", "home"]),
});

/** One background clone (`start_project_clone`/`get_project_clone`). */
export const ProjectCloneSchema = Schema.Struct({
  requestKey: Schema.String,
  /** `unknown`: no clone under this key on this machine (never started, or pruned). */
  state: Schema.Literals(["running", "completed", "failed", "unknown"]),
  localPath: optionalString,
  startedAt: optionalString,
  finishedAt: optionalString,
  projectId: optionalString,
  error: optionalString,
});

/** `ProjectCopyCandidate`: one untracked or ignored entry of a project root. */
export const ProjectCopyCandidateSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
  bytes: Schema.Finite,
  files: Schema.Finite,
  truncated: Schema.Boolean,
  suggested: Schema.Boolean,
  heavy: Schema.Boolean,
});

export const ProjectCopyCandidatesSchema = Schema.Struct({
  candidates: mutableArray(ProjectCopyCandidateSchema),
  truncated: Schema.Boolean,
});

/** `ProjectCopyFileList`: the regular files under a selection. */
export const ProjectCopyFileListSchema = Schema.Struct({
  files: mutableArray(Schema.Struct({ path: Schema.String, bytes: Schema.Finite })),
  totalBytes: Schema.Finite,
  skipped: Schema.Finite,
  tooLarge: mutableArray(Schema.String),
});

// --- AGENTS.md section proposals (`agents-md-orkestrator.ts`) -----------------

export const AgentsMdChangeSchema = Schema.Struct({
  action: Schema.Literals(["add", "replace", "remove"]),
  text: Schema.String,
  replaces: optionalString,
});

export const AgentsMdSectionSchema = Schema.Struct({
  exists: Schema.Boolean,
  text: Schema.NullOr(Schema.String),
  entries: mutableArray(Schema.String),
});

/** The `## Orkestrator` section on the freshly fetched base branch. */
export const AgentsMdSectionReadSchema = Schema.Struct({
  baseBranch: Schema.String,
  baseCommit: Schema.String,
  fetched: Schema.Boolean,
  fetchError: optionalString,
  fileExists: Schema.Boolean,
  section: AgentsMdSectionSchema,
});

/** `AgentsMdPrResult` (`agents-md-pr.ts`). */
export const AgentsMdPullRequestSchema = Schema.Struct({
  status: Schema.Literals(["opened", "existing", "unchanged"]),
  url: optionalString,
  branch: Schema.String,
  baseBranch: Schema.String,
  baseCommit: optionalString,
  outcomes: mutableArray(
    Schema.Struct({
      change: AgentsMdChangeSchema,
      result: Schema.Literals(["applied", "already", "conflict"]),
      detail: optionalString,
    }),
  ),
});

/**
 * A coordinator's proposal (`request_coordinator_agents_md_update`): the
 * approval request it created, or its replay, and where that request is now.
 * Open: a replay carries the receipt's own fields.
 */
export const AgentsMdProposalSchema = openRecord({
  approvalRequestId: Schema.optional(Schema.Unknown),
  nodeId: Schema.optional(Schema.Unknown),
  branch: optionalString,
  replayed: Schema.optional(Schema.Boolean),
  state: Schema.String,
  outcome: optionalString,
  prUrl: optionalString,
});
