/**
 * Release channels: which versions belong to which channel, how they order,
 * and how an installation resolves its next update from the channel index.
 *
 * Shared by the release tooling (`scripts/release-*.ts`), the backend update
 * service and the renderer, so it stays free of Node and Bun APIs. Design:
 * docs/architecture/release-channels-and-updates.md.
 */

export const RELEASE_CHANNELS = ["stable", "beta", "unstable"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = "stable";

export const RELEASE_REPOSITORY = "orkestrator-ai/orkestrator-v2";
/** Fixed prerelease whose `channels.json` asset is the channel index. */
export const RELEASE_CHANNEL_INDEX_TAG = "update-channels";
export const RELEASE_CHANNEL_INDEX_ASSET = "channels.json";
export const RELEASE_CHANNEL_INDEX_SCHEMA = "orkestrator-release-channels";
export const RELEASE_CHANNEL_INDEX_SCHEMA_VERSION = 1;
export const MAX_RELEASE_CHANNEL_INDEX_BYTES = 64 * 1024;
/** Default base every release asset URL is built from. */
export const RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/download`;
export const CONTAINER_IMAGE_REPOSITORY = `ghcr.io/${RELEASE_REPOSITORY}`;

const CHANNEL_RANK: Record<ReleaseChannel, number> = { stable: 0, beta: 1, unstable: 2 };

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === "string" && (RELEASE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Channels nest: a subscription receives every more conservative channel, so a
 * beta subscriber is never held on an older beta after a newer stable ships.
 */
export function channelIncludes(subscribed: ReleaseChannel, release: ReleaseChannel): boolean {
  return CHANNEL_RANK[release] <= CHANNEL_RANK[subscribed];
}

export function npmDistTagForChannel(channel: ReleaseChannel): "latest" | "beta" | "unstable" {
  return channel === "stable" ? "latest" : channel;
}

export function releaseTagForVersion(version: string): string {
  return `v${version}`;
}

export type SemverVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
};

const NUMERIC = /^(0|[1-9]\d*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** Strict semver 2.0.0: no `v` prefix, no leading zeros in numeric identifiers. */
export function parseSemver(version: string): SemverVersion | null {
  if (typeof version !== "string" || version.length > 256) return null;
  const match = SEMVER.exec(version);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  const build = match[5] ? match[5].split(".") : [];
  for (const identifier of prerelease) {
    if (!IDENTIFIER.test(identifier)) return null;
    // A numeric prerelease identifier must not have a leading zero.
    if (/^\d+$/.test(identifier) && !NUMERIC.test(identifier)) return null;
  }
  if (build.some((identifier) => !IDENTIFIER.test(identifier))) return null;
  const numbers = [match[1], match[2], match[3]].map(Number);
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  return {
    major: numbers[0]!,
    minor: numbers[1]!,
    patch: numbers[2]!,
    prerelease,
    build,
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    // Lengths first, so identifiers beyond Number's precision still order.
    if (left.length !== right.length) return Math.sign(left.length - right.length);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence: negative when `left` is older. Throws on a version that
 * is not strict semver, so a caller can never mistake garbage for "older".
 */
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a) throw new Error(`Not a semver version: ${JSON.stringify(left)}`);
  if (!b) throw new Error(`Not a semver version: ${JSON.stringify(right)}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const order = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (order !== 0) return order;
  }
  return 0;
}

const BETA_PRERELEASE = /^beta\.(0|[1-9]\d*)$/;
const UNSTABLE_PRERELEASE = /^unstable\.(\d{8})\.([1-9]\d*)\.g([0-9a-f]{7,40})$/;

/**
 * The channel a version is released on, or null when it is not a channel
 * version. Stable is `X.Y.Z`, beta `X.Y.Z-beta.N` and unstable
 * `X.Y.Z-unstable.<yyyymmdd>.<run>.g<sha>`. Build metadata, `alpha`, `rc` and
 * other shapes are refused so the tooling cannot publish to no channel.
 */
