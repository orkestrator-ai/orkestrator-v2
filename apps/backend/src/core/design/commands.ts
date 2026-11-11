import { extname, isAbsolute } from "node:path";
import type { AnyCommandDef, ArgsOf, ResultOf } from "@orkestrator/protocol/contract/command";
import {
  DesignCapturePrioritySchema,
  DesignCheckpointSideSchema,
  DesignCursorSchema,
  DesignEntryIdSchema,
  DesignEnvironmentIdSchema,
  DesignFingerprintSchema,
  DesignGenerationSchema,
  DesignHistoryLimitSchema,
  DesignIdSchema,
  DesignLibraryQuerySchema,
  DesignLinkIdSchema,
  DesignMaxDepthSchema,
  DesignMaxNodesSchema,
  DesignOffsetSchema,
  DesignRelativePathSchema,
  DesignReplaceLinkIdSchema,
  DesignRevisionSchema,
  DesignRootSelectorSchema,
  DesignSessionLinkInputSchema,
  DesignStatusVersionSchema,
  DesignTabIdSchema,
  DesignTokenSchema,
  DesignWaitMsSchema,
  designActionCommand,
  designCancelCommand,
  designCapabilitiesCommand,
  designCaptureCommand,
  designCheckpointCommand,
  designExecuteCommand,
  designExportPreviewCommand,
  designExportReconcileCommand,
  designExportSaveCommand,
  designHierarchyCommand,
  designHistoryCommand,
  designImportCommand,
  designImportHostFileCommand,
  designIntentDiscardCommand,
  designIntentImportCommand,
  designIntentResumeCommand,
  designIntentRunCommand,
  designIntentSaveCommand,
  designIntentsCommand,
  designLibraryCommand,
  designOpenFileCommand,
  designOperationStatusCommand,
  designPrepareCommand,
  designPurgeCommand,
  designReadinessCommand,
  designSessionLinkCommand,
  designSessionLinkStatesCommand,
  designSessionResumeCommand,
  designSessionUnlinkCommand,
  designSnapshotCommand,
  designSyncCommand,
  designValidateCommand,
} from "@orkestrator/protocol/contract/domains/design";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { CommandContext } from "../commands-context.js";
import {
  contractCommandHandler,
  contractResultValidationDefault,
} from "../commands-registry-contracts.js";
import type { CommandRegistrar, DefinedCommandHandler } from "../commands-registry-types.js";
import {
  BUILD_PIPELINE_AGENTS,
  type BuildPipelineAgent,
} from "@orkestrator/protocol/build-pipeline";
import type {
  DesignCommandResult,
  DesignSessionLink,
} from "@orkestrator/protocol/design-operations";
import { DesignError, toDesignFailure } from "./errors.js";
import {
  exportPreview,
  exportSave,
  openDesignFile,
  reconcileExport,
  resolveDesignDestination,
} from "./exports.js";
import { readDesignHostFile } from "./host-file.js";
import {
  discardIntent,
  importIntents,
  listIntents,
  resumeIntent,
  runIntent,
  saveIntentDrafts,
} from "./intents.js";
import { purge } from "./service-lifecycle.js";
import type { DesignService } from "./service.js";
import type { DesignArchivedSessionLookup, DesignSessionResumer } from "./session-links.js";
import { runDesignAction } from "./tools.js";
import { validate as validateFrame } from "./validation.js";

/**
 * One argument of a v2 command, decoded with its precise schema inside the
 * typed envelope: a failure is the same `invalid-input` failure today's
 * per-field parse gave (`toDesignFailure`), never a thrown schema error.
 */
function arg<T>(schema: Schema.Codec<T, unknown, never, never>, value: unknown, name: string): T {
  const decoded = Schema.decodeUnknownResult(schema)(value);
  if (Result.isSuccess(decoded)) return decoded.success;
  throw new DesignError("invalid-input", `Invalid design input: ${name}`, {
    retry: "never",
    details: { fields: [name] },
  });
}

/** An optional argument: absent stays absent. */
function optionalArg<T>(
  schema: Schema.Codec<T, unknown, never, never>,
  value: unknown,
  name: string,
): T | undefined {
  return value === undefined ? undefined : arg(schema, value, name);
}

/** Typed envelope: new clients branch on `failure.code`, never on message text. */
async function typed<T>(work: () => Promise<T>): Promise<DesignCommandResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, failure: toDesignFailure(error) };
  }
}

/**
 * The design command surface depends only on this narrow context, so it can be
 * driven directly (e.g. by the component browser harness) without the full
 * backend command context.
 */
