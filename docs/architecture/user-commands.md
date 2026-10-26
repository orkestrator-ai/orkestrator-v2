# User `!` commands and prompts that need the user

Status: Living. Keep aligned with `packages/protocol/src/user-commands.ts`,
`packages/protocol/src/human-prompts.ts`, `apps/backend/src/core/user-commands.ts`,
`apps/backend/src/core/human-prompt-registry.ts` and
`apps/backend/src/core/agent-human-prompt-monitor.ts`.

Two related features:

- **`!` commands.** A composer message that starts with `!` runs as a shell
  command *by the user*, as Claude Code's bash mode does. It is not an agent
  tool call.
- **Prompts that need the user.** Shell output that is waiting on a person (a
  sign-in link, a device code, "Press ENTER", a password or passphrase, an SSH
  host-key question) is detected and shown as an actionable item, in the tab
  where it happened and in the coordinator conversation that owns the worker.

## `!` commands

| Where you type it | Where it runs | As |
| --- | --- | --- |
| A native agent tab (any engine) in a local environment | The environment's worktree | The user's login shell, with managed binaries and the active agent accounts, as a terminal tab there gets |
| A native agent tab in a container environment | `/workspace` in the container (`docker exec -it -u node`) | The `node` user, as the agents there run |
| A coordinator conversation | The project's checkout on this node (`project.localPath`) | The user's own environment; see [coordinator.md](coordinator.md#user--commands) |

The renderer's composer (`AgentNativeTab.controller.tsx`, `submit`) parses the
draft with `parseUserCommand`. A `!` message never queues behind a running turn
and never reaches the agent's dispatch path. It calls the composer-only command
`run_user_command`. Literal sends, prepared prompts (launch and review prompts)
and a bare `!` are ordinary text. A tab with no agent yet refuses a `!` message
(nothing would show it, and no agent would hear of it). Attachments and
annotations are refused, because a command is text only.

**Process ownership.** `UserCommandService` owns each process in a PTY
(`spawnPty`). It keeps:

- the status (`running`, `exited`, `cancelled`, `failed`) and exit code;
- a raw output tail bounded to 64 KiB. It is normalised on read
  (`normalizeTerminalText`: escapes removed, carriage-return redraws resolved),
  so a progress bar never splits across chunks.

Limits: at most 20 commands per tab, never dropping a running command or one
the agent has not seen yet, and at most 4 starting or running at once per tab.
When all 20 records are unread or running, further commands are refused until
an agent message consumes context or a delivered record can be evicted.

**Controls.** `write_user_command_input` sends a line, or ENTER on its own; the
input is never stored, because it may be a password. `cancel_user_command`
sends Ctrl-C and then terminates the whole process tree. An unconfirmed
termination stays tracked and retryable; cancellation and cleanup report failure.
Container commands have a private session and inherited identity so termination
is confirmed inside the container, including descendants that ignore signals.

Environment deletion terminates an environment's commands before the worktree
is removed. A move refuses while one is running. Closing a tab or coordinator conversation stops its commands and clears its
prompts. Backend shutdown ends them all. Launch admission holds the environment
mutation fence through asynchronous setup and spawn; teardown invalidates
launches that have not spawned.

**Rendering.** `list_user_commands` is authoritative. The backend announces the
`user-command` resource (id `env-<environment>:<tab>`) when a command starts,
prints output (coalesced to one hint per 200 ms) or exits. `useUserCommands`
re-reads on each hint and on resync, and every 3 s while something runs, as a
safety net. Each command becomes a synthesized transcript row
(`withUserCommandRows`), placed by its start time. It renders as a
`UserCommandCard` with live output, the prompt it waits on, an input line and
Cancel. Because the state is the backend's, a hidden tab, a reloaded window or
another client shows the same cards.

**Telling the agent.** At the start of the tab's next ordinary prompt,
`NativeAgentService.dispatchAdmittedPrompt` prepends an
`<orkestrator-user-commands>` block. For each command it gives the command, the
working directory, how it ended, and bounded output: 8 KiB per command, 24 KiB
in total, keeping the end. Details:

- Fields are escaped JSON, including commands and metadata, so shell output
  cannot manufacture a closing delimiter or Markdown fence. The complete block
  fits the 24 KiB character budget; omitted records remain pending.
- In a coordinator prompt the block goes after the coordinator block.
- Provider commands (`/…`) are left untouched, because they parse the prompt's
  start.
- The commands are marked delivered only once that prompt is dispatched. A
  refused send offers them again, and an ambiguous one replays the same prompt.
- Acknowledgment names the snapshot revision; newer output or completion stays
  pending. A command delivered while still running is offered again once it ends.
- Replaying an ambiguous dispatch preserves exactly one block. Prepared prompt
  replacements, including attachment staging, retain that block.
- The transcript projection strips one leading block for display
  (`stripUserCommandContext`); the cards already show the commands.

**Who can call it.** Only the composer. The commands are not Control MCP tools
or agent tools. The backend never reads a leading `!` in prompt text as a
command, so an agent, a workflow or mail cannot use this to run something as
the user.

## Prompts that need the user

`detectHumanPrompt` (protocol, browser-safe) reads the last 16 KiB of output.
It is deliberately conservative:

- **Link.** A URL counts only on a known HTTPS sign-in host and path.
  Unknown hosts remain ordinary command output and never receive the primary
  Open action or a coordinator sign-in notice. Known hosts: npm login and auth, GitHub device and OAuth,
  Tailscale, Apple ID, Google, Microsoft device login, AWS SSO, Vercel, Claude
  and OpenAI OAuth, GitLab, Docker, Fly, Cloudflare. A docs link, a PR link or
  a preview URL is not a prompt.
- **Device code.** Labelled alphanumeric and uppercase alphabetic codes are
  recognized, including `ABCD-EFGH` and `ABCDEFGH`; ordinary prose is ignored.
- **Password, passphrase, PIN and username prompts.** These count only on the
  last, unterminated line, the line the process is reading on.
- **Host-key confirmation.** Only the "Are you sure you want to continue
  connecting" question counts.
- **A bare "Press ENTER"** counts only while the cursor is on it.
- **After exit,** nothing is waiting.

`human-prompts.test.ts` checks the detector against real output (npm web login,
npm publish auth, `gh auth login --web`, Tailscale SSH and `tailscale up`, Azure
device login, SSH host keys, sudo, ssh passphrase, git HTTPS credentials) and
against ordinary output it must ignore.

**One registry.** `HumanPromptRegistry` (backend, in memory) holds every
waiting prompt by source. It is fed by:

- **User commands:** a `HumanPromptScanner` per command. It is announced once
  per distinct prompt, and a sign-in link stays until the command exits or
  prints a new one.
- **Agent shell calls and background shells:** `AgentHumanPromptMonitor`.
  Every 5 s it reads a bounded no-touch `/session/:id/human-prompts` observation
  from each already-running bridge (OpenCode uses its streamed message cache).
  This scans output before display projection removes tool details, never
  reads the tab-facing snapshot, and never changes its cache window. It scans
  each working agent tab (at most 8 per pass, round-robin) and scans:
  - running shell tool calls' streamed output: Codex, Pi and Cursor stream it;
    OpenCode and Grok report it as their providers do;
  - running background shell tasks' output files. For a local environment the
    file is on this host; the path comes from the task or from the launch
    result ("Output is being written to: …"), and is remembered per task.
    Only the provider's own task files are opened
    (`/tmp/claude-<uid>/…/tasks/<id>.output`), with `O_NOFOLLOW | O_NONBLOCK`. Descriptor type checks reject FIFOs and
    other non-regular files; read deadlines keep later sessions progressing.

  A source is cleared when its call settles, its task ends, or the tab stops
  working.

Every change announces the `human-prompt` resource (id: the environment).
`list_human_prompts` is the read. Both ephemeral views reconcile on manifest
recovery and the shared safety cadence, including when no command is running.
A later ENTER chunk updates actionable state under the same notification
identity, without sending another coordinator notice.

**Surfaces.**

| Where | What |
| --- | --- |
| The command's own card (`!` commands) | Headline, Open link, the code (click to copy), Press ENTER; masked input for a password |
| The agent tab (agent commands) | `HumanPromptBanner` above the composer |
| The coordinator panel | `HumanPromptBanner` for every local worker environment the coordinator launched or delegated to, from any source |
| The coordinator model | One workflow notice per prompt (`CoordinatorService.noteWorkerHumanPrompt`), for agent commands only, sent to the main conversation with the link and code; tone `attention`, state `waiting` |

A user's own `!` command is not announced to the coordinator model: the user
is at that tab, and the panel shows it anyway. The notice is idempotent on the
prompt, so a redrawn or re-detected prompt is not sent twice. Mail cannot be
retracted, so the banners are the surfaces that clear.

**Waking the coordinator.** A worker whose turn ends while a prompt in its
environment waits is a hand-off to a person. `backgroundWorkDisposition` never
holds that turn end for background work (`workerNeedsHuman`), so the
coordinator wakes at once. A worker still in a foreground command that is
blocked on a prompt never ends its turn; the notice above is how the
coordinator hears.

## Engines

| | Claude | Codex | OpenCode | Pi | Cursor | Grok |
| --- | --- | --- | --- | --- | --- | --- |
| `!` commands | Y | Y | Y | Y | Y | Y |
| Agent context on next prompt | Y | Y | Y | Y | Y | Y |
| Foreground shell prompts | — (output only at the end) | Y | Partial (`state.output` only) | Y | Y | Snapshot when reported |
| Background shell prompts | Y, local environments | — | — | — | — | — |

## Known gaps

- Claude's foreground Bash streams no output, so a foreground command blocked
  on a prompt is not detected. Claude backgrounds long commands, which is
  covered for local environments.
- A container environment's Claude background task files are inside the
  container and are not read.
- OpenCode's live output (`state.metadata.output`) is not mapped into the
  transcript, so only what it reports in `state.output` is scanned.
- `!` commands end with the backend; nothing restores them after a restart.
- `!` commands run on the backend that owns the tab. They are not routed
  through a command node to a leaf.
