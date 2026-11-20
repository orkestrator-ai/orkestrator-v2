/**
 * Self-improvement commands for Settings → Self-improvement, and the service's
 * production wiring: config from `global`, this backend's diagnostics bundle
 * built in process, the chosen project's Kanban board, and Claude Code on the
 * account Orkestrator has active. See docs/architecture/self-improvement.md.
 */
import {
  collectSelfImprovementConversationsCommand,
  collectSelfImprovementDiagnosticsCommand,
  getSelfImprovementStatusCommand,
  runSelfImprovementCommand,
  systemClient,
} from "@orkestrator/protocol/contract/domains/system";
import { isBackendId } from "@orkestrator/protocol/federation";
import { errorCode } from "@orkestrator/protocol/contract/ipc-error";
import path from "node:path";
import { resolveSelfImprovementSettings } from "@orkestrator/protocol/self-improvement";
import { CLAUDE_PINNED_RUNTIME_ENV } from "@orkestrator/protocol/terminal-agent-launch";
import { applyActiveAgentAccountEnvironment } from "./agent-accounts-active.js";
import { resolveClaudeBinary } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { buildDiagnosticsBundle } from "./diagnostics-bundle.js";
import { diagnosticsSources } from "./diagnostics-sources.js";
import { applyClaudeHostCredentialEnvironment } from "./host-agent-credentials.js";
import { attachedController } from "./commands-registry-ticket-sync.js";
import { linkDomainApi } from "./nodes/index.js";
import {
  answerLeafConversations,
  answerLeafDiagnostics,
  type Board,
  type BoardTicket,
  defaultSources,
  type LeafNode,
  parseLeafArchive,
  parseLeafSelection,
  SelfImprovementService,
} from "./self-improvement/index.js";

/** Credentials a review run never needs; the title runner strips the same ones. */
const STRIPPED_ENV = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

/** One project's board over Kanban storage, as a run sees it. */
export function kanbanBoard(context: CommandContext, projectId: string): Board {
  const kanban = context.storage.kanban;
  const ticket = (task: {
    id: string;
    title: string;
    status: string;
    prUrl?: string | null;
    labels?: string[];
  }): BoardTicket => ({
    id: task.id,
    title: task.title,
    status: task.status,
    prUrl: task.prUrl ?? null,
    labels: task.labels ?? [],
  });
  return {
    projectId,
    async get(ticketId) {
      const task = await kanban.getKanbanTask(ticketId);
      return task && task.projectId === projectId ? ticket(task) : null;
    },
    async locate(ticketId) {
      return (await kanban.getKanbanTask(ticketId))?.projectId ?? null;
    },
    async list() {
      return (await kanban.getKanbanTasks(projectId)).map(ticket);
    },
    async create(input) {
      const task = await kanban.addKanbanTask(projectId, input.title, input.description, {
        acceptanceCriteria: input.criteria,
        status: "backlog",
        requestId: input.requestId,
        labels: [input.label],
      });
      return task.id;
    },
    async comment(ticketId, text, requestId) {
      try {
        await kanban.addKanbanComment(ticketId, text, projectId, requestId);
      } catch (error) {
        // The id was used with other numbers: an earlier attempt already posted this verdict.
        if (errorCode(error) !== "kanban-request-id-conflict") throw error;
      }
    },
    async moveToBacklog(ticketId) {
      await kanban.updateKanbanTask(ticketId, { status: "backlog" }, projectId);
    },
    async ensureLabels(labels) {
      const have = new Set((await kanban.getKanbanLabels(projectId)).map((label) => label.name));
      for (const label of labels) {
        if (!have.has(label.name)) await kanban.createKanbanLabel(projectId, { ...label });
      }
    },
  };
}

/** A bundle for a run: this backend's own sources without debug logs, which a run never reads. */
async function selfImprovementBundle(context: CommandContext): Promise<Buffer> {
  const sources = await diagnosticsSources(context);
  return (await buildDiagnosticsBundle({ ...sources, debugLogging: false })).archive;
}

