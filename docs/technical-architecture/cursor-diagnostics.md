# Cursor stall investigation

Cursor now uses the [shared bridge diagnostics](bridge-diagnostics.md).
## Investigation on 2026-09-09

A Grok 4.6 review through Cursor SDK 1.0.31 stopped emitting persisted SDK
events at 08:27:27 UTC. The bridge remained responsive, with one shell call and
three task calls pending and no shell subprocess remaining. The equivalent
read-only Git diff completed independently in 13 ms. No terminal result or
exposed approval explained the wait.

The installed SDK drops upstream heartbeat frames before its public interaction
updates, and its persisted SDK messages collapse partial and started tool calls
into the same `running` status. Therefore those historical messages cannot
establish whether the tools actually began execution or locate the upstream
stall. The diagnostics preserve that distinction for future incidents without
changing cancellation, retry, approval, or timeout behaviour.
