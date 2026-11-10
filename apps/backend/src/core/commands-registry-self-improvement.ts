/**
 * Self-improvement commands for Settings → Self-improvement, and the service's
 * production wiring: config from `global`, this backend's diagnostics bundle
 * built in process, the chosen project's Kanban board, and Claude Code on the
 * account Orkestrator has active. See docs/architecture/self-improvement.md.
 */
import {
  getSelfImprovementStatusCommand,
  runSelfImprovementCommand,
} from "@orkestrator/protocol/contract/domains/system";
import { errorCode } from "@orkestrator/protocol/contract/ipc-error";
import { resolveSelfImprovementSettings } from "@orkestrator/protocol/self-improvement";
import { CLAUDE_PINNED_RUNTIME_ENV } from "@orkestrator/protocol/terminal-agent-launch";
import { applyActiveAgentAccountEnvironment } from "./agent-accounts-active.js";
import { resolveClaudeBinary } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { buildDiagnosticsBundle } from "./diagnostics-bundle.js";
import { diagnosticsSources } from "./diagnostics-sources.js";
import { applyClaudeHostCredentialEnvironment } from "./host-agent-credentials.js";
import type { Board, BoardTicket } from "./self-improvement/loop.js";
import { SelfImprovementService } from "./self-improvement/service.js";

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
  }): BoardTicket => ({
    id: task.id,
    title: task.title,
    status: task.status,
    prUrl: task.prUrl ?? null,
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
    async exportBundle() {
      return (await buildDiagnosticsBundle(await diagnosticsSources(context))).archive;
    },
    board: (projectId) => kanbanBoard(context, projectId),
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
}
