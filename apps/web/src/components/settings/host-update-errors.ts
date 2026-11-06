const SUMMARY_MAX_CHARS = 140;

const CHANNEL_FILE_PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/-mac\.yml$/, "macOS"],
  [/-linux(?:-[a-z0-9]+)?\.yml$/, "Linux"],
  [/\.yml$/, "Windows"],
];

function platformOfChannelFile(file: string): string | null {
  return CHANNEL_FILE_PLATFORMS.find(([pattern]) => pattern.test(file))?.[1] ?? null;
}

function truncate(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const cut = text.slice(0, SUMMARY_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * One short sentence for an updater error. electron-updater's messages carry
 * the request, response headers and stack, which belong behind "Details".
 */
export function summarizeUpdateError(error: string): string {
  const text = error.trim();
  const missingFile = text.match(
    /Cannot find (\S+) in the latest release artifacts \([^)]*\/releases\/download\/([^/\s]+)\//,
  );
  if (missingFile) {
    const platform = platformOfChannelFile(missingFile[1]!);
    return `${missingFile[2]} has no ${platform ? `${platform} ` : ""}update files yet; it may still be publishing.`;
  }
  if (/net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(text))
    return "Could not reach GitHub.";
  const status = text.match(/HttpError: (\d{3})\b/);
  if (
    /No published versions on GitHub/.test(text) ||
    (/Unable to find latest version on GitHub/.test(text) && status?.[1] === "404")
  )
    return "No published release was found on GitHub.";
  if (status) return `GitHub answered HTTP ${status[1]}.`;
  return truncate(text.split("\n", 1)[0]!.trim());
}

/** The full message, with the escaped newlines of its JSON-encoded parts restored. */
export function updateErrorDetails(error: string): string {
  return error.trim().replace(/\\n/g, "\n");
}
