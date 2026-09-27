/**
 * Immediate, local feedback for the server form. The backend stays
 * authoritative — it re-validates every request with the provider's own
 * rules — so this only mirrors the shared structural checks from the
 * protocol plus the target's advertised name rule. Messages never contain
 * the values being checked.
 */

import {
  validateMcpDefinitionInput,
  validateMcpDefinitionPatch,
  type McpDefinitionInput,
  type McpDefinitionPatch,
  type McpFieldError,
  type McpTargetCapabilities,
} from "@orkestrator/protocol/mcp-management";

import type { McpDraft } from "./mcp-draft";

function nameRuleErrors(name: string, capabilities: McpTargetCapabilities): McpFieldError[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  let rule: RegExp;
  try {
    rule = new RegExp(capabilities.nameRule.pattern);
  } catch {
    // An unparseable advertised rule is the backend's to enforce.
    return [];
  }
  // The rule's own description is already shown under the field.
  return rule.test(trimmed)
    ? []
    : [{ field: "name", message: "Not a valid name for this platform." }];
}

/** Rows the draft→request conversion would silently drop. */
function unnamedRowErrors(draft: McpDraft): McpFieldError[] {
  const errors: McpFieldError[] = [];
  const kinds: Array<"env" | "headers"> =
    draft.transport === "stdio" ? ["env"] : ["env", "headers"];
  for (const kind of kinds) {
    if (draft[kind].some((row) => !row.key.trim() && (row.mode === "keep" || row.value.trim()))) {
      errors.push({
        field: kind,
        message: kind === "env" ? "Every variable needs a name." : "Every header needs a name.",
      });
    }
  }
  return errors;
}

function unique(errors: McpFieldError[]): McpFieldError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.field}\u0000${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Errors for a new definition, before any backend request. */
export function localAddErrors(
  draft: McpDraft,
  input: McpDefinitionInput,
  capabilities: McpTargetCapabilities,
): McpFieldError[] {
  return unique([
    ...validateMcpDefinitionInput(input),
    ...nameRuleErrors(draft.name, capabilities),
    ...unnamedRowErrors(draft),
  ]);
}

/** Errors for an edit, checked on the minimal patch actually sent. */
export function localPatchErrors(draft: McpDraft, patch: McpDefinitionPatch): McpFieldError[] {
  return unique([...validateMcpDefinitionPatch(patch), ...unnamedRowErrors(draft)]);
}
