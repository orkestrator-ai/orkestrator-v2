import type {
  PublicPage,
  PublicProjectSummary,
  PublicSettingsSnapshot,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { projectLines, projectRows, receiptLines, settingsLines } from "../format.js";
import type { CommandSpec, OptionSpec } from "../spec.js";
import { REQUEST_ID_OPTION, stringOption, submit } from "./common.js";
import { settingsCommands } from "./settings.js";

const PAGE_OPTIONS: OptionSpec[] = [
  { name: "limit", kind: "integer", valueName: "N", description: "Items per page (max 200)." },
  {
    name: "cursor",
    kind: "string",
    valueName: "CURSOR",
    description: "Continue from a previous page.",
  },
];

export const projectCommands: CommandSpec[] = [
  {
    path: ["project", "list"],
    summary: "List projects.",
    positionals: [],
    options: PAGE_OPTIONS,
    idOutput: "project IDs, one per line",
    async run(context, parsed) {
      const session = await context.session();
      const page = await session.read<PublicPage<PublicProjectSummary>>("project.list", {
        ...(parsed.options.limit !== undefined ? { limit: parsed.options.limit } : {}),
        ...(parsed.options.cursor !== undefined ? { cursor: parsed.options.cursor } : {}),
      });
      return {
        action: "project.list",
        result: page,
        connection: session.identity,
        ids: page.items.map((project) => project.id),
        human: [
          ...projectRows(page.items),
          ...(page.nextCursor ? [`more: --cursor ${page.nextCursor}`] : []),
        ],
      };
    },
  },
  {
    path: ["project", "get"],
    summary: "Show one project by ID, or by --name when unique.",
    positionals: [{ name: "project", required: false }],
    options: [
      { name: "name", kind: "string", valueName: "NAME", description: "Exact project name." },
    ],
    idOutput: "project ID",
    async run(context, parsed) {
      const id = parsed.positionals.project as string | undefined;
      const name = stringOption(parsed.options, "name");
      if ((id ? 1 : 0) + (name ? 1 : 0) !== 1) {
        throw new CliError("invalid-input", "Pass a project ID or --name, not both");
      }
      const session = await context.session();
      const project = await session.read<PublicProjectSummary>(
        "project.get",
        id ? { projectId: id } : { name },
      );
      return {
        action: "project.get",
        result: project,
        connection: session.identity,
        ids: [project.id],
        human: projectLines(project),
      };
    },
  },
  {
    path: ["project", "add"],
    summary: "Register a repository, attach a backend checkout, or clone into a backend path.",
    description:
      "--remote alone registers the remote. --path alone attaches an existing checkout on the BACKEND's filesystem and reads its origin there. Both together attach the checkout if it exists, or clone the remote into that backend path when it is missing or empty. No GitHub repository is created.",
    positionals: [],
    options: [
      { name: "remote", kind: "string", valueName: "URL", description: "Git remote URL." },
      {
        name: "path",
        kind: "string",
        valueName: "BACKEND_PATH",
        description: "Absolute checkout path on the backend host.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "project ID",
    async run(context, parsed) {
      const remote = stringOption(parsed.options, "remote");
      const backendPath = stringOption(parsed.options, "path");
      if (!remote && !backendPath) {
        throw new CliError("invalid-input", "Pass --remote, --path, or both");
      }
      const { session, result, receipt, warnings } = await submit<{
        project: PublicProjectSummary;
      }>(
        context,
        "project.add",
        { ...(remote ? { remote } : {}), ...(backendPath ? { path: backendPath } : {}) },
        parsed.options,
      );
      return {
        action: "project.add",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.project.id],
        human: projectLines(result.project),
      };
    },
  },
  {
    path: ["project", "create"],
    summary: "Create a new repository: git init, a PRIVATE GitHub repository, and a push.",
    description:
      "This creates an external repository on GitHub using the backend's GitHub CLI credentials, pushes the initial commit, and registers the project. It requires --github-private to confirm that effect. Local-only initialization is not supported.",
    positionals: [],
    options: [
      {
        name: "path",
        kind: "string",
        valueName: "BACKEND_PATH",
        description: "New, empty directory on the backend host.",
      },
      {
        name: "github-private",
        kind: "boolean",
        description: "Required: confirm creating a private GitHub repository.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "project ID",
    async run(context, parsed) {
      const backendPath = stringOption(parsed.options, "path");
      if (!backendPath) throw new CliError("invalid-input", "--path is required");
      if (parsed.options["github-private"] !== true) {
        throw new CliError(
          "invalid-input",
          "project create makes a private GitHub repository and pushes to it; pass --github-private to confirm",
        );
      }
      const { session, result, receipt, warnings } = await submit<{
        project: PublicProjectSummary;
      }>(context, "project.create", { path: backendPath, githubPrivate: true }, parsed.options);
      return {
        action: "project.create",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.project.id],
        human: projectLines(result.project),
      };
    },
  },
  {
    path: ["project", "update"],
    summary: "Edit project metadata (does not move checkouts or rewrite .git/config).",
    positionals: [{ name: "project", required: true }],
    options: [
      { name: "name", kind: "string", valueName: "NAME", description: "Display name." },
      { name: "folder", kind: "string", valueName: "FOLDER", description: "Sidebar folder." },
      { name: "no-folder", kind: "boolean", description: "Remove the project from its folder." },
      {
        name: "remote",
        kind: "string",
        valueName: "URL",
        description: "Stored remote URL (metadata only).",
      },
      {
        name: "path",
        kind: "string",
        valueName: "BACKEND_PATH",
        description: "Stored checkout path (metadata only).",
      },
      { name: "no-path", kind: "boolean", description: "Clear the stored checkout path." },
      {
        name: "expected-revision",
        kind: "string",
        valueName: "REV",
        description: "Fail with a conflict unless the project is still at this revision.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "project ID",
    async run(context, parsed) {
      const options = parsed.options;
      const set: Record<string, unknown> = {};
      if (options.name !== undefined) set.name = options.name;
      if (options.folder !== undefined && options["no-folder"] === true) {
        throw new CliError("invalid-input", "--folder and --no-folder are mutually exclusive");
      }
      if (options.folder !== undefined) set.folder = options.folder;
      if (options["no-folder"] === true) set.folder = null;
      if (options.remote !== undefined) set.remote = options.remote;
      if (options.path !== undefined && options["no-path"] === true) {
        throw new CliError("invalid-input", "--path and --no-path are mutually exclusive");
      }
      if (options.path !== undefined) set.path = options.path;
      if (options["no-path"] === true) set.path = null;
      if (Object.keys(set).length === 0) throw new CliError("invalid-input", "Nothing to update");
      const { session, result, receipt, warnings } = await submit<{
        project: PublicProjectSummary;
      }>(
        context,
        "project.update",
        {
          projectId: parsed.positionals.project,
          set,
          ...(options["expected-revision"] !== undefined
            ? { expectedRevision: options["expected-revision"] }
            : {}),
        },
        options,
      );
      return {
        action: "project.update",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.project.id],
        human: projectLines(result.project),
      };
    },
  },
  {
    path: ["project", "remove"],
    summary: "Remove an empty project registration (refused while environments exist).",
    description:
      "Only the registration is removed. The checkout on disk and any remote repository are never deleted.",
    positionals: [{ name: "project", required: true }],
    options: [REQUEST_ID_OPTION],
    idOutput: "operation ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit(
        context,
        "project.remove",
        { projectId: parsed.positionals.project },
        parsed.options,
      );
      return {
        action: "project.remove",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: receipt ? receiptLines(receipt) : ["removed"],
      };
    },
  },
  ...settingsCommands("project"),
];

export type { PublicSettingsSnapshot };
export { settingsLines };
