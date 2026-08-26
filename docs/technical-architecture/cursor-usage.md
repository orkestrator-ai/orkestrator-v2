# Cursor account usage

Cursor account quota is read by `apps/backend/src/core/cursor-usage.ts`. The
renderer calls the backend command only when the information panel for a Cursor
tab is open. Credentials and exchanged bearer tokens never cross the backend
boundary.

The provider exchanges the configured Cursor user API key (or the API key from
Orkestrator's Cursor SDK login) for a short-lived access token, then calls the
unofficial `DashboardService` current-period and plan-info methods. Access
tokens are cached only until their reported JWT or exchange expiry, with an
expiry skew, and a rejected token is re-exchanged once.

Outcomes are cached, failures included, because the renderer refetches on every
panel open. A successful read is held for 60 seconds; a retryable failure for 10
seconds, long enough to absorb a burst of opens; a non-retryable one — a rejected
key, an account with no plan quota — for 10 minutes, because asking again sooner
cannot produce a different answer. Rotating the credential mints a new provider
and so discards all of it.

A request that exceeds the deadline is a `NETWORK_ERROR` naming the timeout,
whether it expired before the response headers or part-way through the body: the
deadline is this process's, and reporting it as malformed data would blame
Cursor for it. A body past the 1 MiB ceiling is a separate, non-retryable
`INVALID_RESPONSE` rather than a parse failure.

Cursor's response is normalized into the shared types in
`packages/protocol/src/cursor-usage.ts`. Missing fields stay missing; a response
without `planUsage` is an explicit `MISSING_PLAN_USAGE` result rather than zero
usage. The historical `autoPercentUsed`, `apiPercentUsed`, and
`totalPercentUsed` names are retained in the normalized metadata. Bucket labels
are separate from transport parsing and can be overridden with
`CURSOR_USAGE_AUTO_LABEL` and `CURSOR_USAGE_API_LABEL`.

Three parsing rules are easy to get backwards:

- **Percentages above 100 are kept, not discarded.** An account past its included
  allowance is the case the readout exists for. Dropping the value there removed
  the bar, and for a response carrying only percentages removed every field and
  reported a well-formed payload as `INVALID_RESPONSE`. Clamping happens at the
  progress bar, which positions its fill with `translateX` and would otherwise
  render an over-quota account as an *empty* track; the numeric label stays
  truthful.
- **`remaining` may be negative.** An overdrawn allowance reports a negative
  remainder, and the panel shows it as a signed amount. Omitting it would read
  as "no data" and clamping it to zero as "exactly used up".
- **Billing-cycle timestamps are range-checked.** Cursor reports epoch
  milliseconds, but `0` and second- or microsecond-scale values all parse as a
  valid `Date`. Anything outside 2020–2100 is treated as unreadable and omitted,
  rather than rendering to the user as a 1970 reset date.

## Live response note (2026-08-26)

A read-only check against a locally authenticated individual account confirmed
numeric billing-cycle timestamps, both historical percentage buckets, an
included limit and used amount, and on-demand data. That response omitted
`planUsage.remaining`, despite returning the other included fields. The UI
therefore intentionally omits “Included left” for that shape instead of deriving
or displaying a zero balance.

This account-level quota is independent of Cursor SDK `agent.getUsage()`. The
latter remains a per-agent billed token/cost metric and is displayed as session
usage, never as the monthly allowance.