export interface DesignCommandContext {
  design?: DesignService;
  /** The native-agent session APIs a link resume goes through; absent from narrow harnesses. */
  nativeAgents?: {
    resumeProjectionSession(input: {
      environmentId: string;
      agent: BuildPipelineAgent;
      logicalSessionKey: string;
      providerSessionId: string;
    }): Promise<unknown>;
    /** Unarchive before a resume the user asked to restore; absent from narrow harnesses. */
    setProjectionResumableSessionArchived?(input: {
      environmentId: string;
      agent: BuildPipelineAgent;
      logicalSessionKey: string;
      resumableSessionId: string;
      archived: boolean;
    }): Promise<void>;
    /**
     * Which of these conversations the agent lists as archived, asked only of a
     * running bridge; `undefined` when none answers. Absent from narrow harnesses.
     */
    archivedResumableSessionIdsIfRunning?(
      environmentId: string,
      agent: BuildPipelineAgent,
      resumableSessionIds: readonly string[],
    ): Promise<ReadonlySet<string> | undefined>;
  };
  storage: {
    getEnvironment(environmentId: string): Promise<unknown>;
    /** The backend's durable native-session record; absent from narrow harnesses. */
    getNativeAgentSession?(key: string): Promise<{
      environmentId: string;
      agent: string;
      logicalSessionKey: string;
      providerSessionId: string;
    } | null>;
  };
}

export interface DesignCommandOptions {
  /** How the backend keys native-session records (`nativeAgentSessionStorageKey`). */
  nativeSessionKey?: (
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ) => string;
  /** Tests: {@link DESIGN_ARCHIVED_READ_DEADLINE_MS}. */
  archivedReadDeadlineMs?: number;
}

function linkAgent(link: DesignSessionLink): BuildPipelineAgent | null {
  return BUILD_PIPELINE_AGENTS.find((candidate) => candidate === link.platform) ?? null;
}

/** The renderer's `createSessionKey(environmentId, tabId)`. */
function tabSessionKey(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}

/**
 * Reads the native-session mapping of a tab. Storage only, never a bridge.
 * Tab teardown retires the mapping, so a closed tab reads as missing; its
 * session identity was recorded on the link during that teardown.
 */
function nativeSessionReader(
  context: DesignCommandContext,
  options: DesignCommandOptions,
  environmentId: string,
) {
  const read = context.storage.getNativeAgentSession?.bind(context.storage);
  const key = options.nativeSessionKey;
  if (!read || !key)
    throw new DesignError("unsupported", "This backend cannot report linked conversations", {
      retry: "never",
    });
  return async (link: DesignSessionLink, tabId: string) => {
    const agent = linkAgent(link);
    if (!agent) return null;
    const logicalSessionKey = tabSessionKey(environmentId, tabId);
    const session = await read(key(environmentId, agent, logicalSessionKey));
    // The key is a digest of these fields; checking them keeps a record from
    // another environment from ever answering for this one.
    if (
      !session ||
      session.environmentId !== environmentId ||
      session.agent !== agent ||
      session.logicalSessionKey !== logicalSessionKey ||
      !session.providerSessionId
    )
      return null;
    return session.providerSessionId;
  };
}

/**
 * How long the link-state read waits for the agents' archived lists. The
 * dialog gives the whole read eight seconds; past this the archived state is
 * simply not known, and the links read as they did before archive existed.
 */
export const DESIGN_ARCHIVED_READ_DEADLINE_MS = 3_000;

/**
 * Which closed links' conversations their agent lists as archived. Observe
 * only: one list per agent, from a bridge that is already running (never
 * started for this), within {@link DESIGN_ARCHIVED_READ_DEADLINE_MS}.
 */
function archivedReader(
  context: DesignCommandContext,
  environmentId: string,
  deadlineMs: number,
): DesignArchivedSessionLookup | undefined {
  const read = context.nativeAgents?.archivedResumableSessionIdsIfRunning?.bind(
    context.nativeAgents,
  );
  if (!read) return undefined;
  return async (links) => {
    const byAgent = new Map<BuildPipelineAgent, DesignSessionLink[]>();
    for (const link of links) {
      const agent = linkAgent(link);
      if (agent && link.sessionId?.trim())
        byAgent.set(agent, [...(byAgent.get(agent) ?? []), link]);
    }
    const archived = new Set<string>();
    await Promise.all(
      [...byAgent].map(async ([agent, agentLinks]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), deadlineMs);
        });
        const ids = await Promise.race([
          read(
            environmentId,
            agent,
            agentLinks.map((link) => link.sessionId!.trim()),
          ).catch(() => undefined),
          deadline,
        ]).finally(() => clearTimeout(timer));
        for (const link of agentLinks) if (ids?.has(link.sessionId!.trim())) archived.add(link.id);
      }),
    );
    return archived;
  };
}

