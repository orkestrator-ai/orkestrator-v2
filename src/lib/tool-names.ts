/** Tool names that represent file-editing operations across different AI coding agents */
export const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "file_edit",
  "notebookedit",
  "str_replace_editor",
  "create_file",
  "insert",
  "replace",
]);

const TOOL_DISPLAY_NAMES = new Map<string, string>([
  ["bash", "run_command"],
]);

function formatToolDisplayLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return label;

  const hasWordSeparators = /[_-]|\s/.test(trimmed);
  const isLowercaseIdentifier = /^[a-z][a-z0-9]*$/.test(trimmed);

  if (!hasWordSeparators && !isLowercaseIdentifier) {
    return trimmed;
  }

  return trimmed
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9]+$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Check if a tool name is a file-editing tool */
export function isEditTool(toolName?: string): boolean {
  if (!toolName) return false;
  return EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}

/** Return the user-facing label for a tool while preserving raw names internally. */
export function getToolDisplayName(toolName?: string, fallback = "Unknown tool"): string {
  if (!toolName) return fallback;
  return formatToolDisplayLabel(
    TOOL_DISPLAY_NAMES.get(toolName.toLowerCase()) ?? toolName,
  );
}
