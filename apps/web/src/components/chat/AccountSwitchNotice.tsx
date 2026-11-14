import { memo } from "react";
import { ArrowRight, UserRoundCog } from "lucide-react";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";

/**
 * An automatic account switch as one quiet line: `Claude Code · mini ·
 * old@example.com → new@example.com`. The coordinator reads the full notice
 * with its next delivery; the person only needs to see what moved to what.
 */
export const AccountSwitchNotice = memo(function AccountSwitchNotice({
  mail,
  timestampLabel,
}: {
  mail: PeerMailPresentation;
  timestampLabel?: string;
}) {
  const notice = mail.notice;
  const accounts = notice?.accountSwitch;
  const machine = notice?.resource.label;
  return (
    <div
      className="px-2 py-0.5 @sm:px-4"
      data-account-switch-notice="true"
      data-mail-state={notice?.state}
      data-mail-tone={notice?.tone ?? "info"}
    >
      <div
        data-transcript-item="account-switch"
        className="mx-auto flex min-w-0 max-w-3xl items-center gap-1.5 rounded-md px-1 text-[11px] leading-5 text-muted-foreground"
        title={mail.subject}
      >
        <UserRoundCog className="size-3 shrink-0 text-sky-400" aria-hidden="true" />
        <span data-agent-chat-search-content="true" className="flex min-w-0 items-baseline gap-1.5">
          {accounts ? (
            <>
              <span className="shrink-0 font-medium text-foreground/75">{accounts.provider}</span>
              {machine ? <span className="shrink-0">· {machine}</span> : null}
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate">{accounts.from}</span>
                <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate font-medium text-foreground/75">
                  {accounts.to}
                </span>
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate">{mail.subject ?? "Account switched"}</span>
          )}
        </span>
        {timestampLabel ? (
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
            {timestampLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
});
