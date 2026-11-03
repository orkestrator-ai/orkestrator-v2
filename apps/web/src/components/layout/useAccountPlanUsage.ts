import { useEffect, useState } from "react";
import { getAgentAccountUsage } from "@/lib/backend";
import { isAgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import type { NativeAgentAccountUsageWindow } from "@orkestrator/protocol/native-agent";

/**
 * The plan windows of the account a session runs on, read from the machine's
 * own plan-usage read rather than from the session.
 *
 * A coordinator's Claude CLI runs in a private, login-less config directory on
 * the account's access token alone, so it never reports the plan's limits the
 * way a worker's CLI does. The machine still knows them: the same per-account
 * read Settings shows for each account. Read while the panel is
 * open, and again whenever `refreshKey` changes (a turn ending, a restart), so
 * a long-open panel does not keep a reading from before the turn it watched.
 *
 * Returns the windows only for the account they were read for; a pending
 * first read, a failed read or an unavailable plan returns undefined, which
 * shows nothing rather than a guess.
 */
export function useAccountPlanUsage({
  enabled,
  platform,
  accountId,
  refreshKey,
}: {
  enabled: boolean;
  platform: string | undefined;
  accountId: string | undefined;
  refreshKey?: string;
}): NativeAgentAccountUsageWindow[] | undefined {
  const identity =
    enabled && accountId && isAgentAccountPlatform(platform)
      ? JSON.stringify([platform, accountId])
      : null;
  const [reading, setReading] = useState<{
    identity: string;
    windows: NativeAgentAccountUsageWindow[];
  } | null>(null);

  useEffect(() => {
    if (!identity || !accountId || !isAgentAccountPlatform(platform)) return;
    let cancelled = false;
    void getAgentAccountUsage(platform, accountId)
      .then((snapshot) => {
        if (cancelled) return;
        setReading({ identity, windows: snapshot.status === "ok" ? snapshot.windows : [] });
      })
      .catch(() => {
        if (!cancelled) setReading({ identity, windows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, identity, platform, refreshKey]);

  // A refresh of the same account keeps showing the previous reading until it lands.
  if (!identity || reading?.identity !== identity || reading.windows.length === 0) return undefined;
  return reading.windows;
}
