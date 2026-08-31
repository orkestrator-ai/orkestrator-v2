const CONTROL_PATH_CHARACTERS = /[\0\r\n]/;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:\//;

function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingSlashes(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_DRIVE_PREFIX.test(path);
}

/**
 * Resolve a file reference to the relative path accepted by the workspace file
 * APIs. Absolute references are accepted only when they are beneath the active
 * workspace root; traversal and unrelated absolute paths are rejected.
 */
export function resolveWorkspaceRelativeFilePath(
  filePath: string,
  workspaceRoot: string,
): string | null {
  if (!filePath || !workspaceRoot || CONTROL_PATH_CHARACTERS.test(filePath)) return null;

  const normalizedPath = normalizeSlashes(filePath);
  const normalizedRoot = trimTrailingSlashes(normalizeSlashes(workspaceRoot));
  let candidate = normalizedPath;

  if (isAbsolutePath(normalizedPath)) {
    if (!isAbsolutePath(normalizedRoot)) return null;

    const isWindowsPath = WINDOWS_DRIVE_PREFIX.test(normalizedPath);
    const isWindowsRoot = WINDOWS_DRIVE_PREFIX.test(normalizedRoot);
    if (isWindowsPath !== isWindowsRoot) return null;

    const comparablePath = isWindowsPath ? normalizedPath.toLowerCase() : normalizedPath;
    const comparableRoot = isWindowsRoot ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootPrefix = comparableRoot === "/" ? "/" : `${comparableRoot}/`;
    if (!comparablePath.startsWith(rootPrefix)) return null;

    candidate = normalizedPath.slice(rootPrefix.length);
  }

  if (!candidate || isAbsolutePath(candidate) || /^[A-Za-z]:/.test(candidate)) return null;

  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "..")) return null;

  const normalizedSegments = segments.filter((segment) => segment && segment !== ".");
  return normalizedSegments.length > 0 ? normalizedSegments.join("/") : null;
}
