import { createHash } from "node:crypto";
import {
  AGENT_PLATFORMS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
} from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  PUBLIC_ACTIONS,
  PUBLIC_API_LIMITS,
  PUBLIC_API_SCHEMA_VERSION,
  PUBLIC_OPERATION_RETENTION,
  type PublicActionName,
  type PublicCapabilities,
} from "@orkestrator/protocol/public-api";
import {
  decodePublicPageCursor,
  encodePublicPageCursor,
  type PublicAgentOption,
  type PublicAgentOptions,
  type PublicCatalogueState,
  type PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import { cachedLaunchModels } from "../control-shared-actions.js";
import type { Environment, Project } from "../models.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  onlyKeys,
  optionalBoolean,
  optionalInteger,
  optionalString,
  oneOf,
  requiredId,
  sessionTarget,
} from "./input.js";
import { allProviderCapabilities, PROVIDER_COMPLETION, providerCapabilities } from "./providers.js";
import { loadSessionSummary, listSessionSummaries } from "./sessions.js";
import { publicEnvironmentSummary, publicProjectSummary } from "./summaries.js";
import type { PublicActionContext, PublicActionHandler, ReadActionHandler } from "./types.js";

const BACKEND_STARTED_AT = new Date().toISOString();
const CATALOGUE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function collectionFingerprint(ids: string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
}

function paginate<T extends { id: string }>(
  items: T[],
  input: { limit?: number; cursor?: string },
): PublicPage<T> {
  const limit = input.limit ?? PUBLIC_API_LIMITS.pageDefaultItems;
  const fingerprint = collectionFingerprint(items.map((item) => item.id));
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodePublicPageCursor(input.cursor, fingerprint);
    if (decoded === "invalid") throw invalid("cursor is not valid");
    if (decoded === "expired") {
      throw new PublicActionError(
        "cursor-expired",
        "The collection changed since this cursor was issued; list again from the first page",
      );
    }
    offset = decoded.offset;
  }
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    items: page,
    total: items.length,
    ...(next < items.length ? { nextCursor: encodePublicPageCursor(next, fingerprint) } : {}),
  };
}

function pageInput(input: Record<string, unknown>) {
  return {
    limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems),
    cursor: optionalString(input, "cursor", 512),
  };
}

async function environmentCounts(context: PublicActionContext): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const environment of await context.command.storage.loadEnvironments()) {
    counts.set(environment.projectId, (counts.get(environment.projectId) ?? 0) + 1);
  }
  return counts;
}

export async function requireProject(
  context: PublicActionContext,
  projectId: string,
): Promise<Project> {
  const project = await context.command.storage.getProject(projectId);
  if (!project) throw new PublicActionError("not-found", `Project not found: ${projectId}`);
  return project;
}

export async function requireEnvironment(
  context: PublicActionContext,
  environmentId: string,
): Promise<Environment> {
  const environment = await context.command.storage.getEnvironment(environmentId);
  if (!environment) {
    throw new PublicActionError("not-found", `Environment not found: ${environmentId}`);
  }
  return environment;
}

export function createCapabilitiesHandler(
  availableActions: () => ReadonlySet<PublicActionName>,
  features: () => PublicCapabilities["features"],
): ReadActionHandler<Record<string, never>> {
  return {
    kind: "read",
    action: "capabilities",
    parse(input) {
      onlyKeys(input, []);
      return {};
    },
    async run(_input, context) {
      const namespaces = await context.command.storage.publicOperationNamespaces(context.now());
      const available = availableActions();
      const actions: PublicCapabilities["actions"] = {};
      for (const name of Object.keys(PUBLIC_ACTIONS) as PublicActionName[]) {
        actions[name] = available.has(name)
          ? { version: PUBLIC_ACTIONS[name].version, available: true }
          : {
              version: PUBLIC_ACTIONS[name].version,
              available: false,
              reason: "not supported by this backend",
            };
      }
      const result: PublicCapabilities = {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        backend: {
          installationId: context.installationId,
          generation: context.generation,
          version: process.env.ORKESTRATOR_VERSION ?? "development",
          startedAt: BACKEND_STARTED_AT,
        },
        actions,
        limits: PUBLIC_API_LIMITS,
        requestKeys: {
          currentNamespace: namespaces.current,
          admissionWindowMs: PUBLIC_OPERATION_RETENTION.admissionWindowMs,
          retentionMs: PUBLIC_OPERATION_RETENTION.retentionMs,
          retainedNamespaces: namespaces.retained,
        },
        providers: allProviderCapabilities(),
        features: features(),
      };
      return { result };
    },
  };
}

