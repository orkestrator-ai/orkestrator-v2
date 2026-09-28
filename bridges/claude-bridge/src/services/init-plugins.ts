import type { PluginRuntimeStatus } from "../types/index.js";

/** Most plugin rows one init message may contribute. */
export const MAX_INIT_PLUGINS = 128;

/** Most `plugin_errors` entries one init message may contribute. */
export const MAX_INIT_PLUGIN_ERRORS = 64;

/** Longest plugin error text kept. It is display text from the CLI. */
export const MAX_PLUGIN_ERROR_LENGTH = 1_000;

/** One entry of the init message's `plugin_errors` (Agent SDK 0.3.283+). */
export interface InitPluginError {
  /** `name@marketplace`, or a positional `inline[N]` / `synced[N]` tag. */
  plugin: string;
  /** Category from an open set; an unknown value is a generic failure. */
  type: string;
  message: string;
  path?: string;
  /** False when the plugin is absent from `plugins[]`, i.e. did not load. */
  loaded: boolean;
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Whether an error names this row. `plugin_errors` identifies a plugin as
 * `name@marketplace` while `plugins[]` carries the bare name, so both forms
 * match; a positional tag names a directory entry that failed before it had a
 * name and never matches a row.
 */
function errorNamesRow(pluginId: string, rowName: string): boolean {
  return pluginId === rowName || pluginId.startsWith(`${rowName}@`);
}

/**
 * Plugin statuses from a `system/init` message.
 *
 * `plugins[]` lists only what loaded — it has no status field, so every row in
 * it is `loaded`. What did not load is reported separately in `plugin_errors`
 * (absent before Agent SDK 0.3.283, and omitted when there were none). A
 * plugin that loaded without one of its components keeps its row and gets an
 * error entry too; that row stays `loaded` and carries the error. A plugin with
 * no row gets a `failed` one, so the settings panel can name it.
 *
 * MCP servers a plugin contributes arrive as `plugin:`-prefixed MCP servers and
 * are listed as plugin rows graded by their connection status.
 */
export function pluginStatusesFromInit(init: {
  mcp_servers?: unknown;
  plugins?: unknown;
  plugin_errors?: unknown;
}): { statuses: PluginRuntimeStatus[]; errors: InitPluginError[] } {
  const statuses: PluginRuntimeStatus[] = [];

  const mcpServers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  for (const candidate of mcpServers) {
    const server = record(candidate);
    const name = text(server?.name, 256);
    if (!name?.startsWith("plugin:")) continue;
    const error = text(server?.error, MAX_PLUGIN_ERROR_LENGTH);
    statuses.push({
      name,
      status: server?.status === "connected" ? "loaded" : "failed",
      ...(error ? { error } : {}),
    });
  }

  const plugins = Array.isArray(init.plugins) ? init.plugins : [];
  const loadedRows: PluginRuntimeStatus[] = [];
  for (const candidate of plugins) {
    const plugin = record(candidate);
    const name = text(plugin?.name, 256);
    if (!name) continue;
    const path = text(plugin?.path, 4_096);
    loadedRows.push({ name, ...(path ? { path } : {}), status: "loaded" });
  }
  statuses.push(...loadedRows);

  const errors: InitPluginError[] = [];
  const rawErrors = Array.isArray(init.plugin_errors) ? init.plugin_errors : [];
  for (const candidate of rawErrors.slice(0, MAX_INIT_PLUGIN_ERRORS)) {
    const entry = record(candidate);
    const pluginId = text(entry?.plugin, 256);
    if (!pluginId) continue;
    const message = text(entry?.message, MAX_PLUGIN_ERROR_LENGTH) ?? "Plugin failed to load";
    const type = text(entry?.type, 128) ?? "generic-error";
    const path = text(entry?.path, 4_096);
    const row = loadedRows.find((candidateRow) => errorNamesRow(pluginId, candidateRow.name));
    if (row) {
      // Several errors against one partially loaded plugin: keep the first as
      // the row's summary; each still becomes its own error entry.
      row.error ??= message;
    } else {
      statuses.push({
        name: pluginId,
        ...(path ? { path } : {}),
        status: "failed",
        error: message,
      });
    }
    errors.push({ plugin: pluginId, type, message, ...(path ? { path } : {}), loaded: !!row });
  }

  return { statuses: statuses.slice(0, MAX_INIT_PLUGINS), errors };
}
