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

/** Check if a tool name is a file-editing tool */
export function isEditTool(toolName?: string): boolean {
  if (!toolName) return false;
  return EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}

/** Return the user-facing label for a tool while preserving raw names internally. */
export function getToolDisplayName(toolName?: string, fallback = "Unknown tool"): string {
  if (!toolName) return fallback;
  return TOOL_DISPLAY_NAMES.get(toolName.toLowerCase()) ?? toolName;
}
