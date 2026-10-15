/**
 * Reads the release channel index and a release's requirements manifest.
 *
 * Every response is bounded, time-limited, and must come from a trusted host
 * after redirects (GitHub release downloads redirect to its asset CDN). The
 * manifest is accepted only when its SHA-256 matches the index and, once this
 * build embeds signing keys, when its Ed25519 signature verifies.
 */
import {
  MAX_RELEASE_CHANNEL_INDEX_BYTES,
  RELEASE_CHANNEL_INDEX_ASSET,
  RELEASE_CHANNEL_INDEX_TAG,
  RELEASE_DOWNLOAD_BASE_URL,
  parseReleaseChannelIndex,
  releaseAssetUrl,
  type ReleaseChannelEntry,
  type ReleaseChannelIndex,
} from "@orkestrator/protocol/release-channels";
import {
  MAX_RELEASE_REQUIREMENTS_BYTES,
  RELEASE_REQUIREMENTS_ASSET,
  RELEASE_REQUIREMENTS_SIGNATURE_ASSET,
  parseReleaseRequirementsBytes,
  sha256Hex,
  verifyReleaseRequirementsSignature,
  type ReleaseRequirements,
} from "@orkestrator/protocol/release-requirements";
import { UPDATE_FEED_URL_ENV } from "@orkestrator/protocol/updates";

export type UpdateFeedErrorCode =
  | "invalid-feed-url"
  | "untrusted-host"
  | "network"
  | "channel-index-unavailable"
  | "invalid-channel-index"
  | "requirements-unavailable"
  | "requirements-mismatch"
  | "requirements-invalid"
  | "signature-missing"
  | "signature-invalid"
  | "too-large";

export class UpdateFeedError extends Error {
  constructor(
    readonly code: UpdateFeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpdateFeedError";
  }
}

/** Hosts GitHub release downloads are served from, including after redirects. */
export const GITHUB_RELEASE_DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SIGNATURE_BYTES = 1024;

/**
 * The release download base: the GitHub default, or an override from the
 * environment for qualification against a staging repository or a local
 * server. An override must be HTTPS, or HTTP on loopback only.
 */
export function resolveFeedBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[UPDATE_FEED_URL_ENV]?.trim();
  if (!override) return RELEASE_DOWNLOAD_BASE_URL;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new UpdateFeedError("invalid-feed-url", `${UPDATE_FEED_URL_ENV} is not a URL`);
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new UpdateFeedError(
      "invalid-feed-url",
      `${UPDATE_FEED_URL_ENV} must be HTTPS (or HTTP on loopback)`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UpdateFeedError(
      "invalid-feed-url",
      `${UPDATE_FEED_URL_ENV} must be a plain base URL`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export type FeedFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type UpdateFeedOptions = {
  baseUrl?: string;
  fetch?: FeedFetch;
  /** Raw Ed25519 public keys; a non-empty list makes signatures mandatory. */
  signingKeys?: readonly string[];
  timeoutMs?: number;
};

export type UpdateFeed = {
  readonly baseUrl: string;
  fetchIndex(): Promise<ReleaseChannelIndex>;
  fetchRequirements(
    entry: Pick<ReleaseChannelEntry, "tag" | "version" | "requirementsSha256">,
  ): Promise<{ manifest: ReleaseRequirements; bytes: Uint8Array }>;
};

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UpdateFeedError("too-large", `The response is larger than ${maxBytes} bytes`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new UpdateFeedError("too-large", `The response is larger than ${maxBytes} bytes`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpdateFeedError("too-large", `The response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createUpdateFeed(options: UpdateFeedOptions = {}): UpdateFeed {
  const baseUrl = (options.baseUrl ?? RELEASE_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
  const doFetch: FeedFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const signingKeys = options.signingKeys ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trustedHosts = new Set<string>([...GITHUB_RELEASE_DOWNLOAD_HOSTS, new URL(baseUrl).host]);

  async function get(
    url: string,
    maxBytes: number,
    notFound: UpdateFeedErrorCode,
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new UpdateFeedError(
        "network",
        `Could not reach the release feed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The URL a redirect ended at decides trust, not the one we asked for.
    const finalUrl = new URL(response.url || url);
    if (!trustedHosts.has(finalUrl.host)) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateFeedError(
        "untrusted-host",
        `The release feed redirected to ${finalUrl.host}`,
      );
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateFeedError(notFound, `Not found: ${url}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateFeedError("network", `The release feed answered HTTP ${response.status}`);
    }
    return readBounded(response, maxBytes);
  }

  return {
    baseUrl,
    async fetchIndex() {
      const bytes = await get(
        releaseAssetUrl(RELEASE_CHANNEL_INDEX_TAG, RELEASE_CHANNEL_INDEX_ASSET, baseUrl),
        MAX_RELEASE_CHANNEL_INDEX_BYTES,
        "channel-index-unavailable",
      );
      try {
        return parseReleaseChannelIndex(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (error) {
        throw new UpdateFeedError(
          "invalid-channel-index",
          `The channel index is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async fetchRequirements(entry) {
      const bytes = await get(
        releaseAssetUrl(entry.tag, RELEASE_REQUIREMENTS_ASSET, baseUrl),
        MAX_RELEASE_REQUIREMENTS_BYTES,
        "requirements-unavailable",
      );
      if ((await sha256Hex(bytes)) !== entry.requirementsSha256) {
        throw new UpdateFeedError(
          "requirements-mismatch",
          `${entry.tag}'s requirements manifest does not match the checksum the channel index publishes`,
        );
      }
      if (signingKeys.length > 0) {
        const signature = await get(
          releaseAssetUrl(entry.tag, RELEASE_REQUIREMENTS_SIGNATURE_ASSET, baseUrl),
          MAX_SIGNATURE_BYTES,
          "signature-missing",
        );
        const valid = await verifyReleaseRequirementsSignature(
          bytes,
          new TextDecoder().decode(signature),
          signingKeys,
        );
        if (!valid) {
          throw new UpdateFeedError(
            "signature-invalid",
            `${entry.tag}'s requirements manifest signature does not verify`,
          );
        }
      }
      let manifest: ReleaseRequirements;
      try {
        manifest = parseReleaseRequirementsBytes(bytes);
      } catch (error) {
        throw new UpdateFeedError(
          "requirements-invalid",
          `${entry.tag}'s requirements manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (manifest.version !== entry.version) {
        throw new UpdateFeedError(
          "requirements-mismatch",
          `${entry.tag}'s requirements manifest is for ${manifest.version}`,
        );
      }
      return { manifest, bytes };
    },
  };
}
