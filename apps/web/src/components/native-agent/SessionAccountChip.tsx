/**
 * The account a Claude or Codex session runs on, beside the composer's model
 * picker.
 *
 * Shown only when it tells the user something: the session's machine holds
 * more than one login for the platform, so which one this session uses is not
 * obvious. It is highlighted while the session is still on an account other
 * than the machine's active one (it moves over the next time it starts work
 * while idle). Clicking it opens the agent information panel for machine-wide
 * account switching and a link to account management in Settings. Claude
 * reauthentication happens in Settings. Every read goes to this view's own
 * backend, the machine the session runs on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getNativeAgentSessionAccount, listAgentAccounts } from "@/lib/backend";
import { requestAgentInformation } from "@/lib/agent-information";
import { useAgentAccountsChanged } from "@/hooks/useAgentAccountsChanged";
import {
  isAgentAccountPlatform,
  type AgentAccountPlatform,
  type AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import { cn } from "@/lib/utils";

interface ChipView {
  label: string;
  title: string;
  /** The session is not on the machine's active account. */
  elsewhere: boolean;
}

/** `work@…` for an email, else the account's own label, kept short. */
export function shortAccountLabel(account: AgentAccountSummary): string {
  const email = account.identity.email;
  const at = email?.indexOf("@") ?? -1;
  if (email && at > 0) return `${email.slice(0, Math.min(at, 16))}@…`;
  return account.label.length > 18 ? `${account.label.slice(0, 17)}…` : account.label;
}

function fullAccountLabel(account: AgentAccountSummary): string {
  const email = account.identity.email;
  return email && email !== account.label ? `${account.label} (${email})` : account.label;
}

export function SessionAccountChip({
  environmentId,
  platform,
  refreshKey,
}: {
  environmentId: string;
  platform: string;
  /** Changes when the session may have moved to another account (a turn started or ended). */
  refreshKey?: unknown;
}) {
  if (!isAgentAccountPlatform(platform)) return null;
  return <Chip environmentId={environmentId} platform={platform} refreshKey={refreshKey} />;
}

function Chip({
  environmentId,
  platform,
  refreshKey,
}: {
  environmentId: string;
  platform: AgentAccountPlatform;
  refreshKey?: unknown;
}) {
  const [view, setView] = useState<ChipView | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const read = ++latest.current;
    const apply = (next: ChipView | null) => {
      if (latest.current === read) setView(next);
    };
    try {
      const snapshot = await listAgentAccounts();
      const accounts = snapshot.accounts.filter((account) => account.platform === platform);
      // With only the host login there is nothing to tell apart, and no
      // session read is needed.
      if (accounts.length < 2) return apply(null);
      const session = await getNativeAgentSessionAccount(environmentId, platform);
      if (session?.source !== "account" || !session.account) return apply(null);
      const account = session.account;
      const elsewhere = account.id !== snapshot.active[platform];
      const pending = session.pendingActive;
      apply({
        label: shortAccountLabel(account),
        title: [
          `Runs on ${fullAccountLabel(account)}`,
          pending
            ? `moves to ${fullAccountLabel(pending)} the next time it starts work while idle`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
        elsewhere,
      });
    } catch {
      // A backend without accounts, or one that cannot answer: nothing to show.
      apply(null);
    }
  }, [environmentId, platform]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load, refreshKey]);
  useAgentAccountsChanged(platform, () => void load());

  if (!view) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="session-account-chip"
      className={cn(
        "h-7 gap-1 px-2 text-xs font-normal",
        view.elsewhere ? "text-amber-400" : "text-muted-foreground",
      )}
      title={view.title}
      aria-label={`${view.title}. Open agent information`}
      onClick={() => requestAgentInformation()}
    >
      <UserRound className="h-3.5 w-3.5" />
      {view.label}
    </Button>
  );
}