const projectList: ReadActionHandler<ReturnType<typeof pageInput>> = {
  kind: "read",
  action: "project.list",
  parse(input) {
    onlyKeys(input, ["limit", "cursor"]);
    return pageInput(input);
  },
  async run(input, context) {
    const [projects, counts] = await Promise.all([
      context.command.storage.loadProjects(),
      environmentCounts(context),
    ]);
    const summaries = projects.map((project) =>
      publicProjectSummary(project, counts.get(project.id) ?? 0),
    );
    return { result: paginate(summaries, input) };
  },
};

const projectGet: ReadActionHandler<{ projectId?: string; name?: string }> = {
  kind: "read",
  action: "project.get",
  parse(input) {
    onlyKeys(input, ["projectId", "name"]);
    const projectId = input.projectId === undefined ? undefined : requiredId(input, "projectId");
    const name = optionalString(input, "name", PUBLIC_API_LIMITS.nameMaxChars);
    if ((projectId ? 1 : 0) + (name ? 1 : 0) !== 1) throw invalid("Pass projectId or name");
    return { projectId, name };
  },
  async run(input, context) {
    const projects = await context.command.storage.loadProjects();
    const matches = input.projectId
      ? projects.filter((project) => project.id === input.projectId)
      : projects.filter((project) => project.name === input.name);
    if (matches.length === 0) throw new PublicActionError("not-found", "Project not found");
    if (matches.length > 1) {
      throw new PublicActionError(
        "ambiguous-target",
        "More than one project has that name; use its ID",
        {
          details: { candidates: matches.map((project) => project.id).slice(0, 20) },
        },
      );
    }
    const counts = await environmentCounts(context);
    return { result: publicProjectSummary(matches[0]!, counts.get(matches[0]!.id) ?? 0) };
  },
};

const ENVIRONMENT_STATUSES = ["running", "stopped", "error", "creating", "stopping"] as const;

const environmentList: ReadActionHandler<{
  projectId?: string;
  status?: (typeof ENVIRONMENT_STATUSES)[number];
  limit?: number;
  cursor?: string;
}> = {
  kind: "read",
  action: "environment.list",
  parse(input) {
    onlyKeys(input, ["projectId", "status", "limit", "cursor"]);
    return {
      ...(input.projectId !== undefined ? { projectId: requiredId(input, "projectId") } : {}),
      status: oneOf(input, "status", ENVIRONMENT_STATUSES),
      ...pageInput(input),
    };
  },
  async run(input, context) {
    // The authoritative snapshot: no Docker reconciliation, no transcript or
    // provider reads. Freshness is whatever the backend last recorded.
    if (input.projectId) await requireProject(context, input.projectId);
    const environments = (await context.command.storage.loadEnvironments())
      .filter((environment) => !input.projectId || environment.projectId === input.projectId)
      .filter((environment) => !input.status || environment.status === input.status)
      .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.order - b.order);
    return { result: paginate(environments.map(publicEnvironmentSummary), input) };
  },
};

