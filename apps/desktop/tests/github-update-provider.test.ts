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
  requestFailure?: { path: string; error: Error },
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
    if (requestFailure && url.includes(requestFailure.path)) throw requestFailure.error;
    if (url.includes(".atom"))
      return `<feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `<entry><title>${tag}</title><link href="https://github.com/orkestrator-ai/orkestrator-v2/releases/tag/${tag}"/><content>Notes &amp; details</content></entry>`).join("")}</feed>`;
    if (url.endsWith("/latest")) return JSON.stringify({ tag_name: tags.at(-1) });
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

test("Stable falls back past missing files and offers the newest release once ready", async () => {
  const unready = new Set(["v2.36.6"]);
  const { updater, request } = fixture("latest", "2.36.4", ["v2.36.5", "v2.36.6"], unready);
  expect((await updater.checkForUpdates())?.updateInfo.version).toBe("2.36.5");
  expect(request.mock.calls.some(([options]) => String(options.path).endsWith("/latest"))).toBe(
    true,
  );
  expect(
    request.mock.calls.some(([options]) => String(options.path).includes("/download/v2.36.6/")),
  ).toBe(true);
  unready.clear();
  const recovered = await updater.checkForUpdates();
  expect(recovered?.updateInfo.version).toBe("2.36.6");
  expect(recovered?.isUpdateAvailable).toBe(true);
});

test.each(["latest", "alpha"] as const)(
  "%s retry cap reports the newest unready tag",
  async (channel) => {
    const tags = ["v2.36.5", "v2.36.6", "v2.36.7", "v2.36.8", "v2.36.9"];
    const { updater, request } = fixture(channel, "2.36.4", tags, new Set(tags));
    await expect(updater.checkForUpdates()).rejects.toThrow(/download\/v2\.36\.9\//);
    const attemptedTags = new Set(
      request.mock.calls.flatMap(([options]) => {
        const match = /download\/(v[^/]+)\//.exec(String(options.path));
        return match ? [match[1]] : [];
      }),
    );
    expect(attemptedTags.size).toBe(4);
    expect(attemptedTags.has("v2.36.5")).toBe(false);
  },
);

test.each([new HttpError(503, "Unavailable"), new Error("ECONNRESET")])(
  "artifact failures other than 404 propagate without falling back: %s",
  async (error) => {
    const { updater, request } = fixture("latest", "2.36.4", ["v2.36.5", "v2.36.6"], new Set(), {
      path: "/download/v2.36.6/",
      error,
    });
    await expect(updater.checkForUpdates()).rejects.toBe(error);
    expect(
      request.mock.calls.some(([options]) => String(options.path).includes("/download/v2.36.5/")),
    ).toBe(false);
    expect(
      request.mock.calls.filter(([options]) => String(options.path).includes(".atom")),
    ).toHaveLength(1);
  },
);

test("a transient failure after skipping a release remains the reported failure", async () => {
  const error = new HttpError(503, "Unavailable");
  const { updater } = fixture("latest", "2.36.4", ["v2.36.5", "v2.36.6"], new Set(["v2.36.6"]), {
    path: "/download/v2.36.5/",
    error,
  });
  await expect(updater.checkForUpdates()).rejects.toBe(error);
});
