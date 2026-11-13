/**
 * `projects` commands (plan item 7005): the project list and its sidebar
 * arrangement, adding, creating and removing projects, the GitHub clone
 * browser, the host folder picker and icons, the per-machine half of copying
 * a project between machines, and the AGENTS.md section proposals.
 *
 * Arguments: a key the handler read with `asString(x, "x")` (directly or
 * through `asNonBlankString`, which reads it with `asString` first) is
 * `Schema.String`, and an optional `asRequiredBoolean` flag is
 * `optionalKey(Boolean)`: the registry's text for a missing or mistyped key is
 * the same `Expected x to be a string` / `a boolean`. Every other key the
 * handler checks or coerces itself is `optionalKey(Unknown)`, so nothing
 * accepted today is refused, each message is unchanged, and a handler that
 * checked its keys in a particular order still reports the first one first.
 * The formerly strict handlers (`assertOnlyKeys`) declare exactly the keys
 * they allowed and now drop unknown ones (§11.4).
 *
 * `access`: `internal` for `request_coordinator_agents_md_update` (the
 * coordinator's Control MCP tool; workspace-excluded), `workspace` for the
 * rest (none was on the old grant deny-lists). `read` equals
 * `isNodeReadCommand` (pinned by `projects-config.test.ts`).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { mutableArray } from "../../model-schema.js";
import { defineCommand } from "../../command.js";
import { projectsDomain } from "./domain.js";
import {
  AgentsMdProposalSchema,
  AgentsMdPullRequestSchema,
  AgentsMdSectionReadSchema,
  CreatedHostDirectorySchema,
  GitHubCloneAccountSchema,
  GitHubCloneRepositoryListSchema,
  HostDirectoryListingSchema,
  HostImageFileSchema,
  ProjectCloneSchema,
  ProjectCopyCandidatesSchema,
  ProjectCopyFileListSchema,
  ProjectListSchema,
  ProjectLocationSchema,
  ProjectSchema,
  ProjectSummaryRowSchema,
} from "./models.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);

/**
 * `get_projects`: the list (a node summary's rows with `summaryIcons` or
 * `includeDefaultBranch`), or with a known manifest generation and revision a
 * `ConditionalResourceSnapshot` (`resource-events.ts`).
 */
export const ProjectsReadSchema = Schema.Union([
  mutableArray(ProjectSummaryRowSchema),
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    generation: Schema.String,
    revision: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("changed"),
    generation: Schema.String,
    revision: Schema.String,
    snapshot: ProjectListSchema,
  }),
]);

/** This node's projects. */
export const getProjectsCommand = defineCommand({
  domain: projectsDomain,
  name: "get_projects",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    summaryIcons: optionalBoolean,
    includeDefaultBranch: optionalBoolean,
    knownManifestGeneration: optionalUnknown,
    knownResourceRevision: optionalUnknown,
  }),
  result: ProjectsReadSchema,
  critical: [],
});

/** One project, or null. */
export const getProjectCommand = defineCommand({
  domain: projectsDomain,
  name: "get_project",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.NullOr(ProjectSchema),
  critical: [],
});

/**
 * Registers a Git remote, or an existing or cloned checkout. `cloneOnly` is
 * critical: ignored, an existing folder would be adopted instead of refused.
 */
export const addProjectCommand = defineCommand({
  domain: projectsDomain,
  name: "add_project",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    gitUrl: Schema.String,
    localPath: optionalUnknown,
    cloneOnly: optionalBoolean,
  }),
  result: ProjectSchema,
  critical: ["cloneOnly"],
});

/** A new repository in a new folder, registered as a project. */
export const createProjectFromScratchCommand = defineCommand({
  domain: projectsDomain,
  name: "create_project_from_scratch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ localPath: Schema.String }),
  result: ProjectSchema,
  critical: [],
});

/** The signed-in GitHub CLI account and its organizations. */
export const listGitHubCloneAccountsCommand = defineCommand({
  domain: projectsDomain,
  name: "list_github_clone_accounts",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: mutableArray(GitHubCloneAccountSchema),
  critical: [],
});

/** One page of an account's repositories. */
export const listGitHubCloneRepositoriesCommand = defineCommand({
  domain: projectsDomain,
  name: "list_github_clone_repositories",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ owner: Schema.String, cursor: Schema.optionalKey(Schema.String) }),
  result: GitHubCloneRepositoryListSchema,
  critical: [],
});

