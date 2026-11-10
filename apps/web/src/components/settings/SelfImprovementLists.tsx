import type {
  SelfImprovementRunSummary,
  SelfImprovementTheme,
  SelfImprovementTrackedItem,
} from "@orkestrator/protocol/self-improvement";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS, SettingsSectionHeader } from "./SettingsPageLayout";

/** Verdicts and statuses in words a person reads at a glance. */
const VERDICT_TEXT: Record<string, string> = {
  tracking: "Open",
  ignored: "Ignored",
  "awaiting-deploy": "Waiting for a release",
  "awaiting-evidence": "Watching the new version",
  improved: "Fixed",
  "partly-improved": "Partly better",
  unchanged: "Fix did not work",
  holding: "Still fixed",
  regressed: "Came back",
};

const STATUS_TEXT: Record<SelfImprovementTrackedItem["status"], string> = {
  tracking: "Open",
  fixed: "Done, checking",
  verified: "Confirmed fixed",
  ignored: "Ignored",
};

const FIX_WHERE_TEXT: Record<SelfImprovementTheme["fixWhere"], string> = {
  orkestrator: "Fix in Orkestrator",
  instructions: "Fix in instructions",
  provider: "Model behaviour",
  unclear: "Unclear",
};

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function KindBadge({ kind }: { kind: SelfImprovementTrackedItem["kind"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        kind === "insight" ? "bg-violet-500/15 text-violet-300" : "bg-sky-500/15 text-sky-300",
      )}
    >
      {kind === "insight" ? "insight" : "improvement"}
    </span>
  );
}

