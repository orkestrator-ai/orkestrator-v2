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

/**
 * An item plus the identity it should be deduplicated on. Plugins dedupe on
 * their fully qualified id so that two marketplaces publishing the same short
 * name stay visible as two entries; MCP servers dedupe on name, which is
 * already unique within an agent's configuration.
 */
type KeyedItem = { key: string; item: ExtensionItem };

function sortAndDedupeKeyed(entries: KeyedItem[]): ExtensionItem[] {
  const byKey = new Map<string, KeyedItem>();
  for (const entry of entries) {
    const name = entry.item.name.trim();
    if (!name) continue;
    const key = entry.key.trim() || name;
    byKey.set(key, { key, item: { ...entry.item, name } });
  }
  return [...byKey.values()]
    .sort(
      (left, right) =>
        left.item.name.localeCompare(right.item.name) ||
        left.key.localeCompare(right.key),
    )
    .map((entry) => entry.item);
}

function sortAndDedupe(items: ExtensionItem[]): ExtensionItem[] {
  return sortAndDedupeKeyed(items.map((item) => ({ key: item.name, item })));
}

/**
 * Plugin ids are `<name>@<marketplace>`, but the name itself may be npm-scoped
 * (`@team/review@official`). Splitting on the first `@` would yield an empty
 * name for those and drop the plugin, so only the marketplace suffix is cut.
 */
