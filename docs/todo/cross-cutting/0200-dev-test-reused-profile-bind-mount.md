# A reset profile name fails to boot its container fixture on Docker Desktop

Checked against `main` at `930189337` (2026-10-26).

After `mise run dev:reset --profile <p>`, starting the same profile name again
with a container fixture failed twice in a row on Docker Desktop 29.9.2
(macOS, Apple Silicon):

```text
Error response from daemon: invalid mount config for type "bind": bind source path does not exist:
/host_mnt/Users/<user>/Library/Application Support/orkestrator-v2-dev/profiles/<p>/data/portable-inputs/<hash>/...
```

The first failure named a staged `claude-config` directory under a revision
the host listing showed as present; the second named the revision root. A
new profile name started cleanly at once with the same image, flags and
credentials.

## Current state

- Seen on 2026-10-26 with
  `mise run dev:test --profile <p> --fixture --fixture-environments local,container --credential-source claude --agent-platforms claude`:
  the first start of the name worked, stop and reset, a second start failed,
  reset, a third start failed; a fresh name worked.
- Not diagnosed. It looks like Docker Desktop's file sharing still holding
  state for the deleted directory tree, but that was not confirmed. Whether
  it also hits production (an environment whose staged inputs are removed
  and recreated at the same path) is unknown.

## Outstanding work

### Code

1. Reproduce outside the profile tooling: create, bind, delete and recreate a
   directory at the same path under `~/Library/Application Support`, then
   bind it again. If Desktop refuses the recreated path, decide whether
   staged-input revisions (or reset profiles) should never reuse a path, and
   whether production can hit it.

### Qualification

- Whatever the fix, a stop, reset and restart of one profile name with a
  container fixture boots.

## Constraints and rationale

- Agents reuse profile names (the docs suggest fixed names such as
  `claude-warm-qa`), so a failure here costs a confusing boot error rather
  than a wrong result.

## Open questions

- Is this Docker Desktop's virtiofs cache, or does `dev:reset` leave
  something behind that the staging code then trusts?

## Related

- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md)
  (where it was found).