function TicketList({
  title,
  items,
  tone = "default",
}: {
  title: string;
  items: Array<{ ticket: string; label: string }>;
  tone?: "default" | "good" | "warn";
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p
        className={cn(
          "text-xs font-medium",
          tone === "good"
            ? "text-emerald-400"
            : tone === "warn"
              ? "text-amber-400"
              : "text-foreground",
        )}
      >
        {title}
      </p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {items.map((item) => (
          <li key={`${item.ticket}-${item.label}`} className="flex gap-2">
            <span className="shrink-0 font-mono text-zinc-400">#{item.ticket}</span>
            <span className="min-w-0 break-words">{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the last run did, in the order a person acts on it. */
export function LastRunDetails({
  run,
  titles = {},
}: {
  run: SelfImprovementRunSummary;
  /** Titles of tracked problems by signature, shown in place of the signature. */
  titles?: Record<string, string>;
}) {
  const label = (signature: string) => titles[signature] ?? signature;
  const bySignature = (items: Array<{ ticket: string; signature: string }>) =>
    items.map((item) => ({ ticket: item.ticket, label: label(item.signature) }));
  const conversations = run.conversations;
  const nothing =
    run.created.length +
      run.linked.length +
      run.verified.length +
      run.fixFailed.length +
      run.partly.length +
      run.markedFixed.length +
      run.reopenedFromBoard.length +
      run.ignoredDeleted.length +
      run.wouldCreate.length ===
    0;
  return (
    <div className="space-y-3">
      {run.outcome === "failed" ? (
        <p className="text-xs text-red-400">{run.error ?? "The run stopped before it finished."}</p>
      ) : null}
      <TicketList
        title="New tickets"
        items={run.created.map((item) => ({ ticket: item.ticket, label: item.title }))}
      />
      {run.wouldCreate.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-foreground">Would file (preview)</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {run.wouldCreate.map((item) => (
              <li key={item.signature}>{item.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <TicketList title="Fixed and confirmed" tone="good" items={bySignature(run.verified)} />
      <TicketList
        title="Fix did not work, moved back to the backlog"
        tone="warn"
        items={run.fixFailed.map((item) => ({ ticket: item.ticket, label: label(item.signature) }))}
      />
      <TicketList title="Partly better: your call" tone="warn" items={bySignature(run.partly)} />
      <TicketList
        title="Done on the board, now checking newer versions"
        items={bySignature(run.markedFixed)}
      />
      <TicketList title="Reopened on the board" items={bySignature(run.reopenedFromBoard)} />
      <TicketList
        title="Ticket deleted, ignored from now on"
        items={bySignature(run.ignoredDeleted)}
      />
      <TicketList title="Linked to existing tickets" items={bySignature(run.linked)} />
      {run.outcome === "succeeded" && nothing ? (
        <p className="text-xs text-muted-foreground">Nothing new to file and no fix to judge.</p>
      ) : null}
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {conversations.enabled ? (
          <p>
            Conversations: read {conversations.read} part{conversations.read === 1 ? "" : "s"},{" "}
            {conversations.notesAdded} new note{conversations.notesAdded === 1 ? "" : "s"},{" "}
            {conversations.themes} theme{conversations.themes === 1 ? "" : "s"} in the last 30 days
            {conversations.waiting > 0
              ? `, ${conversations.waiting} more waiting for the next run`
              : ""}
            {conversations.costUsd > 0
              ? `, about $${conversations.costUsd.toFixed(2)} at list prices`
              : ""}
            .
          </p>
        ) : null}
        {run.heldForTomorrow + conversations.heldForTomorrow > 0 ? (
          <p>
            {run.heldForTomorrow + conversations.heldForTomorrow} more problem(s) worth a ticket are
            waiting for tomorrow&apos;s limit.
          </p>
        ) : null}
        {run.belowBar > 0 ? <p>{run.belowBar} smaller signal(s) left without a ticket.</p> : null}
      </div>
      {conversations.errors.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-amber-400">
          {conversations.errors.map((error) => (
            <li key={error}>Conversation review: {error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TrackedTickets({ items }: { items: SelfImprovementTrackedItem[] }) {
  return (
    <section className="space-y-3" aria-labelledby="self-improvement-tracked">
      <SettingsSectionHeader title="Tracked tickets" headingId="self-improvement-tracked">
        Every problem with a ticket, and where its fix stands. Move a ticket to Done when its fix
        merges; delete it to ignore that problem from now on.
      </SettingsSectionHeader>
      <div className={SETTINGS_CARD_CLASS}>
        {items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No tickets yet. Run it to file the first ones.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {items.map((item) => (
              <li
                key={item.signature}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
              >
                <KindBadge kind={item.kind} />
                <span className="min-w-0 flex-[1_1_14rem] break-words text-sm text-foreground">
                  {item.title}
                </span>
                {item.ticket ? (
                  <span className="font-mono text-xs text-zinc-400">#{item.ticket}</span>
                ) : null}
                <span className="text-xs text-muted-foreground">{STATUS_TEXT[item.status]}</span>
                {item.verdict && item.verdict !== item.status ? (
                  <span className="text-xs text-muted-foreground">
                    · {VERDICT_TEXT[item.verdict] ?? item.verdict}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function Themes({ themes, enabled }: { themes: SelfImprovementTheme[]; enabled: boolean }) {
  return (
    <section className="space-y-3" aria-labelledby="self-improvement-themes">
      <SettingsSectionHeader
        title="Themes from your conversations"
        headingId="self-improvement-themes"
      >
        Friction a model found across your conversations: instructions you keep repeating,
        confusion, workarounds, mistakes you had to catch. Themes seen in two conversations, or one
        that blocked you, become insight tickets.
      </SettingsSectionHeader>
      <div className={SETTINGS_CARD_CLASS}>
        {themes.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {enabled
              ? "No themes yet. They appear after a run reads your conversations."
              : "The conversation review is off."}
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {themes.map((theme) => (
              <li key={theme.slug} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-[1_1_14rem] text-sm text-foreground">
                    {theme.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {FIX_WHERE_TEXT[theme.fixWhere]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {theme.conversations} conversation{theme.conversations === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{theme.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
