# OpenCode coordinator: the read-boundary plugin is absent under a user OPENCODE_CONFIG_DIR

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from
[6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3.

### Tasks

1. **Decide what a coordinator's OpenCode server does when the user set `OPENCODE_CONFIG_DIR`**: today it starts without the read-boundary plugin. Status: open.

### 1. Decide what a coordinator's OpenCode server does when the user set `OPENCODE_CONFIG_DIR`

**Problem.** A host OpenCode server gets its plugins (the credential plugin and,
for a coordinator, `orkestrator-coordinator-read-boundary.js`) through
`OPENCODE_CONFIG_DIR`. When the backend's own environment already sets that
variable, the launcher keeps the user's directory and installs neither
(`commands-servers.ts` logs `credential-plugin.skipped`). A coordinator then
keeps OpenCode's `external_directory` refusal of direct reads, but a link in the
checkout pointing into the data directory is read again.

**Context.** `writeHostOpenCodeCredentialPlugin` (`opencode-host-credential.ts`)
writes both plugins; `opencode-coordinator-read-boundary-live.test.ts` pins the
read through a link when the plugin is absent. OpenCode loads plugins from
every directory in its config chain, but only one `OPENCODE_CONFIG_DIR`.

**Investigation.** Not established: how many users set `OPENCODE_CONFIG_DIR`,
and whether OpenCode 1.19.5 offers another place to load a plugin from (for
example a `plugin` entry in `OPENCODE_CONFIG_CONTENT`) that would not replace
the user's directory.

**Decisions.**

- **What to do?**
  - **Load the plugin through a config entry that adds to the user's directory, if OpenCode 1.19.5 honours one, and refuse to start a coordinator server otherwise (recommended).**
    - Pros: keeps the user's configuration and never runs a coordinator without the check.
    - Cons: needs a live check of the config entry on the pinned binary.
  - **Refuse a coordinator server whenever `OPENCODE_CONFIG_DIR` is set.**
    - Pros: simple and fails closed.
    - Cons: a user with their own directory cannot run an OpenCode coordinator.
  - **Leave it and note it.**
    - Pros: no work; the direct read stays refused.
    - Cons: a checkout link reaches the data directory for those users.

## Related

- [6080](6080-x1-coordinator-trust-boundary-follow-ups.md) task 3
- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md)