function pluginShortName(id: string): string | undefined {
  const marketplace = id.lastIndexOf("@");
  return nonBlankString(marketplace > 0 ? id.slice(0, marketplace) : id);
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

    // Every server line ends in ` - <status>`. Lines without it are headers or
    // the indented detail printed under a failed server, and accepting them
    // would both invent entries and infer their status from command text —
    // which routinely contains "auth", "error" or "connected".
    const statusSeparator = line.lastIndexOf(" - ");
    if (statusSeparator <= separator) continue;

    const name = line.slice(0, separator).trim();
    const statusText = line.slice(statusSeparator + 3).trim().toLowerCase();
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

  return sortAndDedupeKeyed(parsed.flatMap((value): KeyedItem[] => {
    if (!isRecord(value)) return [];
    const id = nonBlankString(value.id);
    const name = nonBlankString(value.name) ?? (id ? pluginShortName(id) : undefined);
    if (!name) return [];
    return [{
      key: id ?? name,
      item: {
        name,
        status: value.enabled === false ? "disabled" : "configured",
        source: nonBlankString(value.scope),
      },
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

function collectCodexPluginRecords(value: unknown, result: KeyedItem[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectCodexPluginRecords(child, result);
    return;
  }
  if (!isRecord(value)) return;

  const pluginId = nonBlankString(value.pluginId);
  const name = nonBlankString(value.name) ?? (pluginId ? pluginShortName(pluginId) : undefined);
  if (name && (pluginId || typeof value.installed === "boolean")) {
    // `codex plugin list` reports everything the configured marketplaces offer,
    // not just what is installed here.
    if (value.installed !== false) {
      result.push({
        key: pluginId ?? name,
        item: {
          name,
          status: value.enabled === false ? "disabled" : "configured",
          source: nonBlankString(value.marketplaceName),
        },
      });
    }
    return;
  }

  for (const child of Object.values(value)) {
    collectCodexPluginRecords(child, result);
  }
}

export function parseCodexPlugins(output: string): ExtensionItem[] {
  const result: KeyedItem[] = [];
  collectCodexPluginRecords(parseJsonOutput(output), result);
  return sortAndDedupeKeyed(result);
}

function openCodeMcpEntries(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.mcp)) return {};
  return isRecord(config.mcp.servers) ? config.mcp.servers : config.mcp;
}

export function parseOpenCodeMcpServers(output: string): ExtensionItem[] {
  const parsed = parseJsonOutput(output);
  if (!isRecord(parsed)) return [];
  // Present but not an object: this surface exists and cannot be read, which is
  // an error for *this* surface alone — the plugin list beside it in the same
  // dump is still perfectly readable. An absent section stays "none configured".
  if (parsed.mcp != null && !isRecord(parsed.mcp)) {
    throw new Error("The CLI reported an unreadable mcp section");
  }

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

  return sortAndDedupe(mcpServers);
}

export function parseOpenCodePlugins(output: string): ExtensionItem[] {
  const parsed = parseJsonOutput(output);
  if (!isRecord(parsed)) return [];
  // Same rule as the mcp section above, applied to this surface's own keys: a
  // plugin list that is present but not a list is unreadable, and says nothing
  // about whether the MCP servers beside it could be read.
  for (const key of ["plugin", "plugin_origins"] as const) {
    if (parsed[key] != null && !Array.isArray(parsed[key])) {
      throw new Error(`The CLI reported an unreadable ${key} section`);
    }
  }

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

  return sortAndDedupe(plugins);
}

/**
 * Both OpenCode surfaces from one `debug config` dump. Kept as the combined
 * view for callers that want the whole config; discovery deliberately calls the
 * two parsers separately so one failing surface cannot blank the other.
 */
export function parseOpenCodeConfig(output: string): {
  mcpServers: ExtensionItem[];
  plugins: ExtensionItem[];
} {
  return {
    mcpServers: parseOpenCodeMcpServers(output),
    plugins: parseOpenCodePlugins(output),
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
  // OpenCode reports both surfaces from a single `debug config` dump, so there
  // is one command to settle rather than two — but the two surfaces are still
  // parsed independently, exactly as for Claude and Codex. A single try/catch
  // around both parses reported a partial success as a total failure: a config
  // whose `mcp` block had drifted into a shape the MCP parser rejects blanked
  // the plugin list too, and vice versa.
  const [config] = await Promise.allSettled([
    run("opencode", ["debug", "config"]),
  ]);
  const mcpResult = parseCommandResult(
    config,
    parseOpenCodeMcpServers,
    "Could not read OpenCode MCP servers.",
  );
  const pluginResult = parseCommandResult(
    config,
    parseOpenCodePlugins,
    "Could not read OpenCode plugins.",
  );
  return {
    agent: "opencode",
    mcpServers: mcpResult.items,
    plugins: pluginResult.items,
    ...(mcpResult.error ? { mcpError: mcpResult.error } : {}),
    ...(pluginResult.error ? { pluginError: pluginResult.error } : {}),
  };
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

export const EXTENSION_DISCOVERY_TTL_MS = 60_000;

export type ExtensionDiscoveryCache = {
  get(
    key: string,
    load: () => Promise<AgentExtensionCatalog[]>,
    options?: { refresh?: boolean },
  ): Promise<AgentExtensionCatalog[]>;
  invalidate(key: string): void;
};

/**
 * Discovery is not a passive read: `claude mcp list` health-checks every
 * approved MCP server, which spawns each stdio server and opens each HTTP
 * server's connection. Caching per environment keeps reopening a settings
 * dialog from respawning them, and sharing the in-flight promise keeps
 * concurrent callers down to a single run.
 */
export function createExtensionDiscoveryCache({
  ttlMs = EXTENSION_DISCOVERY_TTL_MS,
  now = () => Date.now(),
}: { ttlMs?: number; now?: () => number } = {}): ExtensionDiscoveryCache {
  const entries = new Map<
    string,
    { expiresAt: number; catalogs: Promise<AgentExtensionCatalog[]> }
  >();

  const prune = (): void => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
  };

  return {
    get(key, load, options) {
      prune();
      if (!options?.refresh) {
        const cached = entries.get(key);
        if (cached) return cached.catalogs;
      }

      const catalogs = load();
      entries.set(key, { expiresAt: now() + ttlMs, catalogs });
      // A failed run must not be served for the rest of the TTL: drop it so the
      // next open retries. The rejection is still delivered to this caller.
      void catalogs.catch(() => {
        if (entries.get(key)?.catalogs === catalogs) entries.delete(key);
      });
      return catalogs;
    },
    invalidate(key) {
      entries.delete(key);
    },
  };
}
