import { askCoordinatorSuborksCommand } from "@orkestrator/protocol/contract/domains/coordinator";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { SUBORK_LIMITS, type SuborkTargetRequest } from "@orkestrator/protocol/suborks";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { coordinatorCaller } from "./coordinator-action-scope.js";
import { surfaceRecord as record } from "./worker-surface-runs.js";

/**
 * The backend command behind a coordinator's `ask_agents` (docs/architecture/suborks.md).
 *
 * A coordinator conversation has no environment of its own: it runs on the
 * project's checkout. Its suborks run in the project home, the one environment
 * whose working directory is that checkout, so they read exactly what the
 * coordinator reads. They are read-only like every subork, so this is not a
 * way to delegate writes into the checkout a coordinator may only read; a
 * target its provider cannot hold read-only is guarded against the
 * checkout's Git state like everywhere else. The answers come back as mail to
 * the conversation's own mailbox.
 */

const TARGET_KEYS = new Set(["agent", "model", "name", "prompt"]);

function optionalText(value: unknown, field: string, max?: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected ${field}`);
  if (max !== undefined && value.trim().length > max) {
    throw new Error(`${field} is longer than ${max} characters`);
  }
  return value;
}

function targetsOf(value: unknown): SuborkTargetRequest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Expected targets");
  // Bounded for the request, as the tool's schema bounds it: targets past the
  // per-call limit fail on their own.
  if (value.length > 32) throw new Error("At most 32 targets per request");
  return value.map((entry, index) => {
    const target = record(entry, `target ${index + 1}`);
    for (const key of Object.keys(target)) {
      if (!TARGET_KEYS.has(key)) throw new Error(`Unexpected target field: ${key}`);
    }
    const agent = optionalText(target.agent, "agent", SUBORK_LIMITS.targetTextMaxChars)?.trim();
    const model = optionalText(target.model, "model", SUBORK_LIMITS.targetTextMaxChars)?.trim();
    const name = optionalText(target.name, "name", SUBORK_LIMITS.nameMaxChars)?.trim();
    const prompt = optionalText(target.prompt, "prompt");
    return {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(name ? { name } : {}),
      ...(prompt ? { prompt } : {}),
    };
  });
}

export function registerCoordinatorSuborkActions(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  register(askCoordinatorSuborksCommand, async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the ask_agents input");
    if (!context.suborks) throw new Error("Suborks are unavailable on this backend");
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
      caller.coordinatorId,
    );
    const conversation = workspace?.conversations.find(
      (item) => item.id === caller.conversationId && !item.closedAt,
    );
    if (!conversation) throw new Error("Coordinator identity is unavailable");
    if (!conversation.agent) {
      throw new Error("This conversation has no agent yet, so there is no one to answer.");
    }
    const runtimeId = coordinatorRuntimeId(caller.coordinatorId, caller.conversationId);
    const { descriptor } = await context.storage.getAgentMailMailbox(
      runtimeId,
      conversation.tabId,
      { limit: 1 },
    );
    if (descriptor.mutedInbound) {
      throw new Error(
        "This tab's inbound mail is muted, and suborks answer by mail. Unmute it first.",
      );
    }
    const ensureHome = dependencies.commands.get("ensure_project_home_environment");
    if (!ensureHome) throw new Error("The project home is unavailable on this backend");
    let home: { id?: unknown };
    try {
      home = record(
        await ensureHome({ projectId: caller.projectId }, context),
        "the project home",
      ) as { id?: unknown };
    } catch (error) {
      throw new Error(
        `Suborks run in this project's own checkout, which is not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof home.id !== "string") throw new Error("The project home has no id");
    const targets = targetsOf(input.targets);
    const prompt = optionalText(input.prompt, "prompt");
    const requestId = optionalText(input.requestId, "requestId", 256)?.trim();
    return context.suborks.ask(
      {
        environmentId: runtimeId,
        ...(descriptor.injectOverride === "off" ? { inboxOnly: true } : {}),
        projectId: caller.projectId,
        tabId: conversation.tabId,
        agent: conversation.agent,
        logicalSessionKey: conversation.logicalSessionKey,
        runEnvironmentId: home.id,
      },
      {
        targets,
        ...(prompt ? { prompt } : {}),
        ...(requestId ? { requestId } : {}),
      },
    );
  });
}
