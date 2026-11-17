import type {
  NativeAgentToolDetails,
  StorageService,
  NativeAgentProjectionInput,
} from "./native-agent-service-shared.js";
import path from "node:path";
import { stat } from "node:fs/promises";
import {
  nativeAgentSessionStorageKey,
  nonBlank,
  NATIVE_DETAIL_RECOVERY_TAIL_MESSAGES,
} from "./native-agent-service-shared.js";
import { isRemoteDetailRef, recoveryLiveWindow } from "./native-agent-remote-detail-recovery.js";
import { NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION } from "@orkestrator/protocol/native-agent";
import { readReadableHostFile } from "./path-safety.js";
import { transcriptMediaPins } from "./transcript-media-pins.js";
import { imageMimeType } from "./native-agent-projection-helpers.js";
import {
  type ToolDetailCacheEntry,
  type NativeAgentTranscriptProjectionHost,
  type NativeAgentProjectionContext,
} from "./native-agent-projection-context.js";

/**
 * Tool details on demand (`get_native_agent_tool_details`): a deferred body
 * from the shared detail cache, a provider-held body behind a summary locator
 * (fetched once per reference), a provider-reported image read through the
 * media pins, and the recovery of an evicted reference through a
 * `detail-recovery` full read or a summary read of the live window.
 */
