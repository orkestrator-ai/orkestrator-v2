/**
 * Fixtures for the update service tests: manifests, a channel index, a feed
 * that serves them from memory, and timers a test advances by hand.
 */
import {
  releaseChannelOfVersion,
  type ReleaseChannelEntry,
  type ReleaseChannelIndex,
} from "@orkestrator/protocol/release-channels";
import {
  serializeReleaseRequirements,
  sha256Hex,
  type ReleaseRequirements,
} from "@orkestrator/protocol/release-requirements";
import type { UpdateFeed } from "./update-feed.js";
import { UpdateFeedError } from "./update-feed.js";

export const COMMIT = "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567";

export function manifestFor(
  version: string,
  overrides: Partial<ReleaseRequirements> = {},
): ReleaseRequirements {
  return {
    schema: "orkestrator-release-requirements",
    schemaVersion: 1,
    version,
    channel: releaseChannelOfVersion(version) ?? "stable",
    commit: COMMIT,
    compatibility: { updateProtocol: 1, minClientVersion: "2.20.0", minBackendVersion: "2.20.0" },
    storage: {
      schemaVersion: 3,
      migrations: [{ version: 3, name: "record-shape-upgrade", reversible: false }],
    },
    permissions: { macos: [] },
    network: { egressHosts: [{ host: "github.com", purposes: ["updates"] }] },
    toolchain: { versions: { claude: "2.1.296" }, artifacts: [] },
    container: {
      image: "ghcr.io/orkestrator-ai/orkestrator-v2",
      tag: version,
      requiredImageCapabilities: { "workspace-prepare": 1 },
      imageCapabilities: { "workspace-prepare": 1 },
    },
    ...overrides,
  };
}

export async function entryFor(
  manifest: ReleaseRequirements,
  publishedAt = "2026-10-15T00:00:00.000Z",
): Promise<ReleaseChannelEntry> {
  return {
    version: manifest.version,
    tag: `v${manifest.version}`,
    publishedAt,
    requirementsSha256: await sha256Hex(serializeReleaseRequirements(manifest)),
  };
}

export type FakeFeed = UpdateFeed & {
  publish(manifest: ReleaseRequirements): Promise<ReleaseChannelEntry>;
  failIndexWith: UpdateFeedError | null;
  indexFetches: number;
};

/** Serves the newest published manifest of each channel, like channels.json would. */
export function createFakeFeed(
  baseUrl = "https://github.com/orkestrator-ai/orkestrator-v2/releases/download",
): FakeFeed {
  const manifests = new Map<string, ReleaseRequirements>();
  const channels: ReleaseChannelIndex["channels"] = { stable: null, beta: null, unstable: null };
  const feed: FakeFeed = {
    baseUrl,
    failIndexWith: null,
    indexFetches: 0,
    async publish(manifest) {
      const entry = await entryFor(manifest);
      manifests.set(entry.tag, manifest);
      channels[manifest.channel] = entry;
      return entry;
    },
    async fetchIndex() {
      feed.indexFetches += 1;
      if (feed.failIndexWith) throw feed.failIndexWith;
      return {
        schema: "orkestrator-release-channels",
        schemaVersion: 1,
        repository: "orkestrator-ai/orkestrator-v2",
        generatedAt: "2026-10-15T00:00:00.000Z",
        channels: structuredClone(channels),
      };
    },
    async fetchRequirements(entry) {
      const manifest = manifests.get(entry.tag);
      if (!manifest) throw new UpdateFeedError("requirements-unavailable", `no ${entry.tag}`);
      return {
        manifest: structuredClone(manifest),
        bytes: new TextEncoder().encode(serializeReleaseRequirements(manifest)),
      };
    },
  };
  return feed;
}

type Pending = { id: number; due: number; callback: () => void; repeat: number | null };

/** Timers that only run when a test advances the clock. */
export function createFakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, Pending>();
  const handle = (id: number) => ({ id, unref() {} }) as unknown as ReturnType<typeof setTimeout>;
  const idOf = (timer: unknown) => (timer as { id: number }).id;
  return {
    timers: {
      setTimeout(callback: () => void, ms: number) {
        const id = next++;
        pending.set(id, { id, due: now + ms, callback, repeat: null });
        return handle(id);
      },
      clearTimeout(timer: ReturnType<typeof setTimeout>) {
        pending.delete(idOf(timer));
      },
      setInterval(callback: () => void, ms: number) {
        const id = next++;
        pending.set(id, { id, due: now + ms, callback, repeat: ms });
        return handle(id) as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval(timer: ReturnType<typeof setInterval>) {
        pending.delete(idOf(timer));
      },
    },
    /** Runs every timer due within `ms`, in due order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.values()]
          .filter((entry) => entry.due <= until)
          .sort((left, right) => left.due - right.due)[0];
        if (!due) break;
        now = due.due;
        if (due.repeat === null) pending.delete(due.id);
        else due.due += due.repeat;
        due.callback();
      }
      now = until;
    },
    pendingCount: () => pending.size,
  };
}

/** Lets queued promise continuations run. */
export async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
