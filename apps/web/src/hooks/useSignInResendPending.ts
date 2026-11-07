import { useEffect, useState } from "react";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
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
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const { environmentId, agent, logicalSessionKey } = identity;
  const [answer, setAnswer] = useState<{ noticeId: string; pending: boolean } | null>(null);
  useEffect(() => {
    if (!noticeId || agent !== "claude") return;
    let cancelled = false;
    void backendForScope(backendScope)
      .getNativeAgentSignInResend({ environmentId, agent, logicalSessionKey })
      .then(
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
  }, [backendScope, agent, environmentId, logicalSessionKey, noticeId]);
  return noticeId !== undefined && answer?.noticeId === noticeId && answer.pending;
}
