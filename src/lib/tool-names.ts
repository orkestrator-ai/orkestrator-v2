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

/** Normalize a tool label to a comparison key, or null when empty. */
export function normalizeToolLabelKey(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

/**
 * Humanize a tool title only when it is a redundant copy of the raw tool name
 * or content (e.g. "bash" -> "Run Command"). Genuinely descriptive titles, and
 * any title containing whitespace (such as a command line), are returned
 * verbatim so they are never mangled by title-casing.
 */
export function getToolTitleDisplayName(
  toolTitle?: string,
  toolName?: string,
  content?: string,
): string | undefined {
  if (!toolTitle) return undefined;

  const titleKey = normalizeToolLabelKey(toolTitle);
  const isIdentifierLike = titleKey !== null && !/\s/.test(titleKey);
  if (
    isIdentifierLike &&
    (titleKey === normalizeToolLabelKey(toolName) ||
      titleKey === normalizeToolLabelKey(content))
  ) {
    return getToolDisplayName(toolTitle);
  }

  return toolTitle;
}
