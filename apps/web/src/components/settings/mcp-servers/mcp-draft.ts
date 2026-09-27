/**
 * Editor draft model. Pure functions only, so the patch semantics are tested
 * without rendering.
 *
 * Saved secrets never enter a draft: a literal env/header value is a `keep`
 * row that knows only its key; a redacted argument or URL is a `keep` that
 * refers to the saved value by position. The patch sent to the backend is
 * therefore expressed as keep/set/clear, and "no change" is omitted entirely.
 */

import type {
  McpAdvancedFieldSchema,
  McpAdvancedValue,
  McpArgEdit,
  McpDefinitionInput,
  McpDefinitionPatch,
  McpEditableDefinition,
  McpMapEdit,
  McpTransport,
} from "@orkestrator/protocol/mcp-management";

let rowCounter = 0;
const rowId = () => `row-${++rowCounter}`;

export type RetainedDraft = { kind: "keep"; display: string } | { kind: "set"; value: string };

export type ArgRow =
  | { id: string; kind: "keep"; index: number; display: string }
  | { id: string; kind: "set"; value: string };

export interface MapRow {
  id: string;
  key: string;
  /** Key in the saved revision; absent for a new row. */
  originalKey?: string;
  /** keep = saved value retained; set = typed value; */
  mode: "keep" | "set";
  value: string;
  /** Saved reference text, shown verbatim, for change detection. */
  originalReference?: string;
}

export interface McpDraft {
  name: string;
  transport: McpTransport;
  command: RetainedDraft;
  args: ArgRow[];
  cwd: string;
  url: RetainedDraft;
  env: MapRow[];
  headers: MapRow[];
  /** Keys of saved env/header rows the user removed. */
  clearedEnv: string[];
  clearedHeaders: string[];
  enabled: boolean;
  advanced: Record<string, McpAdvancedValue | "">;
}

export function emptyDraft(transport: McpTransport = "stdio"): McpDraft {
  return {
    name: "",
    transport,
    command: { kind: "set", value: "" },
    args: [],
    cwd: "",
    url: { kind: "set", value: "" },
    env: [],
    headers: [],
    clearedEnv: [],
    clearedHeaders: [],
    enabled: true,
    advanced: {},
  };
}

function mapRows(entries: McpEditableDefinition["env"]): MapRow[] {
  return entries.map((entry) =>
    entry.presence === "reference"
      ? {
          id: rowId(),
          key: entry.key,
          originalKey: entry.key,
          mode: "set",
          value: entry.reference ?? "",
          originalReference: entry.reference,
        }
      : { id: rowId(), key: entry.key, originalKey: entry.key, mode: "keep", value: "" },
  );
}

export function draftFromDefinition(definition: McpEditableDefinition): McpDraft {
  const transport = definition.transport === "unknown" ? "stdio" : definition.transport;
  return {
    name: definition.name,
    transport,
    command: !definition.command
      ? { kind: "set", value: "" }
      : definition.command.kind === "visible"
        ? { kind: "set", value: definition.command.value }
        : { kind: "keep", display: definition.command?.display ?? "" },
    args: definition.args.map((arg) =>
      arg.value.kind === "visible"
        ? { id: rowId(), kind: "set", value: arg.value.value }
        : { id: rowId(), kind: "keep", index: arg.index, display: arg.value.display },
    ),
    cwd: definition.cwd ?? "",
    url: !definition.url
      ? { kind: "set", value: "" }
      : definition.url.kind === "visible"
        ? { kind: "set", value: definition.url.value }
        : { kind: "keep", display: definition.url?.display ?? "" },
    env: mapRows(definition.env),
    headers: mapRows(definition.headers),
    clearedEnv: [],
    clearedHeaders: [],
    enabled: definition.enabled ?? true,
    advanced: { ...definition.advanced },
  };
}

export function newMapRow(): MapRow {
  return { id: rowId(), key: "", mode: "set", value: "" };
}

export function newArgRow(value = ""): ArgRow {
  return { id: rowId(), kind: "set", value };
}

