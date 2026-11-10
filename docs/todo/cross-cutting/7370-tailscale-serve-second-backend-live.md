# A second backend's Tailscale Serve and the gateway port migration are unproved live

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, after the loopback half of
0996 task 3 ran in a disposable systemd container (record under Current
state). This file takes over what 0996 left open; 0996 is deleted.

### Tasks

1. **Serve across SIGKILL, update and reinstall**: a second backend published with Tailscale Serve comes back on the same URL after an unclean exit, an update and a reinstall, and never replaces a foreign Serve root. Status: open (needs a disposable VM on a tailnet).
2. **Publish the gateway port migration note**: ship the pending release note with the next release that contains the gateway port rule. Status: open.
3. **Reconnect an updated tailnet second service**: a custom-data-directory tailnet service installed without `--port` updates, is reconnected with `-- --port PORT`, and its saved remote connection works again. Status: open (depends on 2).

### 1. Serve across SIGKILL, update and reinstall

**Problem.** The Tailscale Serve half of the second-backend port rule has never run on a real tailnet. A second backend no longer defaults to 34121, so a Serve service whose port changes across an unclean exit has to recover its own Serve root, and the code for that has only unit tests.

**Context.** From 0996 task 1 ("How does a second backend keep Tailscale Serve working across an unclean exit?"). `service install --data-dir <other> -- --tailscale-serve` without `--port` writes a free port chosen at install with `--strict-gateway-port`; standalone Serve records ownership in `<data-dir>/standalone-serve.json` and replaces only a matching owned tailnet root; an older unit migrates from its last successful `backend-instance.json`. The living description is [Default gateway port](../../architecture/remote-gateway.md#default-gateway-port).

**Investigation.** 0996 task 3 step 5 was the only Serve step, and it needs a tailnet. The 2026-11-06 container run had no network at all (`--network none`, to avoid creating Docker networks on a host whose address pool is nearly full), so it covered steps 1 to 4 and 6 and skipped this one. Unit coverage: `packages/cli/tests/service-install.test.ts` ("a second backend's Tailscale Serve keeps one port across reinstalls") and the standalone Serve manager's tests.

**Decisions.**

- **Where to run it?**
  - **A disposable VM joined to a throwaway tailnet (or an ephemeral node key on the user's tailnet, with the user's approval) (recommended).**
    - Pros: exercises real `tailscale serve` state, including a foreign root left by another process.
    - Cons: needs a tailnet node the run may change; joining the user's tailnet is an outward-facing action that needs approval.
  - **A container with a userspace `tailscaled` on this host.**
    - Pros: no VM.
    - Cons: still needs a tailnet login, and a container with network needs a Docker network from the exhausted pool (to-do 7041).
- **What counts as a pass?**
  - **Same HTTPS URL after SIGKILL and after reinstall, no "Refusing to replace" in the log, the saved `--port` unchanged, and a planted foreign root left alone (recommended).**
    - Pros: covers both the recovery and the refusal.
    - Cons: planting a foreign root is one more step.
  - **Same URL after SIGKILL only.**
    - Pros: shortest.
    - Cons: never shows that a foreign root is refused.

### 2. Publish the gateway port migration note

**Problem.** A direct tailnet service on a custom data directory that was installed without `--port` moves to a free port when it updates, so a remote client saved on `:34121` loses it. Users learn that only from the release note.

**Context.** The note is written in [`releasing.md`](../../development/releasing.md#pending-release-note-gateway-port-migration), "Pending release note: gateway port migration", and has not been published.

**Investigation.** On 2026-11-06 `releasing.md` still carries the note as pending. Publishing a release is outward-facing and needs the user's approval; this file only tracks it.

**Decisions.**

- **How should it ship?**
  - **Copy the note into the next release's notes, then remove the pending section from `releasing.md` in the same change that records the release (recommended).**
    - Pros: the release skill already writes notes; one place says whether it shipped.
    - Cons: depends on someone remembering at release time.
  - **Print a one-time notice from the launcher on the first boot after the update.**
    - Pros: reaches the service's operator directly.
    - Cons: the operator is usually not reading the service log, and remote clients see nothing.

### 3. Reconnect an updated tailnet second service

**Problem.** The migration note tells users to reinstall with `-- --port PORT` and reconnect, but nobody has followed it end to end.

**Context.** 0996's outstanding work: qualify both a sole custom-data-directory tailnet service and a secondary one installed without `--port`.

**Investigation.** Not run: needs a tailnet and a release containing the port rule to update from an older one.

**Decisions.**

- **Which update path?**
  - **Install the last release before the port rule, update with `host update apply` to one after it, reconnect from host-side access with `-- --port PORT`, and confirm the saved remote connection (recommended).**
    - Pros: the path a real user takes.
    - Cons: needs both releases published and a remote client.
  - **Reinstall from a packed build over an older install.**
    - Pros: no published release needed.
    - Cons: skips the self-updater, which is what users go through.

## Current state

- Only the default data directory's backend defaults to gateway port 34121;
  others take a free port unless given `--port` or `ORKESTRATOR_GATEWAY_PORT`
  (`implicitGatewayPort`, `apps/backend/src/options.ts`). The fallback walk
  skips 34121, 34122, a configured `ORKESTRATOR_CONTROL_MCP_PORT` and the
  loopback client port (`fallbackSkippedPorts`,
  `apps/backend/src/gateway-lifecycle.ts`). Both were proved live on loopback
  on 2026-11-06 (below).
- `service install` prints the loopback client listeners; a service with
  local listeners but no remote browser address now says
  `address (no remote browser listener; see local listeners and the log)`
  instead of "no browser listener" (fixed 2026-11-06, see 0244's "Task 5: the
  loopback address line").
- The Serve recovery and the migration note are unproved live (tasks 1 to 3).

### 0996 task 3 record (2026-11-06)

Same container and build as
[0244](0244-second-backend-on-one-host.md)'s task 5 (Debian 13 systemd,
`--network none`, packed `orkestrator 2.36.5-beta` of `main` at `c1724ab74`,
services production-flavour with the Control MCP on). 34121 and 34122 were the
container's own ports.

| Step | Observed | Result |
| --- | --- | --- |
| 1. Second backend first: `service install --data-dir /var/tmp/ork-b --yes -- --host 127.0.0.1 --allow-non-tailscale-bind` | Output: "This is not the default data directory, so its gateway takes a free port that changes on each start. For a stable address, reinstall with `-- --port PORT`." and `local listeners http://127.0.0.1:32827/`. Descriptor gateway 32827, `controlMcp` 45819. `ss 'sport = :34121 or sport = :34122'` empty. | Pass |
| 2. Main backend second: `service install --yes -- --host 127.0.0.1 --allow-non-tailscale-bind` | `ss` named pid 275 on 34121 and 34122; `controlMcp` `{"running":true,"url":"http://127.0.0.1:34122/mcp"}`. | Pass |
| 3. Restart B three times | B's gateway moved 41477, 35215, 43063; the main backend stayed pid 275 on both fixed ports. | Pass |
| 4. Fallback walk | Both units stopped; `python3 -m http.server 34120 --bind 127.0.0.1` (pid 840) held 34120; `orkestrator serve --data-dir /var/tmp/ork-c --host 127.0.0.1 --allow-non-tailscale-bind --port 34120` logged `[gateway] port.fallback preferredPort=34120 port=34123` and listened on 34123, with nothing on 34121 or 34122. Holder stopped by its PID; the main unit then came up as pid 931 on 34121 and 34122. | Pass |
| 5. Tailscale Serve | Not run: no tailnet in the container. Moved to task 1. | Not run |
| 6. Clean up | `service uninstall --purge` for B and for the main service ("Removed systemd orkestrator-backend.service. Deleted /home/ork/.config/orkestrator-v2/backend."); then the container, its image and its one build-cache record were removed. | Done |

The foreground `serve` in step 4 exited by itself (`[backend] parent.exited`,
then `shutdown.finished code=0`, descriptor removed) once the `docker exec`
shell that started it ended, after the walk had been observed. That is the
backend's parent watchdog, not a fault.

## Outstanding work

Run tasks 1 and 3 in a disposable VM on a tailnet, never on a machine someone
works on:

1. **Serve.** `orkestrator service install --data-dir /var/tmp/ork-d --yes --
   --tailscale-serve --tailscale-serve-port 8443`. `/var/tmp/ork-d/backend/service.json`
   has a `--port`. SIGKILL the backend by the PID in its descriptor,
   confirming the PID's identity first. It comes back with the same URL and
   logs no "Refusing to replace". Reinstall and check the port is unchanged.
   Plant a foreign Serve root on another port and check a restart refuses to
   replace it.
2. **Existing no-port Serve unit.** Install with a release from before the
   port rule, keep its `backend-instance.json`, update, SIGKILL, then
   reinstall with a new pin. The HTTPS URL stays available.
3. **Migration.** For a sole custom-data-directory tailnet service and a
   secondary one, both installed without `--port`: update, reconnect from
   host-side access with `-- --port PORT`, and confirm the saved remote
   connection works.
4. Clean up with `orkestrator service uninstall --data-dir <dir> --purge` for
   each service, record the output here and re-rate the file.

## Constraints and rationale

- The default install keeps 34121 and 34122: remote machines are reached on
  34121 and external MCP clients on 34122.
- Agents never bind 34121 or 34122 on a shared host or run a backend against
  the real data directory; a disposable container or VM has its own ports.
- Joining a tailnet and publishing a release are outward-facing and need the
  user's approval.

## Related

- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md):
  the Control MCP half, qualified in the same run.
- [remote-gateway.md](../../architecture/remote-gateway.md#default-gateway-port),
  [host-updates.md](../../architecture/host-updates.md#standalone-service),
  [releasing.md](../../development/releasing.md#pending-release-note-gateway-port-migration).
- [Exhausted-pool and probe-network evidence](../../development/container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06):
  why the container run used no Docker network.

## Replaces

- `0996-second-backend-takes-default-gateway-port.md` (deleted 2026-11-06):
  its tasks 1 and 2 were done in code on 2026-10-31 and proved on loopback by
  its task 3 on 2026-11-06; its Tailscale Serve step and outstanding work are
  tasks 1 to 3 here. The durable behaviour is in
  [remote-gateway.md](../../architecture/remote-gateway.md#default-gateway-port).
