/**
 * Turn a validated mutation request into a new canonical definition.
 *
 * `keep` edits resolve against the revision the transaction just read, never
 * against anything the renderer holds: the renderer never had the value. A
 * `keep` that names a key or argument that no longer exists is refused rather
 * than silently moving some other credential into the edited definition.
 */

import {
  isEnvReference,
  isSensitiveArg,
  isSensitiveUrl,
  mcpFailure,
  type McpAdvancedValue,
  type McpDefinitionInput,
  type McpDefinitionPatch,
  type McpFieldError,
  type McpMapEdit,
  type McpTargetCapabilities,
  type McpTransport,
} from "@orkestrator/protocol/mcp-management";

import type { CanonicalDefinition, SourceSpec } from "./types.js";

function emptyDefinition(transport: McpTransport): CanonicalDefinition {
  return {
    transport,
    args: [],
    env: {},
    headers: {},
    enabled: null,
    advanced: {},
    preservedFields: [],
  };
}

export function definitionFromInput(
  input: McpDefinitionInput,
  enabledSupported: boolean,
): CanonicalDefinition {
  const definition = emptyDefinition(input.transport);
  if (input.transport === "stdio") {
    definition.command = input.command;
    definition.args = [...(input.args ?? [])];
    if (input.cwd) definition.cwd = input.cwd;
  } else {
    definition.url = input.url;
  }
  for (const { key, value } of input.env ?? []) definition.env[key] = value;
  for (const { key, value } of input.headers ?? []) definition.headers[key] = value;
  definition.enabled = enabledSupported ? (input.enabled ?? true) : null;
  definition.advanced = { ...input.advanced };
  return definition;
}

function applyMapEdits(
  kind: "env" | "headers",
  current: Record<string, string>,
  edits: readonly McpMapEdit[],
  errors: McpFieldError[],
): Record<string, string> {
  const next: Record<string, string> = { ...current };
  const moved = new Set<string>();
  edits.forEach((entry, index) => {
    const field = `${kind}.${index}`;
    switch (entry.edit.kind) {
      case "keep": {
        const from = entry.edit.fromKey ?? entry.key;
        if (!Object.hasOwn(current, from)) {
          errors.push({
            field,
            message: "The saved value no longer exists; reload and try again.",
          });
          return;
        }
        next[entry.key] = current[from]!;
        if (from !== entry.key) moved.add(from);
        break;
      }
      case "set":
        next[entry.key] = entry.edit.value;
        break;
      case "clear":
        delete next[entry.key];
        break;
    }
  });
  const edited = new Set(edits.map((entry) => entry.key));
  for (const from of moved) if (!edited.has(from)) delete next[from];
  if (kind === "headers") {
    const folded = new Set<string>();
    for (const key of Object.keys(next)) {
      const lower = key.toLowerCase();
      if (folded.has(lower)) errors.push({ field: kind, message: `Duplicate header ${key}.` });
      folded.add(lower);
    }
  }
  return next;
}

const TRANSPORT_FIELDS: Record<"stdio" | "remote", string[]> = {
  stdio: ["command", "args", "cwd"],
  remote: ["url", "headers"],
};

