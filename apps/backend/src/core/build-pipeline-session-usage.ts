/**
 * Token usage for the build pipeline's own stage sessions: Build, Fix,
 * review-package preparation, a single review, consolidation, Address, Verify,
 * Ship and conflict resolution.
 *
 * Reviewers in a fan-out meter through the shared runner (`review-fanout.ts`),
 * which mirrors its count onto their sessions. Every other stage session is
 * observed by the pipeline itself, and is metered here from that same
 * observation, so the flow graph reads usage from the workflow record for
 * every node, not just reviewers.
 */

import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";

function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Wraps a pass's whole-transcript read so usage metering can share it.
 *
 * A provider that meters from its transcript (OpenCode) is only metered when
 * the pass already reads the body for its checkpoint; this never adds a read.
 */
export function sharedTranscriptRead(
  provider: Pick<BuildPipelineProvider, "messages">,
  sessionId: string,
): {
  read: () => Promise<readonly unknown[]>;
  taken: () => Promise<readonly unknown[]> | undefined;
} {
  let whole: Promise<readonly unknown[]> | undefined;
  return {
    read: () => (whole ??= provider.messages(sessionId)),
    taken: () => whole,
  };
}

/**
 * Copies the provider's cumulative session token count onto the session.
 *
 * The status observation's count wins; a provider that reports none meters
 * from the transcript this pass already read, when it read one. The count only
 * grows: a provider that briefly reports less (a bridge restart reloading its
 * total) does not take back usage already shown. Usage is presentation
 * metadata, so a meter that fails is logged and never fails the stage.
 *
 * Returns whether the session's count changed. The caller persists it on the
 * transcript cadence: a running turn's count moves on almost every poll.
 */
export async function recordPipelineSessionUsage(
  session: PipelineSession,
  provider: Pick<BuildPipelineProvider, "usageFromMessages">,
  observed: Pick<NativeAgentContextUsage, "sessionTokens"> | undefined,
  messages: Promise<readonly unknown[]> | undefined,
): Promise<boolean> {
  try {
    let reported = usageCount(observed?.sessionTokens);
    if (reported === undefined && provider.usageFromMessages && messages) {
      reported = usageCount(provider.usageFromMessages(await messages)?.sessionTokens);
    }
    if (reported === undefined) return false;
    const tokenCount = Math.max(session.tokenCount ?? 0, reported);
    if (session.tokenCount === tokenCount) return false;
    session.tokenCount = tokenCount;
    return true;
  } catch (error) {
    console.warn(
      "[build-pipeline] Reading stage session token usage failed:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