const environmentGet: ReadActionHandler<{
  environmentId?: string;
  projectId?: string;
  name?: string;
}> = {
  kind: "read",
  action: "environment.get",
  parse(input) {
    onlyKeys(input, ["environmentId", "projectId", "name"]);
    if (input.environmentId !== undefined) {
      if (input.projectId !== undefined || input.name !== undefined) {
        throw invalid("Pass environmentId, or projectId with name");
      }
      return { environmentId: requiredId(input, "environmentId") };
    }
    return {
      projectId: requiredId(input, "projectId"),
      name:
        optionalString(input, "name", PUBLIC_API_LIMITS.nameMaxChars) ??
        (() => {
          throw invalid("name is required with projectId");
        })(),
    };
  },
  async run(input, context) {
    if (input.environmentId) {
      return {
        result: publicEnvironmentSummary(await requireEnvironment(context, input.environmentId)),
      };
    }
    const matches = (
      await context.command.storage.getEnvironmentsByProject(input.projectId!)
    ).filter((environment) => environment.name === input.name);
    if (matches.length === 0) throw new PublicActionError("not-found", "Environment not found");
    if (matches.length > 1) {
      throw new PublicActionError("ambiguous-target", "More than one environment has that name", {
        details: { candidates: matches.map((environment) => environment.id).slice(0, 20) },
      });
    }
    return { result: publicEnvironmentSummary(matches[0]!) };
  },
};

const sessionList: ReadActionHandler<{ environmentId: string }> = {
  kind: "read",
  action: "session.list",
  parse(input) {
    onlyKeys(input, ["environmentId"]);
    return { environmentId: requiredId(input, "environmentId") };
  },
  async run(input, context) {
    await requireEnvironment(context, input.environmentId);
    const items = await listSessionSummaries(context, input.environmentId);
    return { result: { items, total: items.length } };
  },
};

const sessionGet: ReadActionHandler<ReturnType<typeof sessionTarget>> = {
  kind: "read",
  action: "session.get",
  parse(input) {
    onlyKeys(input, ["sessionId"]);
    return sessionTarget(input);
  },
  async run(input, context) {
    return { result: await loadSessionSummary(context, input) };
  },
};

function catalogueState(
  models: AgentModel[],
  entry: { updatedAt?: string } | null | undefined,
  now: number,
): PublicCatalogueState {
  if (!entry) return models.length > 0 ? "ready" : "unavailable";
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt) && now - updatedAt > CATALOGUE_STALE_MS) return "stale";
  return models.length > 0 ? "ready" : "empty";
}

