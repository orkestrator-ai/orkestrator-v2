interface SessionRefreshShimmerProps {
  active: boolean;
  agentLabel: string;
}

/** Keep the skeleton mounted so its height can collapse before leaving the flow. */
export function SessionRefreshShimmer({ active, agentLabel }: SessionRefreshShimmerProps) {
  return (
    <div className="session-refresh-reveal" data-active={active} aria-hidden={!active}>
      <div className="min-h-0 overflow-hidden">
        <div className="px-2 @sm:px-4">
          <div className="mx-auto max-w-3xl py-3" role={active ? "status" : undefined}>
            {active && <span className="sr-only">Refreshing {agentLabel} session…</span>}
            <div aria-hidden="true" className="session-refresh-shimmer flex flex-col gap-2">
              <div className="h-2 w-3/4 rounded-full bg-muted-foreground/10" />
              <div className="h-2 w-full rounded-full bg-muted-foreground/10" />
              <div className="h-2 w-1/2 rounded-full bg-muted-foreground/10" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
