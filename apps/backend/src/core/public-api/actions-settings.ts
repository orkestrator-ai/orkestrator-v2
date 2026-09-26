import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  type AgentPlatformSettings,
  type AgentSettingsTier,
} from "@orkestrator/protocol/agent-settings";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  publicSettingDescriptor,
  PUBLIC_ENVIRONMENT_SETTINGS,
  PUBLIC_PROJECT_SETTINGS,
  type PublicSettingDescriptor,
  type PublicSettingScope,
  type PublicSettingsChange,
  type PublicSettingsSnapshot,
  type PublicSettingValue,
} from "@orkestrator/protocol/public-api-resources";
import { syncDiffStatsTracking } from "../commands-runtime-state.js";
import type { AppConfig, Environment, PortMapping, RepositoryConfig } from "../models.js";
import { defaultRepositoryConfig, isPortMapping } from "../storage-shared.js";
import { requireEnvironment, requireProject } from "./actions-discovery.js";
import { PublicActionError } from "./errors.js";
import { invalid, onlyKeys, optionalString, requiredId } from "./input.js";
import { environmentSettingsRevision, repositorySettingsRevision } from "./revisions.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Typed, partial settings edits. The CLI never assembles a configuration
 * document: it sends `{set, unset}` and the backend applies it atomically
 * under the owning store's lock and a content revision. Launch intent on an
 * environment (initial prompt, attachments, pending launch selection) is not
 * a setting and is never touched here.
 */

const PLATFORM_FIELDS = ["mode", "model", "reasoningEffort", "fastMode"] as const;
type PlatformField = (typeof PLATFORM_FIELDS)[number];

function parsePlatformKey(key: string): { agent: AgentPlatform; field: PlatformField } | null {
  const match = /^agent\.([a-z]+)\.(mode|model|reasoningEffort|fastMode)$/.exec(key);
  if (!match || !isAgentPlatform(match[1])) return null;
  return { agent: match[1], field: match[2] as PlatformField };
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}(?<![./])$/;
const DOMAIN =
  /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function validateValue(descriptor: PublicSettingDescriptor, value: unknown): unknown {
  const fail = (message: string) => invalid(`${descriptor.key}: ${message}`);
  switch (descriptor.type) {
    case "string":
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 500) {
        throw fail("expected a non-empty string");
      }
      if (
        (descriptor.key === "defaultBranch" || descriptor.key === "prBaseBranch") &&
        !BRANCH.test(value)
      ) {
        throw fail("is not a valid branch name");
      }
      return value.trim();
    case "port":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
        throw fail("expected a port from 1 to 65535");
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw fail("expected true or false");
      return value;
    case "agent":
      if (!isAgentPlatform(value)) throw fail("expected an agent platform");
      return value;
    case "agent-mode":
      if (value !== "native" && value !== "terminal") throw fail("expected native or terminal");
      return value;
    case "string-list": {
      if (
        !Array.isArray(value) ||
        value.length > 256 ||
        !value.every((entry) => typeof entry === "string")
      ) {
        throw fail("expected an array of strings");
      }
      for (const entry of value as string[]) {
        if (
          !entry ||
          entry.startsWith("/") ||
          entry.split(/[\\/]/).includes("..") ||
          entry.length > 1024
        ) {
          throw fail("paths must be relative and stay inside the repository");
        }
      }
      return value;
    }
    case "domain-list": {
      if (
        !Array.isArray(value) ||
        value.length > 512 ||
        !value.every((entry) => typeof entry === "string" && DOMAIN.test(entry))
      ) {
        throw fail("expected an array of domain names");
      }
      return [...new Set(value as string[])];
    }
    case "port-mappings": {
      if (!Array.isArray(value) || value.length > 64 || !value.every(isPortMapping)) {
        throw fail('expected an array of {"containerPort", "hostPort", "protocol"} mappings');
      }
      return value;
    }
  }
}

interface SettingsPatch {
  set: Record<string, unknown>;
  unset: string[];
  expectedRevision?: string;
}

