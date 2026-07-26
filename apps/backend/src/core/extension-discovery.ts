export type AgentExtensionId = "claude" | "codex" | "opencode";

export type ExtensionStatus =
  | "connected"
  | "configured"
  | "disabled"
  | "failed"
  | "pending";

export type ExtensionItem = {
  name: string;
  status: ExtensionStatus;
  source?: string;
};

export type AgentExtensionCatalog = {
  agent: AgentExtensionId;
  mcpServers: ExtensionItem[];
  plugins: ExtensionItem[];
  mcpError?: string;
  pluginError?: string;
};

export type ExtensionCommandRunner = (
  command: AgentExtensionId,
  args: string[],
) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("The CLI returned invalid JSON");
  }
}

function sortAndDedupe(items: ExtensionItem[]): ExtensionItem[] {
  const byName = new Map<string, ExtensionItem>();
  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue;
    byName.set(name, { ...item, name });
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function stripAnsi(value: string): string {
  // Covers CSI colour/style sequences emitted by the three CLIs.
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseClaudeMcpList(output: string): ExtensionItem[] {
  const items: ExtensionItem[] = [];

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf(": ");
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim();
    const statusText = line.slice(line.lastIndexOf(" - ") + 3).trim().toLowerCase();
    let status: ExtensionStatus = "configured";
    if (statusText.includes("connected")) status = "connected";
    else if (statusText.includes("failed") || statusText.includes("error")) status = "failed";
    else if (
      statusText.includes("pending") ||
      statusText.includes("approval") ||
      statusText.includes("auth")
    ) {
      status = "pending";
    }

    items.push({ name, status });
  }

  return sortAndDedupe(items);
}

export function parseClaudePlugins(output: string): ExtensionItem[] {
  const parsed = parseJsonOutput(output);
  if (!Array.isArray(parsed)) return [];

  return sortAndDedupe(parsed.flatMap((value): ExtensionItem[] => {
    if (!isRecord(value)) return [];
    const id = nonBlankString(value.id);
    const name = nonBlankString(value.name) ?? id?.split("@")[0];
    if (!name) return [];
    return [{
      name,
      status: value.enabled === false ? "disabled" : "configured",
      source: nonBlankString(value.scope),
    }];
  }));
}

export function parseCodexMcpList(output: string): ExtensionItem[] {
  const parsed = parseJsonOutput(output);
  if (!Array.isArray(parsed)) return [];

  return sortAndDedupe(parsed.flatMap((value): ExtensionItem[] => {
    if (!isRecord(value)) return [];
    const name = nonBlankString(value.name);
    if (!name) return [];
    return [{
      name,
      status: value.enabled === false ? "disabled" : "configured",
    }];
  }));
}

function collectCodexPluginRecords(value: unknown, result: ExtensionItem[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectCodexPluginRecords(child, result);
    return;
  }
  if (!isRecord(value)) return;

  const pluginId = nonBlankString(value.pluginId);
  const name = nonBlankString(value.name) ?? pluginId?.split("@")[0];
  if (name && (pluginId || typeof value.installed === "boolean")) {
    if (value.installed !== false) {
      result.push({
        name,
        status: value.enabled === false ? "disabled" : "configured",
        source: nonBlankString(value.marketplaceName),
      });
    }
    return;
  }

  for (const child of Object.values(value)) {
    collectCodexPluginRecords(child, result);
  }
}

export function parseCodexPlugins(output: string): ExtensionItem[] {
  const result: ExtensionItem[] = [];
  collectCodexPluginRecords(parseJsonOutput(output), result);
  return sortAndDedupe(result);
}

function openCodeMcpEntries(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.mcp)) return {};
  return isRecord(config.mcp.servers) ? config.mcp.servers : config.mcp;
}