const agentOptions: ReadActionHandler<{
  environmentId?: string;
  projectId?: string;
  refresh: boolean;
}> = {
  kind: "read",
  action: "agent.options",
  parse(input) {
    onlyKeys(input, ["environmentId", "projectId", "refresh"]);
    const environmentId =
      input.environmentId !== undefined ? requiredId(input, "environmentId") : undefined;
    const projectId = input.projectId !== undefined ? requiredId(input, "projectId") : undefined;
    if ((environmentId ? 1 : 0) + (projectId ? 1 : 0) !== 1)
      throw invalid("Pass environmentId or projectId");
    return { environmentId, projectId, refresh: optionalBoolean(input, "refresh") === true };
  },
  async run(input, context) {
    const storage = context.command.storage;
    const environment = input.environmentId
      ? await requireEnvironment(context, input.environmentId)
      : null;
    const projectId = environment?.projectId ?? input.projectId!;
    await requireProject(context, projectId);
    const config = await storage.loadConfig();
    const enabled = normalizeAgentPlatforms(config.global.enabledAgentPlatforms);
    const errors = new Map<AgentPlatform, string>();
    if (input.refresh) {
      // Explicit, bounded provider reads: one host catalogue refresh per
      // enabled agent, sequentially. A failure is recorded against that agent
      // (and its last-known catalogue is still shown), never substituted.
      for (const agent of enabled) {
        await context
          .invoke("refresh_host_agent_model_catalog", {
            agent,
            ...(agent === "opencode" ? { projectId } : {}),
          })
          .catch((error: unknown) => {
            errors.set(
              agent,
              error instanceof Error ? error.message.slice(0, 200) : "refresh failed",
            );
          });
      }
    }
    const cache = await storage.getAgentModelCatalogCache();
    const openCode = await storage.getOpenCodeModelCatalog(projectId);
    let models: AgentModel[] = [];
    let source: "live" | "cache" = "cache";
    if (environment) {
      // The environment catalogue reads bounded local bridge state and the
      // durable caches; `refresh` additionally lets first-use platforms
      // (Cursor, Grok, Pi) start their bridge within the command's budget.
      const ensure = input.refresh
        ? (["cursor", "grok", "pi"] as const).filter(
            (agent) => enabled.includes(agent) && !cache[agent]?.models.length,
          )
        : [];
      try {
        const raw = await context.invoke<unknown>("get_native_agent_model_catalog", {
          environmentId: environment.id,
        });
        if (Array.isArray(raw)) models = raw as AgentModel[];
        for (const agent of ensure) {
          const seeded = await context
            .invoke<unknown>("get_native_agent_model_catalog", {
              environmentId: environment.id,
              ensureAgent: agent,
            })
            .catch((error: unknown) => {
              errors.set(
                agent,
                error instanceof Error ? error.message.slice(0, 200) : "refresh failed",
              );
              return null;
            });
          const seededModels =
            seeded &&
            typeof seeded === "object" &&
            "models" in seeded &&
            Array.isArray(seeded.models)
              ? (seeded.models as AgentModel[])
              : [];
          models = [
            ...models.filter((model) => model.platform !== agent),
            ...seededModels.filter((model) => model.platform === agent),
          ];
        }
        source = environment.status === "running" ? "live" : "cache";
      } catch (error) {
        for (const agent of AGENT_PLATFORMS) {
          errors.set(
            agent,
            error instanceof Error ? error.message.slice(0, 200) : "catalogue read failed",
          );
        }
      }
    } else {
      models = await cachedLaunchModels(context.invoke, projectId);
    }
    const tiers = {
      environment: environment?.agentSettings,
      repository: config.repositories?.[projectId]?.agentSettings,
      global: config.global.agentSettings,
    };
    const now = context.now();
    const agents: PublicAgentOption[] = AGENT_PLATFORMS.map((agent) => {
      const agentModels = models.filter((model) => model.platform === agent);
      const entry =
        agent === "opencode"
          ? openCode
          : agent === "claude" && environment?.claudeModelCatalog
            ? environment.claudeModelCatalog
            : cache[agent as keyof typeof cache & AgentPlatform];
      const defaults = resolveAgentPlatformSettings(tiers, agent);
      const capabilities = providerCapabilities(agent);
      const error = errors.get(agent);
      return {
        agent,
        enabled: enabled.includes(agent),
        completion: PROVIDER_COMPLETION[agent].support,
        controls: capabilities.controls,
        steer: capabilities.steer,
        resume: capabilities.resume,
        fork: capabilities.fork,
        catalogue: {
          // A failed read keeps showing the last-known list, marked stale;
          // with nothing known it is unavailable (never an empty success).
          state: error
            ? agentModels.length > 0
              ? "stale"
              : "unavailable"
            : catalogueState(agentModels, entry as { updatedAt?: string } | null | undefined, now),
          source: agentModels.length > 0 || entry ? source : "none",
          ...(error ? { error } : {}),
          models: agentModels.slice(0, 500).map((model) => ({
            id: model.id,
            label: model.label,
            reasoning: (model.reasoning ?? []).map((option) => option.id),
            defaultReasoningId: model.defaultReasoningId ?? null,
            supportsSpeed: model.supportsSpeed === true,
            supportsMode: model.supportsMode === true,
          })),
        },
        defaults: {
          model: defaults.model ?? null,
          reasoningEffort: defaults.reasoningEffort ?? null,
          fastMode: defaults.fastMode ?? null,
        },
      };
    });
    const result: PublicAgentOptions = {
      projectId,
      environmentId: environment?.id ?? null,
      defaultAgent: resolveDefaultAgent(tiers),
      agents,
    };
    return { result };
  },
};

export const DISCOVERY_HANDLERS: PublicActionHandler[] = [
  projectList,
  projectGet,
  environmentList,
  environmentGet,
  sessionList,
  sessionGet,
  agentOptions,
];
