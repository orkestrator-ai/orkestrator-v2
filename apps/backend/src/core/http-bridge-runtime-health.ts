/**
 * Reading a bridge's `/session/:id/runtime-health` body, and turning provider
 * diagnostics into the notices a session projection carries.
 *
 * Separate from `http-bridge-provider.ts` because it is pure: given a JSON body
 * it produces a bounded summary, with no connection, no session and no fetch.
 * That makes it directly testable, and keeps the provider module — which is
 * already at its reviewed size limit — about talking to bridges.
 */
import {
  NATIVE_AGENT_NOTICE_SEVERITIES,
  type NativeAgentNotice,
  type NativeAgentNoticeSeverity,
  type NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import {
  asRecord,
  normalizeProviderDrift,
  normalizeProviderRuntimeNotices,
  normalizeProviderRuntimeSummary,
  providerAdvisoryNotices,
  providerInventoryCount,
} from "./agent-provider-runtime.js";

/**
 * Codex reports drift as `protocol.unknownNotifications` plus the last method
 * names it did not recognise, which predates the shared `drift` field. Read it
 * into that shape rather than teaching the renderer a second spelling.
 */
export function codexProtocolDrift(value: unknown): unknown {
  const protocol = asRecord(value);
  if (!protocol) return undefined;
  const unknownEvents = protocol.unknownNotifications;
  if (typeof unknownEvents !== "number") return undefined;
  return {
    unknownEvents,
    unknownKinds: protocol.unknownMethods ?? protocol.unknownKinds ?? [],
  };
}

/**
 * The notices one interactive snapshot carries.
 *
 * Two sources, both bounded. The transport-limit warning is Orkestrator's own
 * and is about the transcript the user is looking at. Provider advisories —
 * deprecations, rerouted models, configuration warnings — are promoted out of
 * the health panel into the tab because that is where the user is when the
 * thing they are about happens; only `warning` and `error` cross, since an
 * `info` notice is inventory.
 */
export function snapshotNotices(options: {
  transcriptTruncated: boolean;
  runtime?: NativeAgentRuntimeSummary;
}): NativeAgentNotice[] {
  return [
    ...(options.transcriptTruncated
      ? [
          {
            kind: "warning" as const,
            message:
              "Earlier transcript content was omitted to stay within the 16 MiB transport limit.",
          },
        ]
      : []),
    ...providerAdvisoryNotices(options.runtime?.notices ?? []),
  ];
}

/**
 * Normalize a `/session/:id/runtime-health` body into the shared summary.
 *
 * Two shapes arrive here. The Codex bridge has served this route since before
 * the shared contract existed and answers with its own inventory —
 * `{ engine, mcp, skills, hooks, protocol, notices }` — where each notice is
 * one occurrence and grouping happens at this hop. Every other bridge answers
 * the shared `{ summary, notices }`, where the bridge's own recorder has
 * already grouped and bounded. Both are accepted, so gaining drift reporting
 * everywhere did not require reshaping the one bridge that already had it.
 */
export function bridgeRuntimeSummary(payload: unknown): NativeAgentRuntimeSummary | undefined {
  const health = asRecord(payload);
  if (!health) return undefined;
  const shared = asRecord(health.summary);
  if (shared) {
    const summary = normalizeProviderRuntimeSummary(shared) ?? {};
    // Notices travel beside the summary on the shared shape, so a bridge with
    // nothing but notices to report still produces a usable summary.
    const notices = normalizeProviderRuntimeNotices(health.notices);
    return { ...summary, ...(notices.length > 0 ? { notices } : {}) };
  }
  const hasLegacyCodexShape = [
    "engine",
    "mcp",
    "skills",
    "hooks",
    "protocol",
    "drift",
    "notices",
  ].some((key) => Object.hasOwn(health, key));
  if (!hasLegacyCodexShape) return undefined;
  const engine = asRecord(health.engine);
  const groupedNotices = new Map<
    string,
    NonNullable<NativeAgentRuntimeSummary["notices"]>[number]
  >();
  if (Array.isArray(health.notices)) {
    for (const candidate of health.notices.slice(-128)) {
      const item = asRecord(candidate);
      const message = item?.message;
      if (typeof message !== "string" || message.length === 0) continue;
      const bounded = message.slice(0, 1_000);
      const method =
        typeof item?.method === "string" && item.method.length > 0
          ? item.method.slice(0, 128)
          : undefined;
      const key = `${method ?? ""}\u0000${bounded}`;
      const existing = groupedNotices.get(key);
      const detail =
        typeof item?.detail === "string" && item.detail.length > 0
          ? item.detail.slice(0, 1_000)
          : undefined;
      const receivedAt =
        typeof item?.receivedAt === "string" && item.receivedAt.length > 0
          ? item.receivedAt.slice(0, 64)
          : undefined;
      const occurrences = [
        ...(existing?.occurrences ?? []),
        ...(detail || receivedAt
          ? [{ ...(detail ? { detail } : {}), ...(receivedAt ? { receivedAt } : {}) }]
          : []),
      ].slice(-5);
      // Reinsert repeated groups so the five-group limit follows the most
      // recent occurrence, not the first time that method appeared.
      if (existing) groupedNotices.delete(key);
      groupedNotices.set(key, {
        message: bounded,
        ...(method ? { method } : {}),
        count: (existing?.count ?? 0) + 1,
        severity: NATIVE_AGENT_NOTICE_SEVERITIES.includes(
          item?.severity as NativeAgentNoticeSeverity,
        )
          ? (item?.severity as NativeAgentNoticeSeverity)
          : "warning",
        // These are Codex's own diagnostics rather than this bridge's
        // observations about Codex, which is what `provider` means.
        source: "provider" as const,
        ...(occurrences.length > 0 ? { occurrences } : {}),
      });
    }
  }
  const drift = normalizeProviderDrift(health.drift ?? codexProtocolDrift(health.protocol));
  return {
    mcpServers: providerInventoryCount(health.mcp),
    skills: providerInventoryCount(health.skills),
    hooks: providerInventoryCount(health.hooks),
    ...(typeof engine?.state === "string" ? { state: engine.state.slice(0, 64) } : {}),
    ...(typeof engine?.codexVersion === "string"
      ? { version: engine.codexVersion.slice(0, 64) }
      : {}),
    ...(drift ? { drift } : {}),
    ...(groupedNotices.size > 0
      ? {
          notices: [...groupedNotices.values()].slice(-5).map(({ count, ...notice }) => ({
            ...notice,
            ...(count !== undefined && count > 1 ? { count } : {}),
          })),
        }
      : {}),
  };
}