/**
 * Resume through the ordinary native-agent API: it checks the environment
 * owns the session and that the provider still has it, and it never creates
 * an empty replacement.
 */
function nativeResumer(
  context: DesignCommandContext,
  options: DesignCommandOptions,
  environmentId: string,
): DesignSessionResumer {
  const mapped = nativeSessionReader(context, options, environmentId);
  const nativeAgents = context.nativeAgents;
  if (!nativeAgents)
    throw new DesignError("unsupported", "This backend cannot resume conversations", {
      retry: "never",
    });
  return {
    mapped,
    async resume(link, tabId, resumeOptions) {
      const agent = linkAgent(link);
      if (!agent || !link.sessionId)
        throw new DesignError("invalid-input", "This conversation cannot be resumed", {
          retry: "never",
        });
      const logicalSessionKey = tabSessionKey(environmentId, tabId);
      if (resumeOptions?.restoreArchived) {
        // The agent refuses to continue an archived conversation, so restore
        // it first; a refused restore does not resume.
        if (!nativeAgents.setProjectionResumableSessionArchived)
          throw new DesignError("unsupported", "This backend cannot unarchive conversations", {
            retry: "never",
          });
        try {
          await nativeAgents.setProjectionResumableSessionArchived({
            environmentId,
            agent,
            logicalSessionKey,
            resumableSessionId: link.sessionId,
            archived: false,
          });
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
          throw new DesignError(
            "disconnected",
            `Could not unarchive the conversation: ${message}`,
            { retry: "after-delay" },
          );
        }
      }
      await nativeAgents.resumeProjectionSession({
        environmentId,
        agent,
        logicalSessionKey,
        providerSessionId: link.sessionId,
      });
      const providerSessionId = await mapped(link, tabId);
      if (!providerSessionId) throw new Error("The resumed session was not recorded");
      return providerSessionId;
    },
  };
}

async function authorized(
  args: { readonly environmentId?: unknown },
  context: DesignCommandContext,
) {
  if (!context.design)
    throw new DesignError("unsupported", "Design service unavailable", {
      retry: "after-delay",
    });
  const environmentId = arg(DesignEnvironmentIdSchema, args.environmentId, "environmentId");
  // Typed so v2 envelopes report not-found rather than a generic storage failure.
  if (!(await context.storage.getEnvironment(environmentId)))
    throw new DesignError("not-found", "Environment not found");
  return { design: context.design as DesignService, environmentId };
}

/** The narrow name-based registrar the component harnesses and tests drive. */
export type DesignCommandRegistrar = (
  name: string,
  handler: (args: Record<string, unknown>, context: DesignCommandContext) => Promise<unknown>,
) => void;

/** One design command: its definition and its handler over the decoded arguments. */
export interface DesignCommandEntry<C extends AnyCommandDef = AnyCommandDef> {
  readonly def: C;
  readonly handler: (args: ArgsOf<C>, context: DesignCommandContext) => Promise<ResultOf<C>>;
}

function entry<C extends AnyCommandDef>(
  def: C,
  handler: (args: ArgsOf<C>, context: DesignCommandContext) => Promise<ResultOf<C>>,
): DesignCommandEntry {
  return { def, handler } as unknown as DesignCommandEntry;
}