function parsePatch(scope: PublicSettingScope, input: Record<string, unknown>): SettingsPatch {
  const rawSet = input.set ?? {};
  const rawUnset = input.unset ?? [];
  if (!rawSet || typeof rawSet !== "object" || Array.isArray(rawSet))
    throw invalid("set must be an object");
  if (!Array.isArray(rawUnset) || !rawUnset.every((key) => typeof key === "string")) {
    throw invalid("unset must be an array of keys");
  }
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSet as Record<string, unknown>)) {
    const descriptor = publicSettingDescriptor(scope, key);
    if (!descriptor) throw invalid(`Unknown ${scope} setting: ${key.slice(0, 80)}`);
    if (value === null) throw invalid(`${key}: use unset to remove a value, not null`);
    set[key] = validateValue(descriptor, value);
  }
  const unset = [...new Set(rawUnset as string[])];
  for (const key of unset) {
    if (!publicSettingDescriptor(scope, key))
      throw invalid(`Unknown ${scope} setting: ${key.slice(0, 80)}`);
    if (Object.hasOwn(set, key)) throw invalid(`${key} is both set and unset`);
  }
  const count = Object.keys(set).length + unset.length;
  if (count === 0) throw invalid("Nothing to change");
  if (count > PUBLIC_API_LIMITS.patchMaxFields)
    throw new PublicActionError("input-too-large", "Too many settings");
  const expectedRevision = optionalString(input, "expectedRevision", 64);
  return { set, unset, ...(expectedRevision ? { expectedRevision } : {}) };
}

function applyAgentKey(
  tier: AgentSettingsTier | undefined,
  key: string,
  value: unknown,
): AgentSettingsTier {
  const next: AgentSettingsTier = structuredClone(tier ?? {});
  if (key === "agent.defaultAgent") {
    if (value === undefined) delete next.defaultAgent;
    else next.defaultAgent = value as AgentPlatform;
    return next;
  }
  const parsed = parsePlatformKey(key)!;
  const platforms = { ...next.platforms };
  const platform: AgentPlatformSettings = { ...platforms[parsed.agent] };
  if (value === undefined) delete platform[parsed.field];
  else (platform as Record<string, unknown>)[parsed.field] = value;
  if (Object.keys(platform).length === 0) delete platforms[parsed.agent];
  else platforms[parsed.agent] = platform;
  if (Object.keys(platforms).length === 0) delete next.platforms;
  else next.platforms = platforms;
  return next;
}

function agentValue(tier: AgentSettingsTier | undefined | null, key: string): unknown {
  if (key === "agent.defaultAgent") return tier?.defaultAgent ?? null;
  const parsed = parsePlatformKey(key)!;
  return tier?.platforms?.[parsed.agent]?.[parsed.field] ?? null;
}

function agentEffective(
  tiers: {
    environment?: AgentSettingsTier | null;
    repository?: AgentSettingsTier | null;
    global?: AgentSettingsTier | null;
  },
  key: string,
): { effective: unknown; source: PublicSettingValue["source"] } {
  const order: Array<
    ["environment" | "repository" | "global", AgentSettingsTier | null | undefined]
  > = [
    ["environment", tiers.environment],
    ["repository", tiers.repository],
    ["global", tiers.global],
  ];
  if (key === "agent.defaultAgent") {
    const source = order.find(([, tier]) => tier?.defaultAgent !== undefined)?.[0] ?? "default";
    return { effective: resolveDefaultAgent(tiers), source };
  }
  const parsed = parsePlatformKey(key)!;
  const resolved = resolveAgentPlatformSettings(tiers, parsed.agent);
  const source =
    order.find(([, tier]) => tier?.platforms?.[parsed.agent]?.[parsed.field] !== undefined)?.[0] ??
    "default";
  return { effective: resolved[parsed.field] ?? null, source };
}

// ---------------------------------------------------------------------------
// Project scope

const REPOSITORY_FIELDS = [
  "defaultBranch",
  "prBaseBranch",
  "defaultPortMappings",
  "filesToCopy",
  "entryPort",
] as const;