export class NativeAgentToolDetailReads {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
  }

  /** In-flight provider reads of remote tool details, one per reference. */
  private readonly remoteToolDetailReads = new Map<string, Promise<NativeAgentToolDetails>>();

  /** Key count of the in-flight remote reads, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return { remoteToolDetailReads: this.remoteToolDetailReads.size };
  }

  /**
   * Fetch the exact provider body behind a summary locator. The bridge checks
   * the body still has the digest the summary was minted with, so this either
   * returns that revision or reports it gone — never a newer body under an
   * old reference.
   */
  private async resolveRemoteToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
    entry: {
      sessionKey: string;
      remote?: { providerSessionId: string; locator: string; resolved: boolean };
      bytes: number;
    },
  ): Promise<NativeAgentToolDetails> {
    const remote = entry.remote!;
    const provider = await this.host.provider(input);
    const result = provider.transcriptDetail
      ? await provider.transcriptDetail(remote.providerSessionId, remote.locator)
      : undefined;
    if (!result || result.status === "missing" || result.status === "expired") {
      // The cache may have evicted (and already un-counted) this entry while
      // the read was in flight; only remove what is still ours.
      this.context.parts.dropToolDetail(input.detailRef, entry);
      throw new Error("Native agent tool details are no longer available");
    }
    const details: NativeAgentToolDetails =
      result.status === "ok"
        ? { detailRef: input.detailRef, ...result.detail }
        : {
            detailRef: input.detailRef,
            toolError: "Tool details exceeded the deferred display limit.",
          };
    const bytes = Buffer.byteLength(JSON.stringify(details)) + remote.locator.length + 64;
    this.context.parts.replaceToolDetail(input.detailRef, entry, {
      sessionKey: entry.sessionKey,
      details,
      bytes,
      remote: { ...remote, resolved: true },
    });
    return details;
  }

  /**
   * Register an evicted provider-held reference again (0110). A raw `detail-recovery`
   * refresh cannot: raw rows carry no locator, so it would read the whole
   * transcript and still mint only inline references. Instead, in order:
   *
   * 1. the registration a cached row or direct history page kept, with no read;
   * 2. a summary read of the session's live window, which re-projects its rows.
   *
   * A row in neither place is gone until its page is loaded again; the caller
   * says so rather than retrying.
   */
  private async recoverRemoteToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
    sessionKey: string,
  ): Promise<ToolDetailCacheEntry | undefined> {
    const reregister = () =>
      this.context.parts.reregisterRemoteToolDetail(input.detailRef, sessionKey, this.host.now());
    const kept = reregister();
    if (kept) return kept;
    const liveWindow = recoveryLiveWindow(
      this.context.transcript.progressiveTranscriptCache.keys(),
      sessionKey,
    );
    const update = {
      environmentId: input.environmentId,
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
      viewVersion: NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
      liveWindow,
      forceSnapshot: true,
    } as const;
    // Bypass conditional reads locally; changing cached metadata would lose
    // its token when the recovered view hashes identically to the kept view.
    await this.context.transcript.getTranscriptUpdate(update, true).catch(() => undefined);
    return this.context.parts.toolDetail(input.detailRef) ?? reregister();
  }

  async getProjectionToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
  ): Promise<NativeAgentToolDetails> {
    this.host.assertProjectionInput(input);
    if (!nonBlank(input.detailRef) || input.detailRef.length > 128) {
      throw new Error("Native agent tool detail reference is invalid");
    }
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    let entry = this.context.parts.toolDetail(input.detailRef);
    const remote = isRemoteDetailRef(input.detailRef);
    if (!entry || entry.sessionKey !== sessionKey) {
      this.context.parts.pinToolDetail(input.detailRef);
      try {
        if (remote) {
          entry = await this.recoverRemoteToolDetails(input, sessionKey);
        } else {
          // Rebuild details from the bounded retained history as well as the
          // live tail. Otherwise expanding an older paged row after detail-cache
          // eviction could never make its reference resolvable again.
          await this.context.full.refreshProjection(
            {
              ...input,
              messageLimit: NATIVE_DETAIL_RECOVERY_TAIL_MESSAGES,
              representation: "detail-recovery",
            },
            true,
          );
          entry = this.context.parts.toolDetail(input.detailRef);
        }
      } finally {
        this.context.parts.unpinToolDetail(input.detailRef);
      }
    }
    if (!entry || entry.sessionKey !== sessionKey) {
      throw new Error(
        remote
          ? "Native agent tool details are no longer available. Reload the conversation to show them again."
          : "Native agent tool details are no longer available",
      );
    }
    this.context.parts.touchToolDetail(input.detailRef, entry);
    if (entry.remote && !entry.remote.resolved) {
      // Two views expanding the same row share one provider read. The key is
      // the session-scoped reference, so sharing never crosses sessions.
      const shared = this.remoteToolDetailReads.get(input.detailRef);
      if (shared) return shared;
      const read = this.resolveRemoteToolDetails(input, entry).finally(() => {
        if (this.remoteToolDetailReads.get(input.detailRef) === read) {
          this.remoteToolDetailReads.delete(input.detailRef);
        }
      });
      this.remoteToolDetailReads.set(input.detailRef, read);
      return read;
    }
    if (!entry.localImagePath) return entry.details;

    // The renderer presents only the opaque, session-scoped reference. The
    // path came from the provider transcript and cannot be replaced by the
    // caller, so this grants one exact lazy read instead of widening a shared
    // directory such as /tmp into a renderer-readable root.
    const localImagePath = entry.localImagePath;
    const readCurrentFile = async () => {
      const bytes = await readReadableHostFile(localImagePath, [path.dirname(localImagePath)]);
      const info = await stat(localImagePath).catch(() => null);
      return { bytes, ...(info ? { modifiedAt: info.mtime.toISOString() } : {}) };
    };
    // Reuse a successful read if saving it fails; reader failures still propagate.
    let currentRead: ReturnType<typeof readCurrentFile> | undefined;
    const readFile = () => (currentRead ??= readCurrentFile());
    // The reference is stable per message, part and path, so its first read
    // is saved and later reads show that copy even after the file changes.
    const pinned =
      typeof this.storage.getDataDir === "function"
        ? await transcriptMediaPins(this.storage.getDataDir())
            .pin(
              {
                environmentId: input.environmentId,
                logicalSessionKey: input.logicalSessionKey,
                messageId: input.detailRef,
                reference: `detail:${localImagePath}`,
              },
              readFile,
            )
            .catch(() => undefined)
        : undefined;
    const current = pinned ? undefined : await readFile();
    const bytes = pinned ? Buffer.from(pinned.bytes) : current!.bytes;
    return {
      ...entry.details,
      fileDataUrl: `data:${imageMimeType(localImagePath)};base64,${bytes.toString("base64")}`,
      ...(pinned
        ? {
            fileSnapshot: {
              status: pinned.status,
              capturedAt: pinned.capturedAt,
              ...(pinned.fileModifiedAt ? { fileModifiedAt: pinned.fileModifiedAt } : {}),
              ...(pinned.reason ? { reason: pinned.reason } : {}),
            },
          }
        : {
            fileSnapshot: {
              status: "live" as const,
              reason: "missing" as const,
              capturedAt: new Date(this.host.now()).toISOString(),
              ...(current?.modifiedAt ? { fileModifiedAt: current.modifiedAt } : {}),
            },
          }),
    };
  }
}
