/**
 * Per-provider translation between native MCP entries and the canonical
 * definition the editor works with.
 *
 * Each codec owns an explicit list of native keys. `encode` starts from the
 * previous native entry, so every key a codec does not own — authentication
 * blocks, provider options added after this was written — is written back
 * untouched. Codecs are not the runtime translators the bridges use
 * (`configToSdkFormat`, `normalizeMcpConfig`): those deliberately keep a subset
 * and must never serialize saved configuration.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_LIMITS,
  type McpAdvancedFieldSchema,
  type McpAdvancedValue,
  type McpFieldError,
  type McpTransport,
  utf8ByteLength,
} from "@orkestrator/protocol/mcp-management";

import type { CanonicalDefinition, NativeEntry, ProviderCodec } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): { value: Record<string, string>; invalid: boolean } {
  if (value === undefined) return { value: {}, invalid: false };
  if (!isRecord(value)) return { value: {}, invalid: true };
  const out: Record<string, string> = {};
  let invalid = false;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else invalid = true;
  }
  return { value: out, invalid };
}

function stringArray(value: unknown): { value: string[]; invalid: boolean } {
  if (value === undefined) return { value: [], invalid: false };
  if (!Array.isArray(value)) return { value: [], invalid: true };
  return {
    value: value.filter((item): item is string => typeof item === "string"),
    invalid: value.some((item) => typeof item !== "string"),
  };
}

function baseDefinition(): CanonicalDefinition {
  return {
    transport: "unknown",
    args: [],
    env: {},
    headers: {},
    enabled: null,
    advanced: {},
    preservedFields: [],
  };
}

function preserved(raw: NativeEntry, owned: readonly string[]): string[] {
  return Object.keys(raw).filter((key) => !owned.includes(key));
}

/** Set `key` to `value` when meaningful, otherwise drop it (keeping a pre-existing empty value). */
function assign(out: NativeEntry, previous: NativeEntry | null, key: string, value: unknown): void {
  const empty =
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0);
  if (!empty) {
    out[key] = value;
    return;
  }
  const before = previous?.[key];
  const beforeEmpty =
    before !== undefined &&
    ((Array.isArray(before) && before.length === 0) ||
      (isRecord(before) && Object.keys(before).length === 0));
  if (beforeEmpty && value !== undefined) out[key] = before;
  else delete out[key];
}

function readAdvanced(
  raw: NativeEntry,
  fields: readonly McpAdvancedFieldSchema[],
  transport: McpTransport | "unknown",
): Record<string, McpAdvancedValue> {
  const advanced: Record<string, McpAdvancedValue> = {};
  for (const field of fields) {
    if (transport !== "unknown" && !field.transports.includes(transport)) continue;
    const value = raw[field.id];
    if (field.type === "number" && typeof value === "number") advanced[field.id] = value;
    else if (field.type === "boolean" && typeof value === "boolean") advanced[field.id] = value;
    else if (field.type === "string" && typeof value === "string") advanced[field.id] = value;
    else if (
      field.type === "string-list" &&
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      advanced[field.id] = value as string[];
    }
  }
  return advanced;
}

function writeAdvanced(
  out: NativeEntry,
  definition: CanonicalDefinition,
  fields: readonly McpAdvancedFieldSchema[],
): void {
  for (const field of fields) {
    const value = definition.advanced[field.id];
    if (
      value === undefined ||
      (definition.transport !== "unknown" && !field.transports.includes(definition.transport))
    ) {
      delete out[field.id];
    } else {
      out[field.id] = value;
    }
  }
}

