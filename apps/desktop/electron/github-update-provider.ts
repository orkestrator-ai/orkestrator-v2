import type { OutgoingHttpHeaders } from "node:http";
import {
  parseXml,
  type CancellationToken,
  type CustomPublishOptions,
  type XElement,
} from "builder-util-runtime";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { hostUpdateChannelOfVersion } from "@orkestrator/protocol/host-maintenance";
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

const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_FEED_ENTRIES = 256;

/** GitHub orders Atom entries by publication, while channels promise version order. */
export function orderReleaseFeed(xml: string): string {
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
        version: tag && hostUpdateChannelOfVersion(tag) ? tag.replace(/^v/, "") : null,
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

/** Keep upstream artifact resolution and stable-feed fallback; change only traversal order. */
export class VersionOrderedGitHubProvider extends GitHubProvider {
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
    return data && url.pathname.endsWith(".atom") ? orderReleaseFeed(data) : data;
  }
}