/** Every design command (`@orkestrator/protocol/contract/domains/design`) with its handler. */
export function designCommandEntries(options: DesignCommandOptions = {}): DesignCommandEntry[] {
  return [
    // Legacy v1 surface: untyped errors, legacy shapes. The UI acts as the user.
    entry(designActionCommand, async (args, context) => {
      const { design, environmentId } = await authorized(args, context);
      return (await runDesignAction(design, environmentId, args.action, args.input, {
        actor: "user",
        resolveDestination: () => resolveDesignDestination(context.storage, environmentId),
      })) as ResultOf<typeof designActionCommand>;
    }),
    entry(designImportCommand, async (args, context) => {
      const { design, environmentId } = await authorized(args, context);
      return design.create(environmentId, "Imported design", args.document, "user");
    }),
    // Imports an .orkdes file chosen in the host path picker, which browses the
    // machine the backend runs on, so the document is read here rather than by
    // the client.
    entry(designImportHostFileCommand, async (args, context) => {
      const { design, environmentId } = await authorized(args, context);
      const filePath = args.path;
      if (!isAbsolute(filePath) || extname(filePath).toLowerCase() !== ".orkdes")
        throw new DesignError("invalid-input", "Choose an .orkdes design file.");
      const document = await readDesignHostFile(filePath);
      return design.create(environmentId, "Imported design", document, "user");
    }),

    // Protocol v2 surface: typed envelopes, capability negotiated.
    entry(designCapabilitiesCommand, async (_args, context) =>
      typed(async () => {
        if (!context.design) throw new Error("Design service unavailable");
        return { ...context.design.capabilities(), intents: true };
      }),
    ),
    entry(designReadinessCommand, async (args, context) =>
      typed(async () => {
        if (!context.design) throw new Error("Design service unavailable");
        return context.design.readiness(optionalArg(Schema.Boolean, args.probe, "probe") ?? false);
      }),
    ),
    entry(designSnapshotCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.snapshot(environmentId, arg(DesignIdSchema, args.canvasId, "canvasId"));
      }),
    ),
    entry(designSyncCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.sync(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          optionalArg(DesignGenerationSchema, args.generation, "generation"),
          arg(DesignRevisionSchema, args.after, "after"),
          optionalArg(DesignStatusVersionSchema, args.statusVersion, "statusVersion"),
        );
      }),
    ),
    entry(designPrepareCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        // The descriptor is validated by the service (`descriptorSchema`).
        return design.prepare(environmentId, "user", args.descriptor);
      }),
    ),
    entry(designExecuteCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.execute(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignTokenSchema, args.token, "token"),
          { waitMs: optionalArg(DesignWaitMsSchema, args.waitMs, "waitMs") },
        );
      }),
    ),
    entry(designOperationStatusCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.status(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignTokenSchema, args.token, "token"),
        );
      }),
    ),
    entry(designCancelCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.cancel(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignTokenSchema, args.token, "token"),
        );
      }),
    ),
    // Backend-owned intent queue: any client lists, runs, resumes or discards.
    // Drafts, intents, client ids and rebase targets are validated by
    // `intents.ts` (the descriptor schema it shares with the design tools).
    entry(designIntentsCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return listIntents(design, environmentId, arg(DesignIdSchema, args.canvasId, "canvasId"));
      }),
    ),
    entry(designIntentSaveCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return saveIntentDrafts(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          args.clientId,
          args.drafts,
        );
      }),
    ),
    entry(designIntentImportCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return importIntents(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          args.clientId,
          args.intents,
        );
      }),
    ),
    entry(designIntentRunCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return runIntent(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          args.intent,
          optionalArg(DesignWaitMsSchema, args.waitMs, "waitMs"),
        );
      }),
    ),
    entry(designIntentResumeCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return resumeIntent(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          args.intentId,
          args.clientId,
          args.rebaseTo,
        );
      }),
    ),
    entry(designIntentDiscardCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return discardIntent(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          args.intentId,
        );
      }),
    ),
    entry(designLibraryCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        // Unknown query keys are dropped (the query was `.strict()` before).
        return design.libraryPage(
          environmentId,
          arg(DesignLibraryQuerySchema, args.query ?? {}, "query"),
        );
      }),
    ),
    entry(designPurgeCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        await purge(design, environmentId, arg(DesignIdSchema, args.canvasId, "canvasId"));
        return { purged: true as const };
      }),
    ),
    entry(designHistoryCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.historyPage(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          optionalArg(DesignOffsetSchema, args.offset, "offset"),
          optionalArg(DesignHistoryLimitSchema, args.limit, "limit"),
        );
      }),
    ),
    entry(designCheckpointCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.checkpoint(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignEntryIdSchema, args.entryId, "entryId"),
          arg(DesignCheckpointSideSchema, args.side, "side"),
        );
      }),
    ),
    entry(designExportPreviewCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        const destination = await resolveDesignDestination(context.storage, environmentId);
        return exportPreview(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          { destination },
          optionalArg(DesignRelativePathSchema, args.relativePath, "relativePath"),
        );
      }),
    ),
    entry(designExportSaveCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        const destination = await resolveDesignDestination(context.storage, environmentId);
        const replace = optionalArg(
          DesignFingerprintSchema,
          args.replaceFingerprint,
          "replaceFingerprint",
        );
        return exportSave(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          { destination },
          {
            relativePath: arg(DesignRelativePathSchema, args.relativePath, "relativePath"),
            revision: arg(DesignRevisionSchema, args.revision, "revision"),
            expected: replace ? { state: "present", digest: replace } : { state: "absent" },
          },
        );
      }),
    ),
    entry(designOpenFileCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        const destination = await resolveDesignDestination(context.storage, environmentId);
        return openDesignFile(
          design,
          environmentId,
          { destination },
          arg(DesignRelativePathSchema, args.relativePath, "relativePath"),
        );
      }),
    ),
    entry(designExportReconcileCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        const destination = await resolveDesignDestination(context.storage, environmentId);
        return reconcileExport(
          design,
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          {
            destination,
          },
        );
      }),
    ),
    entry(designValidateCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return (
          (await validateFrame(
            design,
            environmentId,
            arg(DesignIdSchema, args.canvasId, "canvasId"),
            arg(DesignIdSchema, args.frameId, "frameId"),
          )) ?? null
        );
      }),
    ),
    entry(designHierarchyCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.hierarchy(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignIdSchema, args.frameId, "frameId"),
          {
            ...(args.rootSelector
              ? { rootSelector: arg(DesignRootSelectorSchema, args.rootSelector, "rootSelector") }
              : {}),
            ...(args.cursor ? { cursor: arg(DesignCursorSchema, args.cursor, "cursor") } : {}),
            maxNodes: optionalArg(DesignMaxNodesSchema, args.maxNodes, "maxNodes") ?? 200,
            maxDepth: optionalArg(DesignMaxDepthSchema, args.maxDepth, "maxDepth") ?? 1,
          },
        );
      }),
    ),
    entry(designCaptureCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.capture(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignIdSchema, args.frameId, "frameId"),
          optionalArg(DesignCapturePrioritySchema, args.priority, "priority") ?? "interactive",
        );
      }),
    ),
    entry(designSessionLinkCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        // Unknown link keys are dropped (the link was `.strict()` before).
        const link = arg(DesignSessionLinkInputSchema, args.link, "link");
        return design.linkSession(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          link,
          optionalArg(DesignReplaceLinkIdSchema, args.replaceId, "replaceId"),
        );
      }),
    ),
    entry(designSessionLinkStatesCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        const read = nativeSessionReader(context, options, environmentId);
        return design.sessionLinkStates(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          async (link) => {
            const providerSessionId = await read(link, link.tabId);
            return providerSessionId ? { providerSessionId } : null;
          },
          archivedReader(
            context,
            environmentId,
            options.archivedReadDeadlineMs ?? DESIGN_ARCHIVED_READ_DEADLINE_MS,
          ),
        );
      }),
    ),
    entry(designSessionResumeCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        return design.resumeSessionLink(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          {
            linkId: arg(DesignLinkIdSchema, args.linkId, "linkId"),
            expectedTabId: arg(DesignTabIdSchema, args.expectedTabId, "expectedTabId"),
            tabId: arg(DesignTabIdSchema, args.tabId, "tabId"),
            restoreArchived:
              optionalArg(Schema.Boolean, args.restoreArchived, "restoreArchived") ?? false,
          },
          nativeResumer(context, options, environmentId),
        );
      }),
    ),
    entry(designSessionUnlinkCommand, async (args, context) =>
      typed(async () => {
        const { design, environmentId } = await authorized(args, context);
        await design.unlinkSession(
          environmentId,
          arg(DesignIdSchema, args.canvasId, "canvasId"),
          arg(DesignReplaceLinkIdSchema, args.linkId, "linkId"),
        );
        return { unlinked: true as const };
      }),
    ),
  ];
}

/**
 * Registers the design commands with their definitions (the backend
 * registry, `commands-registry-design.ts`), so the registry decodes their
 * arguments tolerantly and validates their results in development and tests.
 */
export function registerDefinedDesignCommands(
  register: CommandRegistrar,
  options: DesignCommandOptions = {},
): void {
  for (const { def, handler } of designCommandEntries(options)) {
    register(def, handler as unknown as DefinedCommandHandler<AnyCommandDef>);
  }
}

/**
 * Registers the design commands by name on a narrow registrar (the component
 * browser harness, `e2e/design-service-host.ts`, and focused tests). Each
 * handler decodes its arguments and checks its result exactly as the backend
 * registry does (`contractCommandHandler`), so these harnesses see the same
 * contract.
 */
export function registerDesignCommandHandlers(
  register: DesignCommandRegistrar,
  options: DesignCommandOptions = {},
): void {
  const validateResults = contractResultValidationDefault();
  for (const { def, handler } of designCommandEntries(options)) {
    const run = contractCommandHandler(
      def,
      handler as unknown as DefinedCommandHandler<AnyCommandDef>,
      { validateResults },
    );
    register(def.name, async (args, context) => run(args, context as unknown as CommandContext));
  }
}