export function releaseChannelOfVersion(version: string): ReleaseChannel | null {
  const parsed = parseSemver(version);
  if (!parsed || parsed.build.length > 0) return null;
  if (parsed.prerelease.length === 0) return "stable";
  const prerelease = parsed.prerelease.join(".");
  if (BETA_PRERELEASE.test(prerelease)) return "beta";
  const unstable = UNSTABLE_PRERELEASE.exec(prerelease);
  if (unstable && isCalendarDate(unstable[1]!)) return "unstable";
  return null;
}

function isCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 2000 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function assertReleaseChannelVersion(version: string): ReleaseChannel {
  const channel = releaseChannelOfVersion(version);
  if (!channel) {
    throw new Error(
      `${JSON.stringify(version)} is not a release channel version. Use X.Y.Z (stable), ` +
        "X.Y.Z-beta.N (beta) or X.Y.Z-unstable.<yyyymmdd>.<run>.g<sha> (unstable).",
    );
  }
  return channel;
}

/**
 * The `X.Y.Z` an unstable build of `main` carries: `main`'s own core when it
 * is a prerelease (so unstable sorts above that beta and below its stable),
 * otherwise the next patch (so it sorts above the stable it contains).
 */
export function unstableBaseVersion(mainVersion: string): string {
  const parsed = parseSemver(mainVersion);
  if (!parsed) throw new Error(`main's version is not semver: ${JSON.stringify(mainVersion)}`);
  const patch = parsed.prerelease.length > 0 ? parsed.patch : parsed.patch + 1;
  return `${parsed.major}.${parsed.minor}.${patch}`;
}

export function unstableVersion(options: {
  mainVersion: string;
  /** UTC date of the build. */
  date: Date;
  /** `github.run_number`: monotonic per workflow, decides same-day order. */
  runNumber: number;
  commitSha: string;
}): string {
  if (!Number.isSafeInteger(options.runNumber) || options.runNumber < 1) {
    throw new Error("runNumber must be a positive integer");
  }
  const sha = options.commitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("commitSha must be a hex commit id");
  const date = options.date.toISOString().slice(0, 10).replaceAll("-", "");
  const version = `${unstableBaseVersion(options.mainVersion)}-unstable.${date}.${options.runNumber}.g${sha.slice(0, 7)}`;
  assertReleaseChannelVersion(version);
  return version;
}

/**
 * Container image tags for a release. Only a stable version moves `latest`,
 * `X.Y` and `X`; prereleases get their exact version and their channel tag.
 */
export function containerTagsForVersion(version: string, commitSha: string): string[] {
  const channel = assertReleaseChannelVersion(version);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("commitSha must be a full commit id");
  const parsed = parseSemver(version)!;
  const tags = [version];
  if (channel === "stable") {
    tags.push(`${parsed.major}.${parsed.minor}`, `${parsed.major}`, "latest", "stable");
  } else {
    tags.push(channel);
  }
  tags.push(`sha-${commitSha}`);
  return tags;
}

export type ReleaseChannelEntry = {
  version: string;
  tag: string;
  publishedAt: string;
  /** Lowercase hex SHA-256 of the release's `release-requirements.json`. */
  requirementsSha256: string;
};

export type ReleaseChannelIndex = {
  schema: typeof RELEASE_CHANNEL_INDEX_SCHEMA;
  schemaVersion: typeof RELEASE_CHANNEL_INDEX_SCHEMA_VERSION;
  repository: string;
  generatedAt: string;
  /** Newest published release of each channel alone; clients apply nesting. */
  channels: Record<ReleaseChannel, ReleaseChannelEntry | null>;
};

export class ReleaseFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseFeedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseChannelEntry(channel: ReleaseChannel, value: unknown): ReleaseChannelEntry | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ReleaseFeedError(`channels.${channel} must be an object or null`);
  const { version, tag, publishedAt, requirementsSha256 } = value;
  if (typeof version !== "string" || releaseChannelOfVersion(version) !== channel) {
    throw new ReleaseFeedError(`channels.${channel}.version is not a ${channel} version`);
  }
  if (tag !== releaseTagForVersion(version)) {
    throw new ReleaseFeedError(`channels.${channel}.tag does not match its version`);
  }
  if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) {
    throw new ReleaseFeedError(`channels.${channel}.publishedAt is not a timestamp`);
  }
  if (typeof requirementsSha256 !== "string" || !SHA256_HEX.test(requirementsSha256)) {
    throw new ReleaseFeedError(`channels.${channel}.requirementsSha256 is not a SHA-256`);
  }
  return { version, tag, publishedAt, requirementsSha256 };
}