function projectSnapshot(projectId: string, config: AppConfig): PublicSettingsSnapshot {
  const stored = config.repositories?.[projectId];
  const defaults = defaultRepositoryConfig();
  const settings = PUBLIC_PROJECT_SETTINGS.map((descriptor): PublicSettingValue => {
    if (descriptor.key.startsWith("agent.")) {
      const { effective, source } = agentEffective(
        { repository: stored?.agentSettings, global: config.global.agentSettings },
        descriptor.key,
      );
      return {
        key: descriptor.key,
        value: agentValue(stored?.agentSettings, descriptor.key),
        effective,
        source: source === "environment" ? "repository" : source,
        application: descriptor.application,
      };
    }
    const field = descriptor.key as (typeof REPOSITORY_FIELDS)[number];
    const value = stored?.[field];
    const fallback = (defaults as unknown as Record<string, unknown>)[field];
    return {
      key: descriptor.key,
      value: value ?? null,
      effective: value ?? fallback ?? null,
      source: value !== undefined ? "repository" : fallback !== undefined ? "default" : "unset",
      application: descriptor.application,
    };
  });
  return {
    scope: "project",
    targetId: projectId,
    revision: repositorySettingsRevision(stored),
    settings,
  };
}

const projectConfigGet: ReadActionHandler<{ projectId: string }> = {
  kind: "read",
  action: "project.config.get",
  parse(input) {
    onlyKeys(input, ["projectId"]);
    return { projectId: requiredId(input, "projectId") };
  },
  async run(input, context) {
    await requireProject(context, input.projectId);
    return { result: projectSnapshot(input.projectId, await context.command.storage.loadConfig()) };
  },
};

function changes(scope: PublicSettingScope, patch: SettingsPatch): PublicSettingsChange[] {
  return [
    ...Object.keys(patch.set).map((key) => ({
      key,
      change: "set" as const,
      application: publicSettingDescriptor(scope, key)!.application,
    })),
    ...patch.unset.map((key) => ({
      key,
      change: "unset" as const,
      application: publicSettingDescriptor(scope, key)!.application,
    })),
  ];
}

