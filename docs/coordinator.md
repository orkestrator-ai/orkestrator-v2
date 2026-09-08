# Project Coordinator

Select a project to open **Coordinator**, the default project page. Coordinator
can read and discuss the configured local checkout, search the code, and use
Orkestrator controls to delegate implementation to isolated worker environments.
It cannot edit the project checkout itself.

The repository toolbar shows the canonical path, branch, upstream freshness,
ahead/behind state, local changes, and any retained Git error. **Refresh** fetches
remote state. **Sync** performs only a fast-forward pull. Branch switching and
sync are disabled for dirty/conflicted repositories, an ongoing merge/rebase,
an occupied worktree branch, or an active coordinator turn. These buttons are
explicit user actions; the coordinator agent cannot invoke them.

Conversations and workflow links are durable. Leaving the page, switching to an
environment, reloading the renderer, or restarting the backend does not discard
them. Closing a conversation revokes its orchestration credential and closes its
mailbox without deleting provider history. If all conversations are closed, use
**New conversation**; Orkestrator does not silently recreate one.
Removing the project stops its Coordinator and deletes the isolated Coordinator
runtime, including retained Codex rollouts and attachments.

## Choosing an agent

A conversation has no agent until its first prompt. The composer offers every
platform this machine qualifies, with the repository default preselected, and
the first send binds the conversation to whichever was chosen. That binding is
one-way: the transcript and rollout belong to that platform, so a different one
means a new conversation. Re-assignment is allowed only while the first send has
not yet reached a provider, so a failed start does not strand the conversation.

A valid project local path is required. Control MCP may be disabled globally;
chat remains read-only and usable, while the page shows that delegation
controls are unavailable.

## Provider qualification

Coordinator runs against the project's real checkout, so how strongly a
platform holds the read-only boundary is a property worth naming rather than
flattening to available/unavailable. Each platform is offered at one of three
tiers, shown beside the picker when it carries a caveat:

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks the mutation whatever the agent attempts | Codex; Claude where its command sandbox is available; Pi |
| `provider-configured` | The SDK is told to deny, and exposes no way to verify it | OpenCode, Cursor |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Agent platforms → Coordinator safety level** chooses the weakest
tier this installation will offer. It defaults to `provider-configured`, which
is also the recommended level: `enforced` and `provider-configured` platforms
are offered, and `advisory` stays opt-in.

What each enforced platform actually does:

- **Codex** runs under a permission profile that denies the filesystem and the
  network inside the child process, with `sandbox: read-only`,
  `approvalPolicy: never`, and a private `CODEX_HOME` holding only `auth.json`.
  The bridge refuses to run a turn unless app-server echoes the profile back.
- **Claude** runs with the SDK command sandbox on and `allowUnsandboxedCommands`
  off, `permissionMode: dontAsk`, an allowlist that excludes every writing tool,
  `settingSources: []`, a private `CLAUDE_CONFIG_DIR` holding only the
  credential, and a bridge-owned `PreToolUse` hook. The hook is the real
  boundary for shell: it allows a fixed list of reading commands and refuses
  pipes, redirection, substitution and chaining, because a composed command is
  not the one that was checked. Where the host has no command sandbox — Windows
  — Claude drops to `provider-configured` automatically.
- **Pi** blocks every tool outside its read-only set in its own `tool_call`
  gate, which runs in the bridge process and cannot be switched off by the
  workspace.

OpenCode denies through its own permission rules and runs its `plan` agent, but
always loads the checkout's project configuration, including any MCP servers it
declares. Cursor applies the sandbox and a tool ban but exposes no approval
callback, and is refused outright if its sandbox cannot be enabled.

Every coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`. That is process
authority: the bridge replaces whatever policy a request body or a persisted
record carries, so a permissive record cannot survive a restart and widen a live
conversation.

## Attachments

Pasted images and other prompt attachments are staged under application data, in
a per-conversation directory, never in the checkout a coordinator may not write
to. A bridge otherwise confines an attachment path to its session's workspace,
so each coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT` naming that one directory as a second
readable root; Codex additionally grants it `read` in the conversation's
permission profile. Like the execution policy, this is process configuration —
a request body cannot name a root of its own — and it is scoped to the one
conversation, so a bridge cannot read another's attachments. Deleting the
project removes them with the rest of the coordinator runtime.

## Worker delegation

Delegation is a round trip, not one outbound call. `launch_environment` goes out
over MCP, and the worker's result comes back as agent mail — so a platform needs
both an MCP client and a native mailbox that can be injected into. **Delegation
is unavailable on Pi, Cursor and Grok**: Pi ships no MCP client, and Cursor and
Grok have no injectable mailbox, so a reply could be dispatched but never
delivered. On those platforms the coordinator prompt says worker controls are
unavailable rather than offering a tool whose answer never arrives; inspection
and planning work normally.

A platform's caveat is carried on its qualification `reason` and shown beside
the picker, so the limitation is readable when the platform is chosen rather
than discovered when a worker never reports back.

Worker delegation records an explicit base branch and commit. Uncommitted root
changes are not copied, stashed, or committed into a worker. A container worker
can start only from a commit published to a remote branch; unpublished commits
remain available to local workers. Coordinator mail, worker replies, and workflow
completion notices are durable and can wake an idle participant, but stored,
injected, acknowledged, and completed remain distinct states. Pause or mute
messaging, or set a mailbox's injection policy explicitly to **Off**, to hold
automatic delivery.
