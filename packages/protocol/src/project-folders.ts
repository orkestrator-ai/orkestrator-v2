/**
 * Sidebar project folders.
 *
 * A folder is not a record. It is the trimmed name carried on every project
 * that belongs to it, so the whole feature lives inside `projects.json` and
 * rides the existing `project` resource kind: one file, one snapshot revision,
 * one announce. Adding a second store would have given folder-only edits a
 * revision nothing reconciles against, which is exactly the missed-event gap
 * the manifest exists to close.
 *
 * The consequence is deliberate: a folder exists for exactly as long as a
 * project names it. Dragging the last project out removes the folder rather
 * than leaving an empty one behind.
 */

/** Bounds the stored name so one typed line cannot bloat every project record. */
export const MAX_PROJECT_FOLDER_NAME_LENGTH = 60;

/**
 * Reduces user input to the value stored on a project.
 *
 * Control characters are stripped rather than rejected: they arrive from
 * pasted text far more often than they are typed, and a paste that silently
 * loses an invisible character is better than a refusal the user cannot see
 * the cause of. Blank input means "no folder", which is how the composer
 * clears membership.
 */
export function normalizeProjectFolderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters and newlines arrive from pasted text far more often
  // than they are typed. Collapsing every run of them (and of whitespace) to a
  // single space keeps one typed line one typed line.
  const collapsed = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_PROJECT_FOLDER_NAME_LENGTH).trim() || null;
}

/**
 * Case- and width-insensitive key used to decide whether two names are one folder.
 *
 * Folding is deliberately locale-independent: this is an identity key, not a
 * display transform, and `toLocaleLowerCase` would fold `"I"` to `"\u0131"`
 * under a Turkish or Azeri host locale — splitting one folder into two on
 * those machines only.
 */
export function projectFolderKey(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

/** The minimum a record needs for folder grouping; both `Project` shapes satisfy it. */
export interface FolderedProject {
  id: string;
  folder?: string | null;
}

/**
 * Folder names in sidebar order, each spelled the way its first member spells
 * it. Typing an existing name in a different case joins that folder instead of
 * creating a near-duplicate beside it.
 */
export function listProjectFolderNames(projects: readonly FolderedProject[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const project of projects) {
    const folder = normalizeProjectFolderName(project.folder);
    if (!folder) continue;
    const key = projectFolderKey(folder);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(folder);
  }
  return names;
}

/**
 * Resolves typed input against the folders that already exist.
 *
 * Returns the existing spelling when the name matches one, the normalized new
 * name when it does not, and `null` for blank input.
 */
export function resolveProjectFolderName(
  input: unknown,
  projects: readonly FolderedProject[],
): string | null {
  const normalized = normalizeProjectFolderName(input);
  if (!normalized) return null;
  const key = projectFolderKey(normalized);
  for (const existing of listProjectFolderNames(projects)) {
    if (projectFolderKey(existing) === key) return existing;
  }
  return normalized;
}