/** Shared bounds; narrower provider limits are passed in. */
function validateLimits(
  definition: CanonicalDefinition,
  limits: { args?: number; env?: number; headers?: number },
  fields: readonly McpAdvancedFieldSchema[],
): McpFieldError[] {
  const errors: McpFieldError[] = [];
  const args = limits.args ?? MCP_MANAGEMENT_LIMITS.argsMax;
  const env = limits.env ?? MCP_MANAGEMENT_LIMITS.mapEntriesMax;
  const headers = limits.headers ?? MCP_MANAGEMENT_LIMITS.mapEntriesMax;
  if (definition.args.length > args)
    errors.push({ field: "args", message: `This provider accepts at most ${args} arguments.` });
  if (Object.keys(definition.env).length > env)
    errors.push({ field: "env", message: `This provider accepts at most ${env} variables.` });
  if (Object.keys(definition.headers).length > headers) {
    errors.push({ field: "headers", message: `This provider accepts at most ${headers} headers.` });
  }
  for (const [id, value] of Object.entries(definition.advanced)) {
    const field = fields.find((candidate) => candidate.id === id);
    if (!field) {
      errors.push({ field: `advanced.${id}`, message: "This provider has no such setting." });
      continue;
    }
    if (definition.transport !== "unknown" && !field.transports.includes(definition.transport)) {
      errors.push({
        field: `advanced.${id}`,
        message: `${field.label} does not apply to this transport.`,
      });
      continue;
    }
    const typeOk =
      (field.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (field.type === "boolean" && typeof value === "boolean") ||
      (field.type === "string" && typeof value === "string") ||
      (field.type === "string-list" && Array.isArray(value));
    if (!typeOk)
      errors.push({ field: `advanced.${id}`, message: `${field.label} has the wrong type.` });
    else if (
      typeof value === "number" &&
      ((field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max))
    ) {
      errors.push({
        field: `advanced.${id}`,
        message: `${field.label} must be between ${field.min ?? "-∞"} and ${field.max ?? "∞"}.`,
      });
    }
  }
  const bytes = utf8ByteLength(JSON.stringify(definition));
  if (bytes > MCP_MANAGEMENT_LIMITS.subtreeMaxBytes)
    errors.push({ field: "definition", message: "The definition is too large." });
  return errors;
}

const GENERIC_NAME = {
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
  description: "Start with a letter or digit; use letters, digits, '.', '_' and '-'.",
  maxBytes: MCP_MANAGEMENT_LIMITS.nameMaxBytes,
};

function nameErrors(
  rule: { pattern: string; description: string; maxBytes: number },
  name: string,
  isNewName: boolean,
): McpFieldError[] {
  if (!isNewName) return [];
  if (utf8ByteLength(name) > rule.maxBytes || !new RegExp(rule.pattern).test(name)) {
    return [{ field: "name", message: rule.description }];
  }
  return [];
}

/** For providers whose remote entries have no environment block; the codec would drop it. */
function remoteEnvErrors(definition: CanonicalDefinition, provider: string): McpFieldError[] {
  if (definition.transport === "stdio" || definition.transport === "unknown") return [];
  if (!Object.keys(definition.env).length) return [];
  return [
    {
      field: "env",
      message: `${provider} remote servers do not take environment variables; use headers.`,
    },
  ];
}

function requireTransportFields(definition: CanonicalDefinition): McpFieldError[] {
  if (definition.transport === "stdio" && !definition.command)
    return [{ field: "command", message: "Required." }];
  if ((definition.transport === "http" || definition.transport === "sse") && !definition.url) {
    return [{ field: "url", message: "Required." }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Claude Code: `{ type?, command, args, env }` or `{ type: http|sse, url, headers }`
// ---------------------------------------------------------------------------

const CLAUDE_OWNED = ["type", "command", "args", "env", "url", "headers"] as const;

export const claudeCodec: ProviderCodec = {
  advancedFields: [],
  nameRule: GENERIC_NAME,
  decode(raw) {
    const definition = baseDefinition();
    definition.preservedFields = preserved(raw, CLAUDE_OWNED);
    const type = raw.type;
    const env = stringRecord(raw.env);
    const headers = stringRecord(raw.headers);
    const args = stringArray(raw.args);
    definition.env = env.value;
    definition.headers = headers.value;
    definition.args = args.value;
    if (type === "http" || type === "sse") {
      definition.transport = type;
      if (typeof raw.url === "string") definition.url = raw.url;
      else definition.invalidReason = "A remote server needs a URL.";
    } else if (type === undefined || type === "stdio") {
      if (typeof raw.command === "string") {
        definition.transport = "stdio";
        definition.command = raw.command;
      } else if (typeof raw.url === "string") {
        definition.unsupportedReason =
          'A URL server needs "type": "http" or "sse" for Claude Code.';
      } else {
        definition.invalidReason = "No command or URL.";
      }
    } else {
      definition.unsupportedReason = `Transport "${String(type)}" is not recognised.`;
    }
    if (env.invalid || headers.invalid || args.invalid)
      definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    const out: NativeEntry = { ...previous };
    for (const key of CLAUDE_OWNED) delete out[key];
    // Re-insert in native order after the retained keys' original positions.
    const ordered: NativeEntry = {};
    if (definition.transport === "stdio") {
      if (!previous || previous.type !== undefined) ordered.type = "stdio";
      ordered.command = definition.command;
      assign(ordered, previous, "args", definition.args);
      assign(ordered, previous, "env", definition.env);
    } else {
      ordered.type = definition.transport;
      ordered.url = definition.url;
      assign(ordered, previous, "headers", definition.headers);
      assign(ordered, previous, "env", definition.env);
    }
    return { ...ordered, ...out };
  },
  validate(definition, name, isNewName) {
    return [
      ...nameErrors(GENERIC_NAME, name, isNewName),
      ...requireTransportFields(definition),
      ...validateLimits(definition, {}, []),
    ];
  },
  mergeNote: "Claude Code uses the whole winning entry; fields are not merged across sources.",
};

// ---------------------------------------------------------------------------
// Codex: `[mcp_servers.<name>]` in config.toml
// ---------------------------------------------------------------------------

const CODEX_ADVANCED: McpAdvancedFieldSchema[] = [
  {
    id: "startup_timeout_sec",
    label: "Startup timeout (seconds)",
    type: "number",
    transports: ["stdio", "http"],
    min: 0,
    max: 3600,
  },
  {
    id: "tool_timeout_sec",
    label: "Tool timeout (seconds)",
    type: "number",
    transports: ["stdio", "http"],
    min: 0,
    max: 86_400,
  },
  {
    id: "bearer_token_env_var",
    label: "Bearer token variable",
    type: "string",
    transports: ["http"],
    description: "Name of an environment variable holding the bearer token.",
  },
  {
    id: "enabled_tools",
    label: "Only these tools",
    type: "string-list",
    transports: ["stdio", "http"],
  },
  {
    id: "disabled_tools",
    label: "Hide these tools",
    type: "string-list",
    transports: ["stdio", "http"],
  },
  {
    id: "required",
    label: "Fail startup if unavailable",
    type: "boolean",
    transports: ["stdio", "http"],
  },
];
const CODEX_OWNED = [
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "http_headers",
  "enabled",
  ...CODEX_ADVANCED.map((field) => field.id),
];
const CODEX_NAME = {
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Codex server names use letters, digits, '_' and '-'.",
  maxBytes: MCP_MANAGEMENT_LIMITS.nameMaxBytes,
};

export const codexCodec: ProviderCodec = {
  advancedFields: CODEX_ADVANCED,
  nameRule: CODEX_NAME,
  decode(raw) {
    const definition = baseDefinition();
    definition.preservedFields = preserved(raw, CODEX_OWNED);
    const env = stringRecord(raw.env);
    const headers = stringRecord(raw.http_headers);
    const args = stringArray(raw.args);
    definition.env = env.value;
    definition.headers = headers.value;
    definition.args = args.value;
    if (typeof raw.url === "string") {
      definition.transport = "http";
      definition.url = raw.url;
      if (raw.command !== undefined) definition.invalidReason = "Both a URL and a command are set.";
    } else if (typeof raw.command === "string") {
      definition.transport = "stdio";
      definition.command = raw.command;
    } else {
      definition.invalidReason = "No command or URL.";
    }
    if (typeof raw.cwd === "string") definition.cwd = raw.cwd;
    definition.enabled = raw.enabled !== false;
    definition.advanced = readAdvanced(raw, CODEX_ADVANCED, definition.transport);
    if (env.invalid || headers.invalid || args.invalid)
      definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    const out: NativeEntry = { ...previous };
    if (previous && definition.transport === "stdio" && typeof previous.url === "string") {
      delete out.env_http_headers;
      delete out.bearer_token;
    }
    if (previous && definition.transport !== "stdio" && typeof previous.command === "string") {
      delete out.env_vars;
    }
    for (const key of ["command", "args", "env", "cwd", "url", "http_headers"]) delete out[key];
    if (definition.transport === "stdio") {
      out.command = definition.command;
      assign(out, previous, "args", definition.args);
      assign(out, previous, "env", definition.env);
      if (definition.cwd) out.cwd = definition.cwd;
    } else {
      out.url = definition.url;
      assign(out, previous, "http_headers", definition.headers);
    }
    if (definition.enabled === false) out.enabled = false;
    // An explicit true must override a lower layer's false; omitting it
    // would inherit that false again on the next load.
    else if (definition.enabled === true) out.enabled = true;
    else delete out.enabled;
    writeAdvanced(out, definition, CODEX_ADVANCED);
    return out;
  },
  validate(definition, name, isNewName) {
    const errors = [
      ...nameErrors(CODEX_NAME, name, isNewName),
      ...requireTransportFields(definition),
      ...validateLimits(definition, {}, CODEX_ADVANCED),
    ];
    errors.push(...remoteEnvErrors(definition, "Codex"));
    const bearer = definition.advanced.bearer_token_env_var;
    if (typeof bearer === "string" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearer)) {
      errors.push({
        field: "advanced.bearer_token_env_var",
        message: "Name an environment variable: letters, digits and underscores.",
      });
    }
    return errors;
  },
  mergeNote:
    "Codex merges same-name entries field by field: the higher layer's values win, env tables merge key by key, and fields it leaves out are inherited.",
};

// ---------------------------------------------------------------------------
// OpenCode: `mcp.<name>` with `type: local|remote`
// ---------------------------------------------------------------------------

const OPENCODE_ADVANCED: McpAdvancedFieldSchema[] = [
  {
    id: "timeout",
    label: "Tool listing timeout (ms)",
    type: "number",
    transports: ["stdio", "http"],
    min: 0,
    max: 600_000,
  },
  {
    id: "disableOAuth",
    label: "Disable automatic OAuth",
    type: "boolean",
    transports: ["http"],
    description: "Use static headers instead of OpenCode's OAuth flow.",
  },
];
const OPENCODE_OWNED = [
  "type",
  "command",
  "environment",
  "cwd",
  "url",
  "headers",
  "enabled",
  "timeout",
  "oauth",
];

export const opencodeCodec: ProviderCodec = {
  advancedFields: OPENCODE_ADVANCED,
  nameRule: GENERIC_NAME,
  decode(raw) {
    const definition = baseDefinition();
    const owned =
      typeof raw.oauth === "object" && raw.oauth !== null
        ? OPENCODE_OWNED.filter((key) => key !== "oauth")
        : OPENCODE_OWNED;
    definition.preservedFields = preserved(raw, owned);
    const env = stringRecord(raw.environment);
    const headers = stringRecord(raw.headers);
    definition.env = env.value;
    definition.headers = headers.value;
    if (raw.type === "local") {
      const command = stringArray(raw.command);
      if (command.invalid || !command.value.length)
        definition.invalidReason = "The command must be a non-empty list.";
      definition.transport = "stdio";
      definition.command = command.value[0];
      definition.args = command.value.slice(1);
      if (typeof raw.cwd === "string") definition.cwd = raw.cwd;
    } else if (raw.type === "remote") {
      definition.transport = "http";
      if (typeof raw.url === "string") definition.url = raw.url;
      else definition.invalidReason = "A remote server needs a URL.";
    } else {
      definition.unsupportedReason = 'OpenCode needs "type": "local" or "remote".';
    }
    definition.enabled = raw.enabled !== false;
    const advanced: Record<string, McpAdvancedValue> = {};
    if (typeof raw.timeout === "number") advanced.timeout = raw.timeout;
    if (definition.transport === "http" && raw.oauth === false) advanced.disableOAuth = true;
    definition.advanced = advanced;
    if (env.invalid || headers.invalid) definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    const out: NativeEntry = { ...previous };
    for (const key of ["type", "command", "environment", "cwd", "url", "headers"]) delete out[key];
    const ordered: NativeEntry = {};
    if (definition.transport === "stdio") {
      ordered.type = "local";
      ordered.command = [definition.command, ...definition.args];
      assign(ordered, previous, "environment", definition.env);
      if (definition.cwd) ordered.cwd = definition.cwd;
    } else {
      ordered.type = "remote";
      ordered.url = definition.url;
      assign(ordered, previous, "headers", definition.headers);
    }
    const result: NativeEntry = { ...ordered, ...out };
    if (definition.enabled === false) result.enabled = false;
    else if (previous?.enabled !== undefined || !previous) result.enabled = true;
    const timeout = definition.advanced.timeout;
    if (typeof timeout === "number") result.timeout = timeout;
    else delete result.timeout;
    const oauthObject = typeof previous?.oauth === "object" && previous?.oauth !== null;
    if (!oauthObject) {
      if (definition.transport === "http" && definition.advanced.disableOAuth === true)
        result.oauth = false;
      else delete result.oauth;
    }
    return result;
  },
  validate(definition, name, isNewName) {
    return [
      ...nameErrors(GENERIC_NAME, name, isNewName),
      ...requireTransportFields(definition),
      ...remoteEnvErrors(definition, "OpenCode"),
      ...validateLimits(definition, {}, OPENCODE_ADVANCED),
    ];
  },
  mergeNote:
    "OpenCode deep-merges same-name entries: fields the higher source leaves out are inherited from lower ones.",
};

// ---------------------------------------------------------------------------
// Cursor: `mcpServers.<name>` in mcp.json
// ---------------------------------------------------------------------------

const CURSOR_OWNED = ["type", "command", "args", "env", "cwd", "url", "headers"];

export const cursorCodec: ProviderCodec = {
  advancedFields: [],
  nameRule: GENERIC_NAME,
  decode(raw) {
    const definition = baseDefinition();
    definition.preservedFields = preserved(raw, CURSOR_OWNED);
    const env = stringRecord(raw.env);
    const headers = stringRecord(raw.headers);
    const args = stringArray(raw.args);
    definition.env = env.value;
    definition.headers = headers.value;
    definition.args = args.value;
    if (typeof raw.url === "string" && raw.url.trim()) {
      if (raw.type !== undefined && raw.type !== "http" && raw.type !== "sse") {
        definition.unsupportedReason = `Transport "${String(raw.type)}" is not recognised.`;
      }
      definition.transport = raw.type === "sse" ? "sse" : "http";
      definition.url = raw.url;
    } else if (typeof raw.command === "string" && raw.command.trim()) {
      if (raw.type !== undefined && raw.type !== "stdio")
        definition.unsupportedReason = `Transport "${String(raw.type)}" is not recognised.`;
      definition.transport = "stdio";
      definition.command = raw.command;
      if (typeof raw.cwd === "string") definition.cwd = raw.cwd;
    } else {
      definition.invalidReason = "No command or URL.";
    }
    if (env.invalid || headers.invalid || args.invalid)
      definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    const out: NativeEntry = { ...previous };
    for (const key of CURSOR_OWNED) delete out[key];
    const ordered: NativeEntry = {};
    if (definition.transport === "stdio") {
      if (previous?.type !== undefined) ordered.type = "stdio";
      ordered.command = definition.command;
      assign(ordered, previous, "args", definition.args);
      assign(ordered, previous, "env", definition.env);
      if (definition.cwd) ordered.cwd = definition.cwd;
    } else {
      if (definition.transport === "sse" || previous?.type !== undefined)
        ordered.type = definition.transport;
      ordered.url = definition.url;
      assign(ordered, previous, "headers", definition.headers);
    }
    return { ...ordered, ...out };
  },
  validate(definition, name, isNewName) {
    return [
      ...nameErrors(GENERIC_NAME, name, isNewName),
      ...requireTransportFields(definition),
      ...remoteEnvErrors(definition, "Cursor"),
      ...validateLimits(definition, {}, []),
    ];
  },
  mergeNote: "Cursor uses the whole winning entry; fields are not merged across sources.",
};

// ---------------------------------------------------------------------------
// Grok Build: `[mcp_servers.<name>]` in config.toml
// ---------------------------------------------------------------------------

const GROK_ADVANCED: McpAdvancedFieldSchema[] = [
  {
    id: "startup_timeout_sec",
    label: "Startup timeout (seconds)",
    type: "number",
    transports: ["stdio", "http"],
    min: 0,
    max: 3600,
  },
  {
    id: "tool_timeout_sec",
    label: "Tool timeout (seconds)",
    type: "number",
    transports: ["stdio", "http"],
    min: 0,
    max: 86_400,
  },
];
const GROK_OWNED = [
  "command",
  "args",
  "env",
  "url",
  "headers",
  "enabled",
  ...GROK_ADVANCED.map((field) => field.id),
];

export const grokCodec: ProviderCodec = {
  advancedFields: GROK_ADVANCED,
  nameRule: GENERIC_NAME,
  decode(raw) {
    const definition = baseDefinition();
    definition.preservedFields = preserved(raw, GROK_OWNED);
    const env = stringRecord(raw.env);
    const headers = stringRecord(raw.headers);
    const args = stringArray(raw.args);
    definition.env = env.value;
    definition.headers = headers.value;
    definition.args = args.value;
    if (typeof raw.url === "string") {
      definition.transport = "http";
      definition.url = raw.url;
    } else if (typeof raw.command === "string") {
      definition.transport = "stdio";
      definition.command = raw.command;
    } else {
      definition.invalidReason = "No command or URL.";
    }
    definition.advanced = readAdvanced(raw, GROK_ADVANCED, definition.transport);
    // Documented as `enabled = true` by default; `false` skips the server.
    definition.enabled = raw.enabled !== false;
    if (env.invalid || headers.invalid || args.invalid)
      definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    // `enabled` is read but never written: toggling it is not a verified
    // operation, so whatever the file says is carried through unchanged.
    const out: NativeEntry = { ...previous };
    for (const key of ["command", "args", "env", "url", "headers"]) delete out[key];
    if (definition.transport === "stdio") {
      out.command = definition.command;
      assign(out, previous, "args", definition.args);
      assign(out, previous, "env", definition.env);
    } else {
      out.url = definition.url;
      assign(out, previous, "headers", definition.headers);
    }
    writeAdvanced(out, definition, GROK_ADVANCED);
    return out;
  },
  validate(definition, name, isNewName) {
    return [
      ...nameErrors(GENERIC_NAME, name, isNewName),
      ...requireTransportFields(definition),
      ...remoteEnvErrors(definition, "Grok Build"),
      ...validateLimits(definition, {}, GROK_ADVANCED),
    ];
  },
  mergeNote: "A Grok project server replaces a user server of the same name entirely.",
};

// ---------------------------------------------------------------------------
// Pi (bridge-owned client): `mcpServers.<name>` or a bare map in mcp.json
//
// Everything below mirrors `bridges/pi-bridge/src/mcp-config.ts`, which in turn
// follows Pi's own loader (`dist/extensions/mcp/config.js` and
// `validateMcpServerConfig` in `dist/core/mcp-servers.js`). The backend parity
// test (`pi-mcp-parity.test.ts`) runs both over the same fixtures.
// ---------------------------------------------------------------------------

const PI_OWNED = [
  "transport",
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "enabled",
  "disabled",
];
const PI_NAME = {
  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
  description:
    "Pi server names start with a letter and use letters, digits, '_' and '-' (64 at most).",
  maxBytes: 64,
};

/** The Pi bridge's own normalization (`sanitizeMcpName` in pi-bridge/src/mcp-config.ts). */
export function piSanitizedName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(sanitized) ? sanitized : undefined;
}

/** Pi's MCP namespace: names that differ only in `-` and `_` are one server (`mcpNamespace`). */
export function piNamespace(value: string): string | undefined {
  return piSanitizedName(value)?.replace(/-/g, "_");
}

/** Entries the Pi bridge reads from one file (`MAX_MCP_SERVERS` in pi-bridge/src/mcp-config.ts). */
export const PI_SERVERS_PER_FILE = 64;

/** Keys a Pi project override may set (`MCP_OVERRIDE_KEYS` in pi-bridge/src/mcp-config.ts). */
const PI_OVERRIDE_KEYS: ReadonlySet<string> = new Set(["enabled", "exposure", "toolExposure"]);

/** Hosts Pi lets `auth` reach over plain HTTP; URL.hostname retains IPv6 brackets. */
const PI_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Bridge variables a server never receives (`BRIDGE_SECRET_ENV` in pi-bridge/src/mcp-config.ts). */
const PI_BRIDGE_SECRET_ENV: ReadonlySet<string> = new Set([
  "ORKESTRATOR_AGENT_MCP_TOKEN",
  "PI_BRIDGE_TOKEN",
]);

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function piHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** How Pi reads one entry of a file, before the user and project files merge. */
export type PiEntryShape =
  /** A project entry with no `command`, `url` or `type`: it switches the user server of that name. */
  | { kind: "override"; enabled?: boolean }
  | { kind: "server"; transport: "http" | "stdio"; hasAuth: boolean }
  /** Pi rejects the entry: it neither loads nor hides a same-named entry. */
  | { kind: "rejected"; reason: string };

const rejected = (reason: string): PiEntryShape => ({ kind: "rejected", reason });

/** Pi's exposures, with the older alias it still accepts (`PI_EXPOSURES` in the bridge). */
const PI_EXPOSURES: ReadonlySet<unknown> = new Set([
  "codemode",
  "deferred",
  "direct",
  "hidden",
  "codemode-deferred",
]);

/** Pi's checks on the keys a server and an override share (`validSharedFields` in the bridge). */
function piSharedFieldsError(raw: NativeEntry): string | undefined {
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    return "enabled must be true or false";
  if (raw.exposure !== undefined && !PI_EXPOSURES.has(raw.exposure))
    return "exposure must be codemode, deferred, direct or hidden";
  if (
    raw.toolExposure !== undefined &&
    !(
      isRecord(raw.toolExposure) &&
      Object.values(raw.toolExposure).every((exposure) => PI_EXPOSURES.has(exposure))
    )
  ) {
    return "toolExposure must map tool names to codemode, deferred, direct or hidden";
  }
  return undefined;
}

/**
 * Mirror of `acceptedTransport` and the override rules in `loadMcpConfigFile`
 * (pi-bridge/src/mcp-config.ts), which follow Pi's own validator for the
 * fields the bridge uses. `sse` and the `transport` key are bridge extensions.
 */
export function piEntryShape(raw: NativeEntry, project: boolean): PiEntryShape {
  if (raw.command === undefined && raw.url === undefined && raw.type === undefined) {
    if (!project) return rejected("Pi skips this entry: it has no command or URL.");
    if (Object.keys(raw).some((key) => !PI_OVERRIDE_KEYS.has(key))) {
      return rejected(
        "Pi skips this entry: a project entry without a command or URL overrides the user server of the same name and can set only enabled, exposure and toolExposure.",
      );
    }
    const error = piSharedFieldsError(raw);
    if (error) return rejected(`Pi skips this override: ${error}.`);
    return {
      kind: "override",
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    };
  }
  const error = piSharedFieldsError(raw);
  if (error) return rejected(`Pi skips this entry: ${error}.`);
  if (raw.description !== undefined && typeof raw.description !== "string")
    return rejected("Pi skips this entry: description must be text.");
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0)))
    return rejected("Pi skips this entry: timeout must be a positive number of seconds.");
  const declared = typeof raw.transport === "string" ? raw.transport : raw.type;
  const remote = declared === "http" || declared === "streamable-http" || declared === "sse";
  if (typeof raw.url === "string" && (declared === undefined || remote)) {
    const url = piHttpUrl(raw.url);
    if (!url)
      return rejected("Pi skips this entry: the URL must be an http:// or https:// address.");
    if (raw.headers !== undefined && !isStringMap(raw.headers))
      return rejected("Pi skips this entry: every header value must be text.");
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || !raw.auth.provider)
        return rejected("Pi skips this entry: auth.provider must name a Pi sign-in provider.");
      if (url.protocol !== "https:" && !PI_LOOPBACK_HOSTS.has(url.hostname))
        return rejected(
          "Pi skips this entry: auth needs an https:// URL, or http:// on localhost.",
        );
      if (project)
        return rejected(
          "Pi skips this entry: a project file cannot use auth, so a repository cannot choose where a sign-in token goes.",
        );
    }
    return { kind: "server", transport: "http", hasAuth: raw.auth !== undefined };
  }
  if (typeof raw.command === "string" && (declared === undefined || declared === "stdio")) {
    if (
      raw.args !== undefined &&
      !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))
    ) {
      return rejected("Pi skips this entry: every argument must be text.");
    }
    if (raw.env !== undefined && !isStringMap(raw.env))
      return rejected("Pi skips this entry: every environment value must be text.");
    if (raw.cwd !== undefined && typeof raw.cwd !== "string")
      return rejected("Pi skips this entry: the working directory must be text.");
    return { kind: "server", transport: "stdio", hasAuth: false };
  }
  if (remote) return rejected("Pi skips this entry: a remote server needs a URL.");
  if (declared === "stdio") return rejected("Pi skips this entry: a local server needs a command.");
  if (declared !== undefined)
    return rejected(`Pi skips this entry: transport "${String(declared)}" is not recognised.`);
  return rejected("Pi skips this entry: it needs a command or a URL.");
}

