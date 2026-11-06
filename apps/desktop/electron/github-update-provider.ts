import type { OutgoingHttpHeaders } from "node:http";
import {
  parseXml,
  type CancellationToken,
  type CustomPublishOptions,
  type XElement,
} from "builder-util-runtime";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { hostUpdateChannelOfVersion } from "@orkestrator/protocol/host-maintenance";
import { createLogger } from "@orkestrator/protocol/logger";
import { isNewerVersion } from "@orkestrator/protocol/node/standalone-service";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serialize(element: XElement): string {
  const attributes = Object.entries(element.attributes ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
  return `<${element.name}${attributes}>${escapeXml(element.value)}${(element.elements ?? []).map(serialize).join("")}</${element.name}>`;
}

const log = createLogger("updater");

const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_FEED_ENTRIES = 256;
/** Releases one check may pass over while they are still being published. */
const MAX_UNREADY_RELEASES = 3;

/**
 * The tag of a release whose update files for this platform are missing.
 * GitHub's feed lists a tag as soon as it is pushed, while the release is
 * still a draft or its builds are still uploading.
 */
export function unreadyReleaseTag(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if ((error as Error & { code?: unknown }).code !== "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")
    return null;
  return /\/releases\/download\/([^/\s]+)\//.exec(error.message)?.[1] ?? null;
}

/**
 * GitHub orders Atom entries by publication, while channels promise version
 * order. Entries for `skippedTags` are dropped.
 */
export function orderReleaseFeed(
  xml: string,
  skippedTags: ReadonlySet<string> = new Set(),
): string {
  if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES)
    throw new Error("Release feed exceeds the size limit");
  const feed = parseXml(xml);
  if (feed.getElements("entry").length > MAX_FEED_ENTRIES)
    throw new Error("Release feed has too many entries");
  const releases = feed
    .getElements("entry")
    .map((entry) => {
      const tag = entry.elementOrNull("link")?.attributes?.href?.match(/\/tag\/(v?[^/]+)$/)?.[1];
      return {
        entry,
        version:
          tag && !skippedTags.has(tag) && hostUpdateChannelOfVersion(tag)
            ? tag.replace(/^v/, "")
            : null,
      };
    })
    .filter((release): release is { entry: XElement; version: string } => release.version !== null);
  releases.sort((a, b) =>
    isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0,
  );
  feed.elements = [
    ...(feed.elements ?? []).filter((element) => element.name !== "entry"),
    ...releases.map(({ entry }) => entry),
  ];
  return serialize(feed);
}

/**
 * Keep upstream artifact resolution and stable-feed fallback; change only
 * traversal order, and pass over a newest release that is not ready yet.
 */
export class VersionOrderedGitHubProvider extends GitHubProvider {
  private readonly skippedTags = new Set<string>();
  private stableTag: string | null = null;

  constructor(
    options: CustomPublishOptions,
    updater: ConstructorParameters<typeof GitHubProvider>[1],
    runtime: ConstructorParameters<typeof GitHubProvider>[2],
  ) {
    super(
      { ...options, provider: "github", owner: "orkestrator-ai", repo: "orkestrator-v2" },
      updater,
      runtime,
    );
  }

  protected override async httpRequest(
    url: URL,
    headers?: OutgoingHttpHeaders | null,
    token?: CancellationToken,
  ): Promise<string | null> {
    const data = await super.httpRequest(url, headers, token);
    if (data && url.pathname.endsWith(".atom")) {
      const ordered = orderReleaseFeed(data, this.skippedTags);
      this.stableTag =
        parseXml(ordered)
          .getElements("entry")
          .map(
            (entry) =>
              entry
                .element("link")
                .attribute("href")
                .match(/\/tag\/(v?[^/]+)$/)?.[1],
          )
          .find((tag) => tag && hostUpdateChannelOfVersion(tag) === "stable") ?? null;
      return ordered;
    }
    // Upstream Stable selection reads /latest independently of the Atom feed.
    // Retain its request failures, but select from the same ordered, filtered feed
    // as prerelease checks so an unready Stable release can be passed over too.
    if (data && url.pathname.endsWith("/releases/latest")) {
      return JSON.stringify({ ...JSON.parse(data), tag_name: this.stableTag });
    }
    return data;
  }

  override async getLatestVersion(): ReturnType<GitHubProvider["getLatestVersion"]> {
    // Every check starts over, so a release is offered as soon as it is ready.
    this.skippedTags.clear();
    this.stableTag = null;
    let firstUnready: unknown = null;
    for (;;) {
      try {
        return await super.getLatestVersion();
      } catch (error) {
        const tag = unreadyReleaseTag(error);
        if (tag && !this.skippedTags.has(tag) && this.skippedTags.size < MAX_UNREADY_RELEASES) {
          firstUnready ??= error;
          this.skippedTags.add(tag);
          log.info("release.not-ready", { tag });
          continue;
        }
        // Nothing older to fall back to: the unready release is the real answer.
        if (firstUnready && (tag || /No published versions/.test(String(error))))
          throw firstUnready;
        throw error;
      }
    }
  }
}