export function applyPatch(
  current: CanonicalDefinition,
  patch: McpDefinitionPatch,
  capabilities: McpTargetCapabilities,
): { definition: CanonicalDefinition; errors: McpFieldError[]; changed: string[] } {
  const errors: McpFieldError[] = [];
  const changed: string[] = [];
  const next: CanonicalDefinition = {
    ...current,
    args: [...current.args],
    env: { ...current.env },
    headers: { ...current.headers },
    advanced: { ...current.advanced },
  };
  if (patch.transport && patch.transport.to !== current.transport) {
    const from = current.transport === "stdio" ? "stdio" : "remote";
    const to = patch.transport.to === "stdio" ? "stdio" : "remote";
    if (from !== to) {
      // Every field the switch drops must be named, so nothing disappears by accident.
      const dropping = TRANSPORT_FIELDS[from].filter((field) => {
        if (field === "args") return current.args.length > 0;
        if (field === "headers") return Object.keys(current.headers).length > 0;
        return current[field as "command" | "cwd" | "url"] !== undefined;
      });
      const missing = dropping.filter((field) => !patch.transport!.discard.includes(field));
      if (missing.length) {
        errors.push({
          field: "transport",
          message: `Switching transport discards ${missing.join(", ")}; confirm the switch.`,
        });
      }
      if (from === "stdio") {
        delete next.command;
        next.args = [];
        delete next.cwd;
      } else {
        delete next.url;
        next.headers = {};
      }
    }
    next.transport = patch.transport.to;
    changed.push("transport");
  }
  if (patch.command?.kind === "set") {
    next.command = patch.command.value;
    changed.push("command");
  }
  if (patch.url?.kind === "set") {
    next.url = patch.url.value;
    changed.push("url");
  }
  if (patch.args) {
    const args: string[] = [];
    patch.args.forEach((edit, index) => {
      if (edit.kind === "keep") {
        if (edit.index >= current.args.length) {
          errors.push({
            field: `args.${index}`,
            message: "The saved argument no longer exists; reload and try again.",
          });
          return;
        }
        args.push(current.args[edit.index]!);
      } else {
        args.push(edit.value);
      }
    });
    if (
      args.length !== current.args.length ||
      args.some((arg, index) => arg !== current.args[index])
    )
      changed.push("arguments");
    next.args = args;
  }
  if (patch.cwd) {
    if (!capabilities.fields.cwd.supported && patch.cwd.kind === "set") {
      errors.push({ field: "cwd", message: capabilities.fields.cwd.reason ?? "Not supported." });
    }
    if (patch.cwd.kind === "set") next.cwd = patch.cwd.value;
    else delete next.cwd;
    changed.push("working directory");
  }
  if (patch.env?.length) {
    next.env = applyMapEdits("env", current.env, patch.env, errors);
    changed.push("environment");
  }
  if (patch.headers?.length) {
    next.headers = applyMapEdits("headers", current.headers, patch.headers, errors);
    changed.push("headers");
  }
  if (patch.advanced) {
    for (const key of patch.advanced.remove ?? []) delete next.advanced[key];
    for (const [key, value] of Object.entries(patch.advanced.set ?? {}))
      next.advanced[key] = value as McpAdvancedValue;
    changed.push("advanced settings");
  }
  return { definition: next, errors, changed };
}

/**
 * Transport and field support for the whole resulting definition. Applied to
 * adds and updates alike, so a transport the provider cannot load is refused
 * rather than saved and silently ignored.
 */
export function capabilityErrors(
  definition: CanonicalDefinition,
  capabilities: McpTargetCapabilities,
): McpFieldError[] {
  const errors: McpFieldError[] = [];
  if (definition.transport !== "unknown") {
    const support = capabilities.transports[definition.transport];
    if (!support.supported)
      errors.push({ field: "transport", message: support.reason ?? "Unsupported transport." });
  }
  if (definition.cwd !== undefined && !capabilities.fields.cwd.supported) {
    errors.push({ field: "cwd", message: capabilities.fields.cwd.reason ?? "Not supported." });
  }
  if (definition.transport === "stdio" && Object.keys(definition.headers).length) {
    errors.push({ field: "headers", message: "A stdio server has no headers." });
  }
  return errors;
}

/**
 * Project files are shared through the repository. The basic editor refuses
 * to put a *new* literal secret there; values already present are retained.
 */
export function projectSecretErrors(
  spec: SourceSpec,
  before: CanonicalDefinition | null,
  after: CanonicalDefinition,
): McpFieldError[] {
  if (spec.scope !== "project") return [];
  const errors: McpFieldError[] = [];
  const message =
    "Project files are shared; use a variable reference such as ${API_KEY}, or save to a private scope.";
  for (const kind of ["env", "headers"] as const) {
    for (const [key, value] of Object.entries(after[kind])) {
      if (isEnvReference(value)) continue;
      if (before && before[kind][key] === value) continue;
      // Moving an existing value to a new key is still the same value.
      if (before && Object.values(before[kind]).includes(value)) continue;
      errors.push({ field: `${kind}.${key}`, message });
    }
  }
  after.args.forEach((arg, index) => {
    if (isEnvReference(arg) || !isSensitiveArg(arg, after.args[index - 1])) return;
    if (before?.args[index] === arg || before?.args.includes(arg)) return;
    errors.push({ field: `args.${index}`, message });
  });
  if (after.url && isSensitiveUrl(after.url) && after.url !== before?.url) {
    errors.push({
      field: "url",
      message: "Project files are shared; move credentials out of the URL into a header reference.",
    });
  }
  return errors;
}

export function assertNoFieldErrors(errors: readonly McpFieldError[]): void {
  if (!errors.length) return;
  const first = errors[0]!;
  throw mcpFailure("invalid-definition", {
    field: first.field,
    message: errors.map((error) => `${error.field}: ${error.message}`).join(" "),
  });
}

/** Strip `undefined` so semantic verification compares like with like. */
export function cleanEntry<T extends Record<string, unknown>>(entry: T): T {
  return JSON.parse(JSON.stringify(entry)) as T;
}
