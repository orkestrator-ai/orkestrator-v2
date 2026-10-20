/**
 * Which inline `code` spans in transcript prose are file references.
 *
 * Prose links (`[label](src/app.ts:12)`) are explicit: the author chose to
 * link. Inline code is not, so every `code` span is a guess, and a wrong guess
 * turns an identifier, a host:port or a version string into a link that opens
 * a missing file. The rule is therefore deliberately narrower than the shared
 * parser (`parseLocalFileLinkTarget`, which accepts any bare word as a path):
 *
 * 1. The shared parser must accept the text, and it must carry a line number
 *    (`path:line`, `path:line:col` or a `#L10`/`#L10C4` fragment). A path
 *    without a line is far more often a mention than a pointer.
 * 2. The text is one token: no whitespace, no control characters, bounded
 *    length. An encoded space (`a%20b.ts`) is fine; the parser decodes it.
 * 3. The path has a directory component (`src/a.ts`, `./a.ts`, `C:\a.ts`,
 *    `/abs/a.ts`, `file:///…`). A bare `name.ext:12` is ambiguous with
 *    `example.com:443`, `obj.method:12` and similar, and a bare name opens
 *    relative to the workspace root, which is only a guess at its directory.
 * 4. The last segment looks like a file: an extension containing a letter
 *    (`a.ts`, not `v1.2`), a dotfile (`.env`), or a well-known extensionless
 *    build file (`Makefile`, `Dockerfile`, …).
 * 5. A relative path whose first segment looks like a host name
 *    (`example.com/a.ts:3`) is a URL without its scheme, not a file.
 *
 * The returned target is the shared parser's, so opening it goes through the
 * same environment-aware `MarkdownLink` path as a prose file link.
 */
import { parseLocalFileLinkTarget, type LocalFileLinkTarget } from "@/lib/chat/file-url";

/** Longest inline code span considered (paths beyond this are not references). */
export const MAX_INLINE_FILE_REFERENCE_LENGTH = 1024;

const EXTENSIONLESS_FILE_NAMES = new Set([
  "makefile",
  "dockerfile",
  "containerfile",
  "gemfile",
  "rakefile",
  "procfile",
  "justfile",
  "brewfile",
  "podfile",
  "vagrantfile",
  "jenkinsfile",
  "license",
  "readme",
]);

/** Top-level domains that make a leading `name.tld/` segment read as a host. */
const HOST_SUFFIX =
  /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|app|cloud|gov|edu|info|me|us|uk|de)$/i;

function hasDirectoryComponent(path: string): boolean {
  return /[\\/]/.test(path);
}

function looksLikeFileName(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  if (!name || name === "." || name === "..") return false;
  if (/^\.[A-Za-z0-9_][\w.-]*$/.test(name)) return true; // dotfile
  if (EXTENSIONLESS_FILE_NAMES.has(name.toLowerCase())) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1);
  return /^[A-Za-z0-9_+-]{1,16}$/.test(extension) && /[A-Za-z]/.test(extension);
}

function firstSegmentIsHost(path: string): boolean {
  if (/^(?:[A-Za-z]:)?[\\/]/.test(path) || path.startsWith(".")) return false;
  const first = path.split(/[\\/]/)[0] ?? "";
  return HOST_SUFFIX.test(first);
}

/**
 * The file target an inline code span names, or null when the span should
 * stay plain code. See the module comment for the rule and its reasons.
 */
export function inlineCodeFileReference(text: string): LocalFileLinkTarget | null {
  if (!text || text.length > MAX_INLINE_FILE_REFERENCE_LENGTH) return null;
  // One token only: whitespace or control characters mean prose or a command.
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return null;
  const target = parseLocalFileLinkTarget(text);
  if (!target?.lineNumber) return null;
  const { filePath } = target;
  if (!filePath || /[\u0000-\u001f\u007f<>"|?*]/.test(filePath.replace(/^[A-Za-z]:/, ""))) {
    return null;
  }
  if (!hasDirectoryComponent(filePath)) return null;
  if (!looksLikeFileName(filePath)) return null;
  if (firstSegmentIsHost(filePath)) return null;
  return target;
}