/**
 * On a command node, this machine and its connected leaf nodes, each reached
 * over this node's own link (docs/architecture/self-improvement.md, "Leaf nodes").
 */
export async function selfImprovementFleet(
  context: CommandContext,
): Promise<{ self: { nodeId: string; name: string }; leaves: LeafNode[] } | null> {
  const nodes = context.nodes;
  if (!nodes || nodes.mode() !== "command") return null;
  const controllerId = await nodes.selfIdentity();
  const selfName = (await nodes.selfProfile()).displayName || "This machine";
  const leaves: LeafNode[] = (await nodes.listNodes()).nodes
    .filter((node) => node.connection.state === "connected" && isBackendId(node.nodeId))
    .map((node) => {
      const api = () => {
        const link = nodes.link(node.nodeId);
        if (!link?.connected) throw new Error("The node is not connected.");
        return linkDomainApi(link, systemClient);
      };
      return {
        nodeId: node.nodeId,
        name: node.displayName || node.fallbackName || node.nodeId,
        async diagnostics() {
          return parseLeafArchive(
            await api().collect_self_improvement_diagnostics({ controllerId }),
          );
        },
        async conversations({ cursor, maxSegments }) {
          return parseLeafSelection(
            await api().collect_self_improvement_conversations({
              controllerId,
              cursor,
              maxSegments,
            }),
            maxSegments,
          );
        },
      };
    });
  return { self: { nodeId: controllerId, name: selfName }, leaves };
}

/** The production service on `context`. The backend starts and stops it. */
export function createSelfImprovementService(context: CommandContext): SelfImprovementService {
  return new SelfImprovementService({
    dataDir: context.storage.getDataDir(),
    async config() {
      const global = (await context.storage.loadConfig()).global;
      return {
        enabled: global.experimentalSelfImprovement === true,
        settings: resolveSelfImprovementSettings(global.selfImprovement),
      };
    },
    async projectName(projectId) {
      return (await context.storage.getProject(projectId))?.name ?? null;
    },
    exportBundle: () => selfImprovementBundle(context),
    board: (projectId) => kanbanBoard(context, projectId),
    fleet: () => selfImprovementFleet(context),
    // The data directory's single-writer guard, as scheduled jobs use it.
    isWriter: () => context.registryWriterLease?.isHeld() ?? true,
    async claudeLaunch() {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of STRIPPED_ENV) delete env[key];
      const executable = resolveClaudeBinary(context);
      if (executable !== "claude") Object.assign(env, CLAUDE_PINNED_RUNTIME_ENV);
      await applyClaudeHostCredentialEnvironment(context, env);
      await applyActiveAgentAccountEnvironment(context, "claude", env);
      return { executable, env };
    },
  });
}

function service(context: CommandContext): SelfImprovementService {
  if (!context.selfImprovement) throw new Error("Self-improvement is unavailable on this backend.");
  return context.selfImprovement;
}

export function registerSelfImprovementCommands(register: CommandRegistrar): void {
  register(getSelfImprovementStatusCommand, async (_args, context) => service(context).status());
  register(runSelfImprovementCommand, async (args, context) =>
    service(context).run({ trigger: args.dryRun === true ? "dry-run" : "manual" }),
  );
  // Leaf side of a command node's run: link-only (`node-routing.ts`), from an
  // attached command node only, read-only, whether or not the feature is on here.
  register(collectSelfImprovementDiagnosticsCommand, async (args, context) => {
    attachedController(args, context);
    return answerLeafDiagnostics(() => selfImprovementBundle(context));
  });
  register(collectSelfImprovementConversationsCommand, async (args, context) => {
    attachedController(args, context);
    const dataDir = path.resolve(context.storage.getDataDir());
    return answerLeafConversations({
      sources: defaultSources(dataDir),
      excludeDirs: [dataDir],
      cursor: args.cursor,
      maxSegments: args.maxSegments,
      now: Date.now(),
    });
  });
}
