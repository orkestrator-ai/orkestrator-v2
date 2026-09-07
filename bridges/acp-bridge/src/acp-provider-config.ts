import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";

export interface AcpProviderConfig {
  id: string;
  name: string;
  executable: string;
  /** Argument template. `{{model}}` and `{{effort}}` expand to provider flags. */
  argv: string[];
  env: Record<string, string>;
  requiresAuthenticate: boolean;
  authMethodEnv?: string;
  modeMap: Record<string, AgentConversationMode>;
  extensionPrefixes: string[];
  acknowledgedExtensionMethods: string[];
  modelUpdateMethods: string[];
  sessionUpdateMethods: string[];
}

const GROK_PROVIDER: AcpProviderConfig = {
  id: "grok",
  name: "Grok",
  executable: "grok",
  argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
  env: {},
  requiresAuthenticate: true,
  authMethodEnv: "GROK_AUTH_METHOD_ID",
  modeMap: {
    agent: "build",
    code: "build",
    build: "build",
    agentic: "build",
    plan: "plan",
    architect: "plan",
    ask: "plan",
  },
  extensionPrefixes: ["x.ai/", "_x.ai/"],
  acknowledgedExtensionMethods: [],
  modelUpdateMethods: ["x.ai/models/update", "_x.ai/models/update"],
  sessionUpdateMethods: ["x.ai/session/update", "_x.ai/session/update"],
};

export function loadAcpProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AcpProviderConfig {
  const serialized = environment.ACP_PROVIDER_CONFIG?.trim();
  if (serialized) return parseProviderConfig(serialized);

  const id = environment.ACP_PROVIDER?.trim();
  if (id && id !== "grok") {
    throw new Error(
      "ACP_PROVIDER_CONFIG is required for ACP providers other than grok (ACP_PROVIDER=grok is built in)",
    );
  }
  return {
    ...GROK_PROVIDER,
    executable: environment.ACP_AGENT_PATH?.trim() || GROK_PROVIDER.executable,
  };
}

export function providerArgv(
  config: AcpProviderConfig,
  options: { model?: string; effort?: string; approvals?: "ask" | "auto-approve" | "deny" },
): string[] {
  return config.argv.flatMap((argument) => {
    if (
      argument === "--always-approve" &&
      options.approvals &&
      options.approvals !== "auto-approve"
    ) {
      return [];
    }
    if (argument === "{{model}}") return options.model ? ["--model", options.model] : [];
    if (argument === "{{effort}}") {
      return options.effort ? ["--reasoning-effort", options.effort] : [];
    }
    return [argument];
  });
}

function parseProviderConfig(serialized: string): AcpProviderConfig {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("ACP_PROVIDER_CONFIG must be valid JSON");
  }
  if (!isRecord(value)) throw new Error("ACP_PROVIDER_CONFIG must be a JSON object");
  const id = requiredString(value.id, "id");
  const executable = requiredString(value.executable, "executable");
  const argv = stringArray(value.argv, "argv", 128);
  const modeMap: Record<string, AgentConversationMode> = isRecord(value.modeMap)
    ? (Object.fromEntries(
        Object.entries(value.modeMap).flatMap(([agentMode, normalized]) =>
          normalized === "build" || normalized === "plan" ? [[agentMode, normalized]] : [],
        ),
      ) as Record<string, AgentConversationMode>)
    : {};
  const env = isRecord(value.env)
    ? Object.fromEntries(
        Object.entries(value.env).flatMap(([key, entry]) =>
          typeof entry === "string" ? [[key, entry]] : [],
        ),
      )
    : {};
  return {
    id,
    name: optionalString(value.name) ?? id,
    executable,
    argv,
    env,
    requiresAuthenticate: value.requiresAuthenticate === true,
    ...(optionalString(value.authMethodEnv)
      ? { authMethodEnv: optionalString(value.authMethodEnv) }
      : {}),
    modeMap,
    extensionPrefixes: stringArray(value.extensionPrefixes, "extensionPrefixes", 64, true),
    acknowledgedExtensionMethods: stringArray(
      value.acknowledgedExtensionMethods,
      "acknowledgedExtensionMethods",
      64,
      true,
    ),
    modelUpdateMethods: stringArray(value.modelUpdateMethods, "modelUpdateMethods", 64, true),
    sessionUpdateMethods: stringArray(value.sessionUpdateMethods, "sessionUpdateMethods", 64, true),
  };
}

function stringArray(value: unknown, field: string, maximum: number, optional = false): string[] {
  if (value === undefined && optional) return [];
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => !optionalString(entry))
  ) {
    throw new Error(`ACP_PROVIDER_CONFIG.${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`ACP_PROVIDER_CONFIG.${field} must be a non-empty string`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && Buffer.byteLength(trimmed) <= 4_096 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