function cleanAdvanced(advanced: McpDraft["advanced"]): Record<string, McpAdvancedValue> {
  const out: Record<string, McpAdvancedValue> = {};
  for (const [key, value] of Object.entries(advanced)) {
    if (value === "" || value === undefined) continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

export function definitionInputFromDraft(
  draft: McpDraft,
  enabledSupported: boolean,
  advancedFields?: McpAdvancedFieldSchema[],
): McpDefinitionInput {
  const stdio = draft.transport === "stdio";
  const input: McpDefinitionInput = { name: draft.name.trim(), transport: draft.transport };
  if (stdio) {
    input.command = draft.command.kind === "set" ? draft.command.value.trim() : "";
    input.args = draft.args.map((arg) => (arg.kind === "set" ? arg.value : ""));
    if (draft.cwd.trim()) input.cwd = draft.cwd.trim();
  } else {
    input.url = draft.url.kind === "set" ? draft.url.value.trim() : "";
    const headers = draft.headers.filter((row) => row.key.trim());
    if (headers.length)
      input.headers = headers.map((row) => ({ key: row.key.trim(), value: row.value }));
  }
  const env = draft.env.filter((row) => row.key.trim());
  if (env.length) input.env = env.map((row) => ({ key: row.key.trim(), value: row.value }));
  if (enabledSupported) input.enabled = draft.enabled;
  const advanced = cleanAdvanced(draft.advanced);
  if (advancedFields) {
    for (const field of advancedFields) {
      if (!field.transports.includes(draft.transport)) delete advanced[field.id];
    }
  }
  if (Object.keys(advanced).length) input.advanced = advanced;
  return input;
}

function mapPatch(rows: MapRow[], cleared: string[]): McpMapEdit[] {
  const edits: McpMapEdit[] = [];
  // Saved keys renamed while their value was replaced; the old key must go.
  const movedFrom = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.mode === "keep") {
      // The backend drops the old key of a keep-move itself.
      if (row.originalKey && row.originalKey !== key)
        edits.push({ key, edit: { kind: "keep", fromKey: row.originalKey } });
      continue;
    }
    // Clicking Replace without entering a new value must retain a saved literal.
    if (row.originalKey && row.originalReference === undefined && row.value === "") {
      if (row.originalKey !== key)
        edits.push({ key, edit: { kind: "keep", fromKey: row.originalKey } });
      continue;
    }
    if (
      row.originalKey === key &&
      row.originalReference !== undefined &&
      row.originalReference === row.value
    )
      continue;
    edits.push({ key, edit: { kind: "set", value: row.value } });
    if (row.originalKey && row.originalKey !== key) movedFrom.add(row.originalKey);
  }
  const present = new Set(rows.map((row) => row.key.trim()));
  for (const key of cleared) if (!present.has(key)) edits.push({ key, edit: { kind: "clear" } });
  for (const key of movedFrom) {
    if (!present.has(key) && !edits.some((edit) => edit.key === key))
      edits.push({ key, edit: { kind: "clear" } });
  }
  return edits;
}

/** Minimal patch from the saved definition to the draft. Omits every unchanged field. */
export function patchFromDraft(
  original: McpEditableDefinition,
  draft: McpDraft,
  advancedFields: McpAdvancedFieldSchema[] = [],
): McpDefinitionPatch {
  const patch: McpDefinitionPatch = {};
  const before = draftFromDefinition(original);
  if (draft.transport !== before.transport) {
    const discard: string[] = [];
    const fromStdio = before.transport === "stdio";
    const toStdio = draft.transport === "stdio";
    if (fromStdio !== toStdio) {
      if (fromStdio) discard.push("command", "args", "cwd");
      else discard.push("url", "headers");
      const native = fromStdio ? ["env_vars"] : ["env_http_headers", "bearer_token"];
      for (const key of native) if (original.preservedFields.includes(key)) discard.push(key);
    }
    patch.transport = { to: draft.transport, discard };
  }
  const stdio = draft.transport === "stdio";
  if (stdio) {
    if (
      draft.command.kind === "set" &&
      (before.command.kind !== "set" || before.command.value !== draft.command.value.trim())
    ) {
      patch.command = { kind: "set", value: draft.command.value.trim() };
    }
    const toEdits = (rows: ArgRow[]): McpArgEdit[] =>
      rows.map((arg) =>
        arg.kind === "keep"
          ? { kind: "keep", index: arg.index }
          : { kind: "set", value: arg.value },
      );
    const argEdits = toEdits(draft.args);
    if (patch.transport || JSON.stringify(argEdits) !== JSON.stringify(toEdits(before.args)))
      patch.args = argEdits;
    if (draft.cwd.trim() !== before.cwd)
      patch.cwd = draft.cwd.trim() ? { kind: "set", value: draft.cwd.trim() } : { kind: "clear" };
  } else if (
    draft.url.kind === "set" &&
    (before.url.kind !== "set" || before.url.value !== draft.url.value.trim())
  ) {
    patch.url = { kind: "set", value: draft.url.value.trim() };
  }
  const env = mapPatch(draft.env, draft.clearedEnv);
  if (env.length) patch.env = env;
  if (!stdio) {
    const headers = mapPatch(draft.headers, draft.clearedHeaders);
    if (headers.length) patch.headers = headers;
  }
  const beforeAdvanced = cleanAdvanced(before.advanced);
  const afterAdvanced = cleanAdvanced(draft.advanced);
  const set: Record<string, McpAdvancedValue> = {};
  const remove: string[] = [];
  const inapplicable = new Set(
    advancedFields
      .filter((field) => !field.transports.includes(draft.transport))
      .map((field) => field.id),
  );
  for (const [key, value] of Object.entries(afterAdvanced)) {
    if (inapplicable.has(key)) continue;
    if (JSON.stringify(beforeAdvanced[key]) !== JSON.stringify(value)) set[key] = value;
  }
  for (const key of Object.keys(beforeAdvanced))
    if (!(key in afterAdvanced) || inapplicable.has(key)) remove.push(key);
  if (Object.keys(set).length || remove.length)
    patch.advanced = {
      ...(Object.keys(set).length ? { set } : {}),
      ...(remove.length ? { remove } : {}),
    };
  return patch;
}

