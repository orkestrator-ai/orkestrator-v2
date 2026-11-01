import { useEffect, useState } from "react";
import { getNativeAgentSignInResend } from "@/lib/backend";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

/**
 * Whether the backend holds this tab's refused prompt to send again after a
 * sign-in. Asked once per not-logged-in notice (`noticeId`); no notice, a failed
 * read and a backend that predates the feature all answer `false`, so the card
 * then asks the user to resend rather than promising something that won't happen.
 */
export function useSignInResendPending(
  identity: { environmentId: string; agent: AgentPlatform; logicalSessionKey: string },
  noticeId: string | undefined,
): boolean {
  const { environmentId, agent, logicalSessionKey } = identity;
  const [answer, setAnswer] = useState<{ noticeId: string; pending: boolean } | null>(null);
  useEffect(() => {
    if (!noticeId || agent !== "claude") return;
    let cancelled = false;
    void getNativeAgentSignInResend({ environmentId, agent, logicalSessionKey }).then(
      (result) => {
        if (!cancelled) setAnswer({ noticeId, pending: result.pending });
      },
      () => {
        if (!cancelled) setAnswer({ noticeId, pending: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agent, environmentId, logicalSessionKey, noticeId]);
  return noticeId !== undefined && answer?.noticeId === noticeId && answer.pending;
}
