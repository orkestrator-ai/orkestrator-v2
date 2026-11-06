# An open, idle Pi tab keeps its Pi session attached past the idle detach

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`, while running
[0049](0049-native-agent-idle-observation.md) task 7 (Pi) with a loopback
fake model on beelink.

### Tasks

1. **Find which reads of an idle Pi view refresh the bridge's idle clock**: name every route an open, idle Pi tab reaches through the backend and whether it touches `lastAccessed`. Status: open.
2. **Decide which of them count as liveness, and exempt the rest**: then rerun 0049's full detach wait for Pi. Status: open (depends on 1).

### 1. Find which reads of an idle Pi view refresh the bridge's idle clock

**Problem.** The Pi bridge releases an idle session's SDK handle after
10 minutes (`IDLE_DETACH_MS`, `bridges/pi-bridge/src/idle-detach.ts`), but
with its tab open and idle the session never detaches. 0049's full detach
wait (630 s) read `attached` on Pi's no-touch runtime read before the wait
and still `attached` 40 s after it, so the case failed. A detached session
frees its Pi SDK session and the MCP processes it holds; an attached one
keeps them for as long as any tab shows it.

**Context.** Loopback-model run, beelink, 2026-11-06, profile
`idleqa-0049-r2`, run `idleqa-0049-r2-pi`, Pi 1.4.0 on the scripted
`idleqa-fake/idleqa-1` model. During the wait the view made 7.4 reads a
minute (`get_native_agent_live_update` 47, `get_native_agent_discovery_update`
31), the backend read the group on every sweep (Pi has no observation
stream, by design D6) and emitted no invalidation. The sweep's own read is
`/activity`, which does not touch. Claude passed the same wait on 2026-11-06
(0049 task 10) because its detach follows the CLI's own idle window, not
these reads.

**Investigation.** The Pi bridge refreshes `state.lastAccessed` on every
session route except `/activity`, `/runtime-health`, `/dispatch`, steer
`dispatch` and GET `/commands` (`bridges/pi-bridge/src/http.ts`, the
"Liveness only" block). The backend's MCP discovery section reads
`GET /session/:id/mcp` (`apps/backend/src/core/http-bridge/catalog.ts`,
`mcpServers`), and an open view renews every discovery section every 30 s,
so that read alone keeps the session inside the 10-minute window. The
progressive projection path can also read `/session/:id/transcript`,
`/status` and `/config` (`apps/backend/src/core/http-bridge/progressive.ts`);
whether an idle view's conditional live update reaches them was not
determined. The repository rule for catalogue reads ("Catalogue reads are
metadata. They must not touch `lastAccessed`", AGENTS.md, native slash
commands) covers `/commands`, which is exempt; the MCP inventory is the same
kind of read and is not.

**Decisions.**

- **How to find every touching read?**
  - **Count, in the Pi bridge, which routes refreshed `lastAccessed` (route names only), and read the counts after an idle window (recommended).**
    - Pros: exact; content-free.
    - Cons: a small diagnostic surface.
  - **Reason from the backend code only.**
    - Pros: no code.
    - Cons: the conditional live-update path is hard to follow by hand.

### 2. Decide which of them count as liveness, and exempt the rest

**Problem.** Some reads arguably should keep a session warm (a user reading
the transcript), and some should not (an MCP inventory renewal).

**Context.** For Codex and Claude, AGENTS.md calls `/session/:id` and
`/status` liveness touches. No such rule exists for a background renewal of
a discovery section.

**Investigation.** Not started.

**Decisions.**

- **Which reads keep a Pi session attached?**
  - **Only reads a user's action causes (a prompt, a config change, opening the tab); background renewals and quiet reads never (recommended).**
    - Pros: an open but idle tab releases its SDK session after 10 minutes,
      as the design says; the next prompt re-attaches transparently.
    - Cons: a re-attach costs the first prompt after a long idle.
  - **Every tab-facing read, as now.**
    - Pros: no change; an open tab answers its next prompt warm.
    - Cons: an open tab holds the session and its MCP processes for ever.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md)
  task 7, which found this, and task 10 (the same wait for Claude).
- [7380-codex-idle-detach-observation.md](7380-codex-idle-detach-observation.md):
  the Codex half of the detach wait.