export function parseOpenCodeConfig(output: string): {
  mcpServers: ExtensionItem[];
  plugins: ExtensionItem[];
} {
  const parsed = parseJsonOutput(output);
  if (!isRecord(parsed)) return { mcpServers: [], plugins: [] };

  const mcpServers = Object.entries(openCodeMcpEntries(parsed)).flatMap(
    ([name, value]): ExtensionItem[] => {
      if (!isRecord(value)) return [];
      // v2 configuration also allows protocol-wide timeout defaults beside
      // the named server map. Only objects that resemble a server are shown.
      const isServer =
        typeof value.type === "string" ||
        typeof value.url === "string" ||
        Array.isArray(value.command) ||
        typeof value.command === "string";
      if (!isServer) return [];
      return [{
        name,
        status:
          value.disabled === true || value.enabled === false
            ? "disabled"
            : "configured",
      }];
    },
  );

  const plugins: ExtensionItem[] = [];
  const configuredPlugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  for (const value of configuredPlugins) {
    const name = nonBlankString(value) ??
      (isRecord(value)
        ? nonBlankString(value.name) ?? nonBlankString(value.spec)
        : undefined);
    if (name) plugins.push({ name, status: "configured" });
  }

  const pluginOrigins = Array.isArray(parsed.plugin_origins)
    ? parsed.plugin_origins
    : [];
  for (const value of pluginOrigins) {
    if (!isRecord(value)) continue;
    const name = nonBlankString(value.spec) ?? nonBlankString(value.name);
    if (name) plugins.push({ name, status: "configured" });
  }

  return {
    mcpServers: sortAndDedupe(mcpServers),
    plugins: sortAndDedupe(plugins),
  };
}

function parseCommandResult(
  result: PromiseSettledResult<string>,
  parser: (output: string) => ExtensionItem[],
  error: string,
): { items: ExtensionItem[]; error?: string } {
  if (result.status === "rejected") return { items: [], error };
  try {
    return { items: parser(result.value) };
  } catch {
    return { items: [], error };
  }
}

async function discoverClaude(
  run: ExtensionCommandRunner,
): Promise<AgentExtensionCatalog> {
  const [mcp, plugins] = await Promise.allSettled([
    run("claude", ["mcp", "list"]),
    run("claude", ["plugin", "list", "--json"]),
  ]);
  const mcpResult = parseCommandResult(
    mcp,
    parseClaudeMcpList,
    "Could not read Claude MCP servers.",
  );
  const pluginResult = parseCommandResult(
    plugins,
    parseClaudePlugins,
    "Could not read Claude plugins.",
  );
  return {
    agent: "claude",
    mcpServers: mcpResult.items,
    plugins: pluginResult.items,
    ...(mcpResult.error ? { mcpError: mcpResult.error } : {}),
    ...(pluginResult.error ? { pluginError: pluginResult.error } : {}),
  };
}

async function discoverCodex(
  run: ExtensionCommandRunner,
): Promise<AgentExtensionCatalog> {
  const [mcp, plugins] = await Promise.allSettled([
    run("codex", ["mcp", "list", "--json"]),
    run("codex", ["plugin", "list", "--json"]),
  ]);
  const mcpResult = parseCommandResult(
    mcp,
    parseCodexMcpList,
    "Could not read Codex MCP servers.",
  );
  const pluginResult = parseCommandResult(
    plugins,
    parseCodexPlugins,
    "Could not read Codex plugins.",
  );
  return {
    agent: "codex",
    mcpServers: mcpResult.items,
    plugins: pluginResult.items,
    ...(mcpResult.error ? { mcpError: mcpResult.error } : {}),
    ...(pluginResult.error ? { pluginError: pluginResult.error } : {}),
  };
}

async function discoverOpenCode(
  run: ExtensionCommandRunner,
): Promise<AgentExtensionCatalog> {
  try {
    const parsed = parseOpenCodeConfig(
      await run("opencode", ["debug", "config"]),
    );
    return {
      agent: "opencode",
      mcpServers: parsed.mcpServers,
      plugins: parsed.plugins,
    };
  } catch {
    return {
      agent: "opencode",
      mcpServers: [],
      plugins: [],
      mcpError: "Could not read OpenCode MCP servers.",
      pluginError: "Could not read OpenCode plugins.",
    };
  }
}

export async function discoverAgentExtensions(
  run: ExtensionCommandRunner,
): Promise<AgentExtensionCatalog[]> {
  return Promise.all([
    discoverClaude(run),
    discoverCodex(run),
    discoverOpenCode(run),
  ]);
}