/** Removes a project and everything it owns outside projects.json. */
export const removeProjectCommand = defineCommand({
  domain: projectsDomain,
  name: "remove_project",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Renames, moves, regroups or re-icons a project. */
export const updateProjectCommand = defineCommand({
  domain: projectsDomain,
  name: "update_project",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String, updates: optionalUnknown }),
  result: ProjectSchema,
  critical: [],
});

/** The sidebar order, as a full list of ids. */
export const reorderProjectsCommand = defineCommand({
  domain: projectsDomain,
  name: "reorder_projects",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectIds: optionalUnknown }),
  result: ProjectListSchema,
  critical: [],
});

/** A sidebar gesture, resolved against the current projects under the store lock. */
export const arrangeProjectsByIntentCommand = defineCommand({
  domain: projectsDomain,
  name: "arrange_projects_by_intent",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ intent: optionalUnknown }),
  result: ProjectListSchema,
  critical: [],
});

/** Kept for older clients and nodes: order and folders in one write. */
export const arrangeProjectsCommand = defineCommand({
  domain: projectsDomain,
  name: "arrange_projects",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectIds: optionalUnknown, folders: optionalUnknown }),
  result: ProjectListSchema,
  critical: [],
});

/** Whether `url` is an HTTPS, SSH or git@ remote. */
export const validateGitUrlCommand = defineCommand({
  domain: projectsDomain,
  name: "validate_git_url",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ url: Schema.String }),
  result: Schema.Boolean,
  critical: [],
});

/** A checkout's raw `remote.origin.url`, or null. */
export const getGitRemoteUrlCommand = defineCommand({
  domain: projectsDomain,
  name: "get_git_remote_url",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ path: Schema.String }),
  result: Schema.NullOr(Schema.String),
  critical: [],
});

/** One directory of the backend's host, for the folder picker. */
export const listHostDirectoryCommand = defineCommand({
  domain: projectsDomain,
  name: "list_host_directory",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    path: Schema.optionalKey(Schema.String),
    includeFiles: optionalBoolean,
    showHidden: optionalBoolean,
  }),
  result: HostDirectoryListingSchema,
  critical: [],
});

/** A new folder on the backend's host. */
export const createHostDirectoryCommand = defineCommand({
  domain: projectsDomain,
  name: "create_host_directory",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ parent: Schema.String, name: Schema.String }),
  result: CreatedHostDirectorySchema,
  critical: [],
});

/** Images a project usually keeps its icon in, best first. */
export const findProjectIconsCommand = defineCommand({
  domain: projectsDomain,
  name: "find_project_icons",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ root: Schema.String }),
  result: mutableArray(Schema.String),
  critical: [],
});

/** One image of the backend's host, for a project icon. */
export const readHostImageFileCommand = defineCommand({
  domain: projectsDomain,
  name: "read_host_image_file",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ path: Schema.String }),
  result: HostImageFileSchema,
  critical: [],
});

/** Where a copy of a project lands on this machine. */
export const getDefaultProjectLocationCommand = defineCommand({
  domain: projectsDomain,
  name: "get_default_project_location",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ name: optionalUnknown }),
  result: ProjectLocationSchema,
  critical: [],
});

/** The files Git does not carry at a project's root. */
export const listProjectCopyCandidatesCommand = defineCommand({
  domain: projectsDomain,
  name: "list_project_copy_candidates",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: ProjectCopyCandidatesSchema,
  critical: [],
});

/** The regular files under a selection. */
export const listProjectCopyFilesCommand = defineCommand({
  domain: projectsDomain,
  name: "list_project_copy_files",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown, paths: optionalUnknown }),
  result: ProjectCopyFileListSchema,
  critical: [],
});

/**
 * Starts a background clone. `requestKey` is critical: the idempotency key,
 * ignored a retry would start a second clone.
 */
export const startProjectCloneCommand = defineCommand({
  domain: projectsDomain,
  name: "start_project_clone",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    requestKey: optionalUnknown,
    gitUrl: optionalUnknown,
    localPath: optionalUnknown,
  }),
  result: ProjectCloneSchema,
  critical: ["requestKey"],
});

