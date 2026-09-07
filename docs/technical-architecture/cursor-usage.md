# Cursor usage

Cursor usage is read from the SDK agent attached to the native session. After
each completed run, the Cursor bridge calls `agent.getUsage()` and projects
the provider's cumulative token and charged-cost totals into
`NativeAgentContextUsage`.

The provider's bounded `runs` list becomes the generic `turns` breakdown. Each
entry retains both undiscounted (`rawCostUsd`) and charged (`costUsd`) cost;
terminal run metadata adds the request id, model and duration when Cursor
reports them. Account totals use the generic `account` windows consumed by the
shared usage panel.

Opening the usage panel asks the bridge's `GET /session/:id/usage` route for a
fresh SDK snapshot. A failed or unavailable detailed read is supplementary and
does not make the transcript unavailable. Usage and the last twenty turn rows
are persisted with the session so a bridge or renderer reload does not erase
the breakdown.
