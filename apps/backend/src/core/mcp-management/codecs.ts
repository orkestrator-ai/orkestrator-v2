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
    else if (previous?.enabled === true) out.enabled = true;
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
// ---------------------------------------------------------------------------

const PI_OWNED = ["transport", "type", "command", "args", "env", "url", "headers", "disabled"];
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

/** Servers the Pi bridge accepts from one file (`MAX_MCP_SERVERS` in pi-bridge/src/mcp-config.ts). */
export const PI_SERVERS_PER_FILE = 64;

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Why the Pi bridge silently skips an entry, mirroring `normalizeMcpServer` /
 * `readTransport` in pi-bridge/src/mcp-config.ts. `undefined` means Pi loads
 * it. A disabled entry is reported separately and is not a load failure.
 */
export function piLoadBlock(name: string, raw: NativeEntry | null): string | undefined {
  if (!piSanitizedName(name)) {
    return "Pi skips this entry: a server name must start with a letter and be at most 64 characters.";
  }
  if (!raw) return "Pi skips this entry: it is not an object.";
  const declared =
    typeof raw.transport === "string"
      ? raw.transport
      : typeof raw.type === "string"
        ? raw.type
        : undefined;
  let transport: "http" | "stdio" | undefined;
  if (declared === "streamable-http" || declared === "http" || declared === "sse") {
    transport = "http";
  } else if (declared === "stdio" || declared === undefined) {
    if (nonBlank(raw.url)) transport = "http";
    else if (nonBlank(raw.command)) transport = "stdio";
  } else {
    return `Pi skips this entry: transport "${declared}" is not recognised.`;
  }
  if (transport === "http") {
    if (!nonBlank(raw.url)) return "Pi skips this entry: a remote server needs a URL.";
    try {
      const url = new URL(raw.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return "Pi skips this entry: the URL must start with http:// or https://.";
    } catch {
      return "Pi skips this entry: the URL is not valid.";
    }
    return undefined;
  }
  if (transport !== "stdio") return "Pi skips this entry: it has no command or URL.";
  return undefined;
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
    if (definition.transport === "unknown" && !definition.unsupportedReason)
      definition.invalidReason = "No command or URL.";
    definition.enabled = raw.disabled !== true;
    if (env.invalid || headers.invalid || args.invalid)
      definition.invalidReason ??= "Some values are not text.";
    return definition;
  },
  encode(definition, previous) {
    const out: NativeEntry = { ...previous };
    for (const key of ["command", "args", "env", "url", "headers"]) delete out[key];
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
    } else {
      out.url = definition.url;
      assign(out, previous, "headers", definition.headers);
    }
    if (definition.enabled === false) out.disabled = true;
    else delete out.disabled;
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
  mergeNote: "A Pi project server replaces a user server with the same normalized name.",
};

export const PROVIDER_CODECS: Readonly<Record<AgentPlatform, ProviderCodec>> = Object.freeze({
  claude: claudeCodec,
  codex: codexCodec,
  opencode: opencodeCodec,
  cursor: cursorCodec,
  grok: grokCodec,
  pi: piCodec,
});