/** A background clone's state. */
export const getProjectCloneCommand = defineCommand({
  domain: projectsDomain,
  name: "get_project_clone",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ requestKey: optionalUnknown }),
  result: ProjectCloneSchema,
  critical: [],
});

/** A main coordinator's AGENTS.md proposal, as a node action request. */
export const requestCoordinatorAgentsMdUpdateCommand = defineCommand({
  domain: projectsDomain,
  name: "request_coordinator_agents_md_update",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ scope: optionalUnknown, input: optionalUnknown, target: optionalUnknown }),
  result: AgentsMdProposalSchema,
  critical: [],
});

/** The `## Orkestrator` section on the freshly fetched base branch. */
export const readProjectAgentsMdSectionCommand = defineCommand({
  domain: projectsDomain,
  name: "read_project_agents_md_section",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: AgentsMdSectionReadSchema,
  critical: [],
});

/**
 * Opens the approved AGENTS.md pull request. `requestKey` is critical: the
 * idempotency key, ignored a retry would open a second pull request.
 */
export const openProjectAgentsMdPrCommand = defineCommand({
  domain: projectsDomain,
  name: "open_project_agents_md_pr",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    requestKey: Schema.String,
    changes: optionalUnknown,
    reason: optionalUnknown,
    nodeName: optionalUnknown,
  }),
  result: AgentsMdPullRequestSchema,
  critical: ["requestKey"],
});

/**
 * Points a project checkout's GitHub SSH `origin` at its HTTPS form, after
 * checking HTTPS works from this machine. Offered when a start could not
 * reach the remote over SSH (`lifecycleRemedy: "use-https"`). The stored
 * project `gitUrl` is unchanged. `remoteUrl` carries no credential.
 */
export const useHttpsGitRemoteCommand = defineCommand({
  domain: projectsDomain,
  name: "use_https_git_remote",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.Struct({ remoteUrl: Schema.String, changed: Schema.Boolean }),
  critical: [],
});

/**
 * The Debian packages a project's `orkestrator-ai.json` declares in
 * `aptPackages` (`@orkestrator/protocol/apt-packages`): the names setup would
 * install, those the installer refuses outright, and whether the field cannot
 * be installed as written.
 */
export const DeclaredAptPackagesSchema = Schema.Struct({
  packages: mutableArray(Schema.String),
  refused: mutableArray(
    Schema.Struct({
      name: Schema.String,
      reason: Schema.Literals(["malformed", "denied"]),
    }),
  ),
  invalid: Schema.Boolean,
});

/**
 * What the project's `orkestrator-ai.json` asks of a new container, so a
 * launcher can warn before it creates one that cannot finish setup:
 * `rootSteps` counts the default branch's `root` steps (which run only with
 * full network access), and `aptPackages` lists the Debian packages it
 * declares (to-do 7770; absent from an older backend), both read from this
 * machine's checkout without fetching. `null` when the machine cannot tell.
 * Advisory; setup itself decides.
 */
export const getProjectSetupRequirementsCommand = defineCommand({
  domain: projectsDomain,
  name: "get_project_setup_requirements",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.Struct({
    rootSteps: Schema.NullOr(Schema.Number),
    aptPackages: Schema.optionalKey(Schema.NullOr(DeclaredAptPackagesSchema)),
  }),
  critical: [],
});

/** Every `projects` command definition. */
export const PROJECTS_COMMANDS = [
  getProjectsCommand,
  getProjectCommand,
  addProjectCommand,
  createProjectFromScratchCommand,
  listGitHubCloneAccountsCommand,
  listGitHubCloneRepositoriesCommand,
  removeProjectCommand,
  updateProjectCommand,
  reorderProjectsCommand,
  arrangeProjectsByIntentCommand,
  arrangeProjectsCommand,
  validateGitUrlCommand,
  getGitRemoteUrlCommand,
  listHostDirectoryCommand,
  createHostDirectoryCommand,
  findProjectIconsCommand,
  readHostImageFileCommand,
  getDefaultProjectLocationCommand,
  listProjectCopyCandidatesCommand,
  listProjectCopyFilesCommand,
  startProjectCloneCommand,
  getProjectCloneCommand,
  requestCoordinatorAgentsMdUpdateCommand,
  readProjectAgentsMdSectionCommand,
  openProjectAgentsMdPrCommand,
  useHttpsGitRemoteCommand,
  getProjectSetupRequirementsCommand,
] as const;