const projectConfigSet: MutationActionHandler<SettingsPatch & { projectId: string }> = {
  kind: "mutation",
  action: "project.config.set",
  parse(input) {
    onlyKeys(input, ["projectId", "set", "unset", "expectedRevision"]);
    const projectId = requiredId(input, "projectId");
    const patch = parsePatch("project", input);
    return {
      value: { projectId, ...patch },
      scope: `project:${projectId}`,
      intent: {
        set: patch.set,
        unset: [...patch.unset].sort(),
        expectedRevision: patch.expectedRevision ?? null,
      },
    };
  },
  async prepare(input, context) {
    await requireProject(context, input.projectId);
    return {
      resources: { projectId: input.projectId },
      async execute() {
        const storage = context.command.storage;
        await storage.patchRepositorySettingsAtRevision(
          input.projectId,
          input.expectedRevision,
          (current) => {
            const next: RepositoryConfig = { ...current };
            let tier = current.agentSettings;
            for (const [key, value] of [
              ...Object.entries(input.set),
              ...input.unset.map((key) => [key, undefined] as const),
            ]) {
              if (key.startsWith("agent.")) {
                tier = applyAgentKey(tier, key, value);
                continue;
              }
              const field = key as (typeof REPOSITORY_FIELDS)[number];
              if (value === undefined) {
                const fallback = (defaultRepositoryConfig() as unknown as Record<string, unknown>)[
                  field
                ];
                if (fallback !== undefined)
                  (next as unknown as Record<string, unknown>)[field] = fallback;
                else delete (next as unknown as Record<string, unknown>)[field];
              } else {
                (next as unknown as Record<string, unknown>)[field] = value;
              }
            }
            if (tier && Object.keys(tier).length > 0) next.agentSettings = tier;
            else delete next.agentSettings;
            return next;
          },
        );
        if ("prBaseBranch" in input.set || input.unset.includes("prBaseBranch")) {
          // The PR base retargets every environment's diff baseline now, as
          // the settings UI does.
          void syncDiffStatsTracking(context.command).catch(() => undefined);
        }
        return {
          state: "succeeded",
          result: {
            settings: projectSnapshot(input.projectId, await storage.loadConfig()),
            changes: changes("project", input),
          },
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Environment scope

async function environmentSnapshot(
  environment: Environment,
  context: PublicActionContext,
): Promise<PublicSettingsSnapshot> {
  const config = await context.command.storage.loadConfig();
  const repository = config.repositories?.[environment.projectId];
  const settings = PUBLIC_ENVIRONMENT_SETTINGS.map((descriptor): PublicSettingValue => {
    if (descriptor.key.startsWith("agent.")) {
      const { effective, source } = agentEffective(
        {
          environment: environment.agentSettings,
          repository: repository?.agentSettings,
          global: config.global.agentSettings,
        },
        descriptor.key,
      );
      return {
        key: descriptor.key,
        value: agentValue(environment.agentSettings, descriptor.key),
        effective,
        source,
        application: descriptor.application,
      };
    }
    if (descriptor.key === "allowedDomains") {
      const global = (config.global as { allowedDomains?: string[] }).allowedDomains;
      return {
        key: descriptor.key,
        value: environment.allowedDomains ?? null,
        effective: environment.allowedDomains ?? global ?? null,
        source: environment.allowedDomains ? "environment" : global ? "global" : "unset",
        application: descriptor.application,
      };
    }
    return {
      key: descriptor.key,
      value: environment.portMappings ?? null,
      effective: environment.portMappings ?? [],
      source: environment.portMappings ? "environment" : "default",
      application: descriptor.application,
    };
  });
  return {
    scope: "environment",
    targetId: environment.id,
    revision: environmentSettingsRevision(environment),
    settings,
  };
}

const environmentConfigGet: ReadActionHandler<{ environmentId: string }> = {
  kind: "read",
  action: "environment.config.get",
  parse(input) {
    onlyKeys(input, ["environmentId"]);
    return { environmentId: requiredId(input, "environmentId") };
  },
  async run(input, context) {
    return {
      result: await environmentSnapshot(
        await requireEnvironment(context, input.environmentId),
        context,
      ),
    };
  },
};

const environmentConfigSet: MutationActionHandler<SettingsPatch & { environmentId: string }> = {
  kind: "mutation",
  action: "environment.config.set",
  parse(input) {
    onlyKeys(input, ["environmentId", "set", "unset", "expectedRevision"]);
    const environmentId = requiredId(input, "environmentId");
    const patch = parsePatch("environment", input);
    return {
      value: { environmentId, ...patch },
      scope: `environment:${environmentId}`,
      intent: {
        set: patch.set,
        unset: [...patch.unset].sort(),
        expectedRevision: patch.expectedRevision ?? null,
      },
    };
  },
  async prepare(input, context) {
    const environment = await requireEnvironment(context, input.environmentId);
    const containerOnly = [...Object.keys(input.set), ...input.unset].filter(
      (key) =>
        publicSettingDescriptor("environment", key)?.environmentTypes?.includes("container") &&
        !publicSettingDescriptor("environment", key)?.environmentTypes?.includes("local"),
    );
    if (containerOnly.length > 0 && environment.environmentType === "local") {
      throw new PublicActionError(
        "unsupported",
        `${containerOnly.join(", ")} only apply to container environments`,
      );
    }
    return {
      resources: { environmentId: environment.id, projectId: environment.projectId },
      async execute() {
        const updated = await context.command.storage.patchEnvironmentSettingsAtRevision(
          input.environmentId,
          input.expectedRevision,
          (current, stored) => {
            // Container creation reads ports and domains; refuse to race it.
            if (
              containerOnly.length > 0 &&
              (stored.status === "creating" || stored.status === "stopping")
            ) {
              throw new PublicActionError(
                "conflict",
                "The environment is changing state; retry once it has settled",
              );
            }
            const next = { ...current };
            for (const [key, value] of [
              ...Object.entries(input.set),
              ...input.unset.map((key) => [key, undefined] as const),
            ]) {
              if (key.startsWith("agent."))
                next.agentSettings = applyAgentKey(next.agentSettings, key, value);
              else if (key === "portMappings")
                next.portMappings = value as PortMapping[] | undefined;
              else if (key === "allowedDomains")
                next.allowedDomains = value as string[] | undefined;
            }
            return next;
          },
        );
        return {
          state: "succeeded",
          result: {
            settings: await environmentSnapshot(updated, context),
            changes: changes("environment", input).map((change) =>
              change.key === "portMappings" || change.key === "allowedDomains"
                ? {
                    ...change,
                    application:
                      updated.status === "running" ? ("next-start" as const) : change.application,
                  }
                : change,
            ),
          },
        };
      },
    };
  },
};

export const SETTINGS_HANDLERS: PublicActionHandler[] = [
  projectConfigGet,
  projectConfigSet,
  environmentConfigGet,
  environmentConfigSet,
];