const PI_CONFIG_VALUE_REFERENCE =
  /\$(?:(\$)|(!)|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Why the bridge can never resolve one header or environment value
 * (`resolveConfigValue` in pi-bridge/src/mcp-config.ts). A variable that may
 * simply be unset in the bridge's environment is not reported: the backend
 * cannot see that environment.
 */
function piValueBlock(value: string): string | undefined {
  if (value.startsWith("!")) {
    return "Orkestrator's Pi sessions do not run `!command` values, so they do not start this server; Pi's own CLI does.";
  }
  for (const match of value.matchAll(PI_CONFIG_VALUE_REFERENCE)) {
    const name = match[3] ?? match[4];
    if (name && PI_BRIDGE_SECRET_ENV.has(name)) {
      return `Orkestrator's Pi sessions never pass ${name} to an MCP server, so they do not start this one.`;
    }
  }
  return undefined;
}

/**
 * Why Orkestrator's Pi sessions accept an entry but never start it (the
 * `launch`-less entries of `loadMcpConfigFile`). Such an entry still hides a
 * same-named user entry, exactly as in Pi.
 */
export function piLaunchBlock(
  raw: NativeEntry,
  shape: Extract<PiEntryShape, { kind: "server" }>,
): string | undefined {
  const check = (values: unknown, max: number, field: string): string | undefined => {
    if (!isStringMap(values)) return undefined;
    if (Object.keys(values).length > max)
      return `Orkestrator's Pi sessions accept at most ${max} ${field}, so they do not start this server; its definition still hides lower-priority entries.`;
    for (const value of Object.values(values)) {
      const block = piValueBlock(value);
      if (block) return block;
    }
    return undefined;
  };
  if (shape.transport === "http") {
    if (shape.hasAuth) {
      return "Orkestrator's Pi sessions do not start a server that signs in with a Pi provider (auth); Pi's own CLI does. Send a header instead to use it here.";
    }
    return check(raw.headers, 16, "headers");
  }
  if (!nonBlank(raw.command))
    return "The command is empty, so Orkestrator's Pi sessions cannot start this server.";
  return check(raw.env, 32, "environment variables");
}

/** Pi's saved switch: `enabled: false` is Pi's own spelling, `disabled: true` the Claude and Cursor one. */
export function piSavedEnabled(raw: NativeEntry): boolean {
  return raw.enabled !== false && raw.disabled !== true;
}

export const piCodec: ProviderCodec = {
  advancedFields: [],
  nameRule: PI_NAME,
  decode(raw) {
    const definition = baseDefinition();
    definition.preservedFields = preserved(raw, PI_OWNED);
    const env = stringRecord(raw.env);
    const headers = stringRecord(raw.headers);
    const args = stringArray(raw.args);
    definition.env = env.value;
    definition.headers = headers.value;
    definition.args = args.value;
    const declared = raw.transport ?? raw.type;
    if (declared === "sse") {
      definition.transport = "sse";
      definition.unsupportedReason =
        "Pi connects to SSE-declared servers over Streamable HTTP; switch the transport to HTTP to edit.";
    } else if (declared === "http" || declared === "streamable-http") {
      definition.transport = "http";
    } else if (declared === "stdio") {
      definition.transport = "stdio";
    } else if (declared === undefined) {
      definition.transport =
        typeof raw.url === "string"
          ? "http"
          : typeof raw.command === "string"
            ? "stdio"
            : "unknown";
    } else {
      definition.unsupportedReason = `Transport "${String(declared)}" is not recognised.`;
    }
    if (typeof raw.url === "string") definition.url = raw.url;
    if (typeof raw.command === "string") definition.command = raw.command;
    if (definition.transport === "stdio" && typeof raw.cwd === "string") definition.cwd = raw.cwd;
    if (definition.transport === "unknown" && !definition.unsupportedReason)
      definition.invalidReason = "No command or URL.";
    definition.enabled = piSavedEnabled(raw);
    if (env.invalid || headers.invalid || args.invalid)
      definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    const out: NativeEntry = { ...previous };
    for (const key of ["command", "args", "env", "cwd", "url", "headers"]) delete out[key];
    const transportKey =
      previous && "transport" in previous
        ? "transport"
        : previous && "type" in previous
          ? "type"
          : null;
    if (transportKey)
      out[transportKey] =
        definition.transport === "http" && previous?.[transportKey] === "streamable-http"
          ? "streamable-http"
          : definition.transport;
    if (definition.transport === "stdio") {
      out.command = definition.command;
      assign(out, previous, "args", definition.args);
      assign(out, previous, "env", definition.env);
      if (definition.cwd) out.cwd = definition.cwd;
    } else {
      out.url = definition.url;
      assign(out, previous, "headers", definition.headers);
    }
    // Pi's own spelling, as `pi mcp` writes it: `enabled: false` to disable,
    // no key to enable. Saving an entry migrates a `disabled` key, which Pi's
    // CLI ignores.
    delete out.disabled;
    if (definition.enabled === false) out.enabled = false;
    else delete out.enabled;
    return out;
  },
  validate(definition, name, isNewName) {
    return [
      ...nameErrors(PI_NAME, name, isNewName),
      ...requireTransportFields(definition),
      ...remoteEnvErrors(definition, "Pi"),
      ...validateLimits(definition, { args: 32, env: 32, headers: 16 }, []),
    ];
  },
  mergeNote:
    "A Pi project server replaces the user server of the same name, even when it is disabled or cannot start.",
};

export const PROVIDER_CODECS: Readonly<Record<AgentPlatform, ProviderCodec>> = Object.freeze({
  claude: claudeCodec,
  codex: codexCodec,
  opencode: opencodeCodec,
  cursor: cursorCodec,
  grok: grokCodec,
  pi: piCodec,
});
