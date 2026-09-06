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

Coordinator currently supports Codex. If another configured default is selected,
the page explains that its read-only boundary has not been qualified and does
not silently switch providers. A valid project local path is required. Control
MCP may be disabled globally; chat remains read-only and usable, while the page
shows that delegation controls are unavailable.

Worker delegation records an explicit base branch and commit. Uncommitted root
changes are not copied, stashed, or committed into a worker. A container worker
can start only from a commit published to a remote branch; unpublished commits
remain available to local workers. Coordinator mail, worker replies, and workflow
completion notices are durable and can wake an idle participant, but stored,
injected, acknowledged, and completed remain distinct states. Pause or mute
messaging, or set a mailbox's injection policy explicitly to **Off**, to hold
automatic delivery.
