import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** macOS 13's Darwin version, in the format electron-updater compares to os.release(). */
export const MAC_UPDATE_MINIMUM_SYSTEM_VERSION = "22.0.0";

export function assertMacUpdateFeed(contents: string): void {
  const feed = Bun.YAML.parse(contents) as { minimumSystemVersion?: unknown } | null;
  if (feed?.minimumSystemVersion !== MAC_UPDATE_MINIMUM_SYSTEM_VERSION) {
    throw new Error("macOS update feed must require Darwin 22.0.0 before publication");
  }
}

/** Patch every generated macOS channel, including prerelease channels, before going public. */
export function prepareMacUpdateFeeds(directory: string): string[] {
  const files = readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]+-mac\.yml$/.test(name));
  if (files.length === 0) throw new Error("No generated macOS update feed found");
  return files.map((name) => {
    const file = path.join(directory, name);
    const contents = readFileSync(file, "utf8");
    const feed = Bun.YAML.parse(contents);
    if (typeof feed !== "object" || feed === null || Array.isArray(feed)) {
      throw new Error("Invalid macOS update feed");
    }
    const updated = Bun.YAML.stringify({
      ...feed,
      minimumSystemVersion: MAC_UPDATE_MINIMUM_SYSTEM_VERSION,
    });
    assertMacUpdateFeed(updated);
    writeFileSync(file, updated);
    return file;
  });
}
