import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RequestOptions } from "node:http";
import { HttpError } from "builder-util-runtime";
import { AppImageUpdater } from "electron-updater";
import {
  VersionOrderedGitHubProvider,
  orderReleaseFeed,
  unreadyReleaseTag,
} from "../electron/github-update-provider.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  channel: "latest" | "beta" | "alpha",
  current: string,
  tags: string[],
  // Tags pushed before their release has uploaded any update files.
  unready: ReadonlySet<string> = new Set(),
) {
  const root = mkdtempSync(path.join(tmpdir(), "github-update-"));
  roots.push(root);
  const app = {
    version: current,
    name: "updater-test",
    isPackaged: true,
    appUpdateConfigPath: path.join(root, "app-update.yml"),
    userDataPath: root,
    baseCachePath: root,
    whenReady: async () => undefined,
    onQuit: () => undefined,
  };
  const updater = new AppImageUpdater(null, app);
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  updater.channel = channel;
  updater.allowDowngrade = false;
  updater.allowPrerelease = channel !== "latest";
  updater.logger = null;
  const request = mock(async (options: RequestOptions) => {
    const url = String(options.path);
    if (url.includes(".atom"))
      return `<feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `<entry><title>${tag}</title><link href="https://github.com/orkestrator-ai/orkestrator-v2/releases/tag/${tag}"/><content>Notes &amp; details</content></entry>`).join("")}</feed>`;
    if (url.endsWith("/latest")) return JSON.stringify({ tag_name: "v2.23.0" });
    const match = /\/download\/(v[^/]+)\/(.+\.yml)/.exec(url);
    if (!match) throw new Error(`Unexpected request ${url}`);
    if (unready.has(match[1]!)) throw new HttpError(404, "No such feed");
    const version = match[1]!.slice(1);
    // Each release supplies only its own channel feed, as the release builder does.
    const expected = version.includes("alpha")
      ? "alpha"
      : version.includes("beta")
        ? "beta"
        : "latest";
    if (!match[2]!.startsWith(expected)) throw new HttpError(404, "No such feed");
    return `version: ${version}\nfiles:\n  - url: app.AppImage\n    sha512: test\n    size: 1\n`;
  });
  Object.assign(updater, { httpExecutor: { request } });
  updater.setFeedURL({ provider: "custom", updateProvider: VersionOrderedGitHubProvider });
  return { updater, request };
}

test.each([
  ["alpha", "2.24.0-alpha.2"],
  ["beta", "2.23.1-beta.2"],
  ["latest", "2.23.0"],
] as const)(
  "real %s provider chooses the highest eligible version despite publication order",
  async (channel, expected) => {
    const { updater } = fixture(channel, "2.22.0", [
      "v2.23.0",
      "v2.24.0-alpha",
      "v2.23.1-beta.2",
      "v2.24.0-alpha.2",
    ]);
    const result = await updater.checkForUpdates();
    expect(result?.updateInfo.version).toBe(expected);
    expect(result?.updateInfo.releaseNotes).toBe("Notes & details");
    expect(result?.isUpdateAvailable).toBe(true);
  },
);

test.each(["alpha", "beta"] as const)(
  "real %s provider falls back to the stable release's latest feed",
  async (channel) => {
    const { updater, request } = fixture(channel, "2.23.0-alpha", [
      "v2.23.0",
      "v2.23.0-beta",
      "v2.23.0-alpha",
    ]);
    expect((await updater.checkForUpdates())?.updateInfo.version).toBe("2.23.0");
    const paths = request.mock.calls.map(([options]) => String(options.path));
    expect(paths.some((url) => url.includes(`/download/v2.23.0/${channel}-`))).toBe(true);
    expect(paths.some((url) => url.includes("/download/v2.23.0/latest-"))).toBe(true);
  },
);

test("moving from a prerelease to Stable never offers a downgrade", async () => {
  const { updater } = fixture("latest", "2.24.0-alpha", ["v2.23.0", "v2.24.0-alpha"]);
  const result = await updater.checkForUpdates();
  expect(result?.updateInfo.version).toBe("2.23.0");
  expect(result?.isUpdateAvailable).toBe(false);
});

test("release feed rewriting refuses excessive bytes or entry counts", () => {
  expect(() => orderReleaseFeed(" ".repeat(8 * 1024 * 1024 + 1))).toThrow("size limit");
  expect(() => orderReleaseFeed(`<feed>${"<entry/>".repeat(257)}</feed>`)).toThrow(
    "too many entries",
  );
});

test("a newest release without update files falls back to the one before it", async () => {
  const unready = new Set(["v2.36.6-beta"]);
  const { updater } = fixture(
    "alpha",
    "2.36.4-beta",
    ["v2.36.4-beta", "v2.36.5-beta", "v2.36.6-beta"],
    unready,
  );
  const result = await updater.checkForUpdates();
  expect(result?.updateInfo.version).toBe("2.36.5-beta");
  expect(result?.isUpdateAvailable).toBe(true);

  // The next check offers the release as soon as its files are uploaded.
  unready.clear();
  expect((await updater.checkForUpdates())?.updateInfo.version).toBe("2.36.6-beta");
});

test("a host already on the release before an unready one is up to date", async () => {
  const { updater } = fixture(
    "alpha",
    "2.36.5-beta",
    ["v2.36.5-beta", "v2.36.6-beta"],
    new Set(["v2.36.6-beta"]),
  );
  const result = await updater.checkForUpdates();
  expect(result?.updateInfo.version).toBe("2.36.5-beta");
  expect(result?.isUpdateAvailable).toBe(false);
});

test("with no ready release the check reports the newest missing files", async () => {
  const { updater } = fixture(
    "alpha",
    "2.36.4-beta",
    ["v2.36.5-beta", "v2.36.6-beta"],
    new Set(["v2.36.5-beta", "v2.36.6-beta"]),
  );
  await expect(updater.checkForUpdates()).rejects.toThrow(
    /Cannot find \S+ in the latest release artifacts \(\S+\/download\/v2\.36\.6-beta\//,
  );
});

test("only a missing channel file names an unready release", () => {
  const missing = Object.assign(
    new Error(
      "Cannot find latest-mac.yml in the latest release artifacts (https://github.com/o/r/releases/download/v2.36.6-beta/latest-mac.yml): HttpError: 404",
    ),
    { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" },
  );
  expect(unreadyReleaseTag(missing)).toBe("v2.36.6-beta");
  expect(unreadyReleaseTag(Object.assign(new Error(missing.message), { code: "OTHER" }))).toBe(
    null,
  );
  expect(unreadyReleaseTag("Cannot find")).toBe(null);
});