/** Validates an untrusted channel index. Throws {@link ReleaseFeedError}. */
export function parseReleaseChannelIndex(value: unknown): ReleaseChannelIndex {
  if (!isRecord(value)) throw new ReleaseFeedError("The channel index is not an object");
  if (value.schema !== RELEASE_CHANNEL_INDEX_SCHEMA) {
    throw new ReleaseFeedError("The channel index has the wrong schema");
  }
  if (value.schemaVersion !== RELEASE_CHANNEL_INDEX_SCHEMA_VERSION) {
    throw new ReleaseFeedError(
      `Unsupported channel index schema version ${String(value.schemaVersion)}`,
    );
  }
  if (typeof value.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.repository)) {
    throw new ReleaseFeedError("The channel index repository is invalid");
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new ReleaseFeedError("The channel index generatedAt is not a timestamp");
  }
  if (!isRecord(value.channels)) throw new ReleaseFeedError("The channel index has no channels");
  const channels = {} as Record<ReleaseChannel, ReleaseChannelEntry | null>;
  for (const channel of RELEASE_CHANNELS) {
    channels[channel] = parseChannelEntry(channel, value.channels[channel] ?? null);
  }
  return {
    schema: RELEASE_CHANNEL_INDEX_SCHEMA,
    schemaVersion: RELEASE_CHANNEL_INDEX_SCHEMA_VERSION,
    repository: value.repository,
    generatedAt: value.generatedAt,
    channels,
  };
}

export type ChannelResolution =
  /** A newer release is available on the subscription. */
  | { kind: "update"; channel: ReleaseChannel; entry: ReleaseChannelEntry }
  | { kind: "up-to-date" }
  /**
   * The running version is on a channel the subscription no longer includes
   * and is newer than anything it does include. It stays put (never a silent
   * downgrade) until the subscription catches up; `newest` is what an
   * explicit "install latest now" would install.
   */
  | {
      kind: "waiting-for-channel";
      newest: { channel: ReleaseChannel; entry: ReleaseChannelEntry } | null;
    };

/** The newest entry among the channels a subscription includes. */
export function newestIncludedRelease(
  index: Pick<ReleaseChannelIndex, "channels">,
  subscribed: ReleaseChannel,
): { channel: ReleaseChannel; entry: ReleaseChannelEntry } | null {
  let newest: { channel: ReleaseChannel; entry: ReleaseChannelEntry } | null = null;
  for (const channel of RELEASE_CHANNELS) {
    const entry = index.channels[channel];
    if (!entry || !channelIncludes(subscribed, channel)) continue;
    if (!newest || compareReleaseVersions(entry.version, newest.entry.version) > 0) {
      newest = { channel, entry };
    }
  }
  return newest;
}

/** Decides what a subscription offers a running version. Never a downgrade. */
export function resolveChannelUpdate(options: {
  index: Pick<ReleaseChannelIndex, "channels">;
  subscribed: ReleaseChannel;
  currentVersion: string;
}): ChannelResolution {
  const newest = newestIncludedRelease(options.index, options.subscribed);
  if (newest && compareReleaseVersions(newest.entry.version, options.currentVersion) > 0) {
    return { kind: "update", ...newest };
  }
  const currentChannel = releaseChannelOfVersion(options.currentVersion);
  if (currentChannel && !channelIncludes(options.subscribed, currentChannel)) {
    return { kind: "waiting-for-channel", newest };
  }
  return { kind: "up-to-date" };
}

/** URL of a release asset, under the default or an overridden download base. */
export function releaseAssetUrl(tag: string, asset: string, baseUrl = RELEASE_DOWNLOAD_BASE_URL) {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}