export function isEmptyPatch(patch: McpDefinitionPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Text shown for a saved or draft advanced value in a text input. */
export function formatAdvancedValue(value: McpDraft["advanced"][string] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? "" : String(value);
}

/**
 * Draft value for typed advanced text. Parsing never alters what the user sees;
 * an unparseable number stays as its text so the backend reports it rather
 * than the draft silently dropping it.
 */
export function parseAdvancedText(
  type: McpAdvancedFieldSchema["type"],
  text: string,
): McpDraft["advanced"][string] {
  const trimmed = text.trim();
  if (type === "number") {
    if (!trimmed) return "";
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : text;
  }
  if (type === "string-list") {
    const items = trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : "";
  }
  return text;
}

/** Why typed advanced text cannot be saved, or null when it can. */
export function advancedTextProblem(field: McpAdvancedFieldSchema, text: string): string | null {
  if (field.type !== "number" || !text.trim()) return null;
  const value = Number(text.trim());
  if (!Number.isFinite(value)) return "Enter a number.";
  if (field.min !== undefined && value < field.min) return `Use ${field.min} or more.`;
  if (field.max !== undefined && value > field.max) return `Use ${field.max} or less.`;
  return null;
}

/**
 * Carry the user's edits onto a newer saved revision. Only fields the user
 * changed relative to `original` keep their draft value; everything else is
 * taken from `latest`, so another writer's change to an untouched field is not
 * reverted by the next save. Returns null when the draft cannot be carried
 * over: edited arguments that retain saved values by position.
 */
export function rebaseDraft(
  original: McpEditableDefinition,
  draft: McpDraft,
  latest: McpEditableDefinition,
): McpDraft | null {
  const changed = patchFromDraft(original, draft);
  if (changed.args && draft.args.some((arg) => arg.kind === "keep")) return null;
  const next = draftFromDefinition(latest);
  if (changed.transport) next.transport = draft.transport;
  if (changed.command) next.command = draft.command;
  if (changed.args) next.args = draft.args;
  if (changed.cwd) next.cwd = draft.cwd;
  if (changed.url) next.url = draft.url;
  if (changed.env) {
    next.env = draft.env;
    next.clearedEnv = draft.clearedEnv;
  }
  if (changed.headers) {
    next.headers = draft.headers;
    next.clearedHeaders = draft.clearedHeaders;
  }
  if (changed.advanced) {
    const advanced = { ...next.advanced };
    for (const key of Object.keys(changed.advanced.set ?? {})) {
      advanced[key] = draft.advanced[key] ?? "";
    }
    for (const key of changed.advanced.remove ?? []) advanced[key] = "";
    next.advanced = advanced;
  }
  return next;
}

/** Remove a saved env/header row: saved keys become an explicit clear. */
export function removeMapRow(draft: McpDraft, kind: "env" | "headers", id: string): McpDraft {
  const rows = draft[kind];
  const row = rows.find((candidate) => candidate.id === id);
  const clearedKey = kind === "env" ? "clearedEnv" : "clearedHeaders";
  return {
    ...draft,
    [kind]: rows.filter((candidate) => candidate.id !== id),
    [clearedKey]: row?.originalKey ? [...draft[clearedKey], row.originalKey] : draft[clearedKey],
  };
}
