/**
 * Why automatic switching stayed put when a limit stopped work: the account the
 * limit stopped, and what kept the machine off each other login. Logins, not
 * entries, so an account shown once is explained once.
 */
import { agentAccountLoginOf, type AgentAccountLogin } from "@orkestrator/protocol/agent-accounts";
import type {
  AgentAccountAutoSwitchLastKept,
  AutoSwitchBlockedAccount,
} from "@orkestrator/protocol/agent-account-auto-switch";

function describeBlocker(blocked: AutoSwitchBlockedAccount): string {
  const used = blocked.usedPercent === undefined ? "" : ` ${Math.round(blocked.usedPercent)}% used`;
  const known = blocked.stale ? " (last known; it could not be read again)" : "";
  switch (blocked.blocker) {
    case "weekly":
      return `weekly limit${used}${known}`;
    case "five-hour":
      return `5-hour limit${used}${known}`;
    case "would-pay":
      return "past its plan allowance, so more use would be billed";
    case "same-login":
      return "the same login that ran out";
  }
}

function formatWhen(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AutoSwitchKeptNote({
  kept,
  logins,
}: {
  kept: AgentAccountAutoSwitchLastKept;
  logins: readonly AgentAccountLogin[];
}) {
  const from = agentAccountLoginOf(logins, kept.fromAccountId);
  const reasons = new Map<AgentAccountLogin, AutoSwitchBlockedAccount>();
  for (const blocked of kept.blocked) {
    const login = agentAccountLoginOf(logins, blocked.accountId);
    if (!login || login === from) continue;
    const previous = reasons.get(login);
    // A twin's own limit says more than "same login".
    if (!previous || previous.blocker === "same-login") reasons.set(login, blocked);
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="auto-switch-kept">
      <p className="text-amber-500">
        Stayed on {from?.account.label ?? "the active account"} at {formatWhen(kept.at)}: a limit
        stopped work and no other included account had room.
      </p>
      {reasons.size > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {Array.from(reasons, ([login, blocked]) => (
            <li key={login.account.id}>
              {login.account.label}: {describeBlocker(blocked)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
