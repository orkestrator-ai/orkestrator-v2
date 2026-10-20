/**
 * Fence info-string metadata.
 *
 * `title`, `file` and `filename` are display hints only. They never name a
 * file to write, and opening a real workspace file goes through the
 * environment-aware path resolver with its own checks. Values are stripped of
 * control and bidirectional-format characters and bounded so a hint cannot
 * disguise itself or grow a toolbar without limit.
 */

export interface FenceInfo {
  /** Normalized language identifier (lowercase), or null for a plain fence. */
  language: string | null;
  /** Safe display title from `title=`, else null. */
  title: string | null;
  /** Safe file hint from `file=` / `filename=`, else null. Display only. */
  fileHint: string | null;
}

const MAX_LANGUAGE_CHARACTERS = 40;
const MAX_HINT_CHARACTERS = 200;

/** C0/C1 controls, bidirectional embeddings/isolates/marks, zero-width joiners. */
const UNSAFE_DISPLAY_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);

export function safeDisplayHint(value: string): string | null {
  const cleaned = value.replace(UNSAFE_DISPLAY_CHARACTERS, "").trim().slice(0, MAX_HINT_CHARACTERS);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * A file hint usable for "Open workspace file": a plain relative path inside
 * the environment's workspace. Absolute paths, drive letters, home or parent
 * segments and URLs are refused, so a hint cannot navigate outside the scoped
 * environment. The open itself still goes through the environment-aware file
 * tab and its own resolver; this never writes anything.
 */
export function workspaceRelativeFileHint(hint: string | null): string | null {
  if (!hint) return null;
  const path = hint.replace(/:\d+(?::\d+)?$/, "");
  if (!path || path.length > MAX_HINT_CHARACTERS) return null;
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path) || path.startsWith("~")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null;
  if (/[*?"<>|]/.test(path)) return null;
  if (path.split(/[\\/]+/).some((segment) => segment === ".." || segment === "")) return null;
  return path;
}

export function normalizeFenceLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const normalized = lang
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]/g, "")
    .slice(0, MAX_LANGUAGE_CHARACTERS);
  return normalized.length > 0 ? normalized : null;
}

/** `key="value"`, `key='value'` or `key=value` pairs from a fence's meta string. */
function metaAttributes(meta: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=]+))/g;
  for (const match of meta.matchAll(pattern)) {
    const key = match[1]!.toLowerCase();
    if (attributes.has(key)) continue;
    attributes.set(key, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

export function parseFenceInfo(
  lang: string | null | undefined,
  meta: string | null | undefined,
): FenceInfo {
  const attributes = meta ? metaAttributes(meta) : new Map<string, string>();
  const title = attributes.has("title") ? safeDisplayHint(attributes.get("title")!) : null;
  const fileRaw = attributes.get("filename") ?? attributes.get("file");
  return {
    language: normalizeFenceLanguage(lang),
    title,
    fileHint: fileRaw === undefined ? null : safeDisplayHint(fileRaw),
  };
}
