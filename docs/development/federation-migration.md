# Federation migration and rollback

> **Direction change (2026-10-21):** the target is
> [command-nodes.md](../architecture/command-nodes.md). The client-side
> device catalogue described here is transitional: the registry of nodes
> moves into the command node's backend and clients keep only their list of
> command nodes. A migration from this catalogue into a command node registry
> will be specified with that work.


Status: Living. This covers upgrading to the federated client, what older
clients and backends see, the feature flags, and how to roll back. The
design is in [federation.md](../architecture/federation.md).

All protocol changes are additive. Nothing requires every saved backend to
upgrade at once. Backend data stays where it was: the only new backend record
is the machine profile.

## Desktop catalogue: version 1 to version 2

**Before.** Version 1 was a flat `StoredDesktopConnections` list,
`{ activeConnectionId, connections: [{ id, name, nickname?, address,
encryptedToken, lastConnectedAt }] }`. It was stored in the **local
backend's** `config.json` through `get_desktop_connections` /
`save_desktop_connections`. Reading saved machines therefore needed Local to
be running.

**After.** Version 2 lives in the desktop's own data directory, in
`<userData>/connections/device-connections.json`, with a backup and a
version-1 snapshot. On macOS that is
`~/Library/Application Support/orkestrator-v2/connections/`; on Linux,
`~/.config/orkestrator-v2/connections/`. Development builds use
`orkestrator-v2-dev`. See
[federation.md](../architecture/federation.md#device-catalogue-version-2)
for the format.

**One-time migration** (`loadOrMigrateCatalogue` in
`connection-catalogue-store.ts`, then `migrateDesktopConnections`) runs at
startup when **all** of these hold:

- the native catalogue does not exist yet, or exists without
  `migratedFromVersion: 1` (a late import, see below);
- the local backend started;
- the version-1 list could be read.

It then does the following:

1. Writes the version-1 list once to `device-connections.v1-snapshot.json`
   (create-only, mode 0600). A failure to write the snapshot is ignored.
2. Converts each saved address into one machine with one HTTPS route
   `https-<v1 id>`. The machine keeps the version-1 `id`, so window
   partitions keyed by connection ID stay valid. `name` becomes
   `fallbackName`, `nickname` becomes `localAlias`, and `lastConnectedAt` is
   kept. Routes are enabled and the machine is `autoConnect: true`.
3. Copies `encryptedToken` **verbatim**. Tokens are never decrypted or
   re-serialized, and stay in OS `safeStorage`.
4. Keeps `activeConnectionId` if it names a migrated machine, otherwise
   `local`. It writes `features` with defaults (all on), plus
   `migratedFromVersion: 1` and `migratedAt`. At most 64 rows are migrated.
5. Drops malformed historical rows (bad address and similar) from version 2
   only. They stay in the untouched version-1 list.
6. Saves the catalogue. For a late import, the existing native catalogue is
   kept and only version-1 entries it does not already have (by ID) are
   added, then `migratedFromVersion: 1` is recorded so it never runs again.

**Migration never merges machines.** Every migrated machine starts
provisional. Its first successful hello records `verifiedInstallationId` and
`profileCache`. If two migrated entries prove the same installation, both show
an identity **conflict** and route fallback is disabled for them. Nothing is
merged automatically. Forget one of them to resolve it.

Edge cases:

- If reading the version-1 list fails, or Local is down, the client starts
  with what it has (possibly an empty catalogue). Machines added meanwhile are
  saved natively, and the next start that can read the version-1 list imports
  its missing entries late (step 6), so nothing is lost.
- If Local fails to start on the first launch after upgrading and there is no
  native catalogue yet, startup fails as it did before (there is nothing to
  show). Remote-only startup needs a native catalogue with at least one
  machine.
- A torn or unparsable primary file falls back to
  `device-connections.backup.json`. If both are unreadable, initialization
  fails with "The saved connection catalogue is unreadable. It was left in
  place for recovery." Nothing is overwritten.

## What older clients see

- **An older desktop** after a downgrade reads the version-1 list in Local's
  `config.json`. The new client never writes to that list after migrating, so
  the older client sees machines exactly as they were at migration. It does
  not see machines, routes, nicknames or token changes made later. SSH-only
  machines are never representable to an older client, and are not
  down-converted to an unusable HTTP address. The two formats live in
  different files, so the clients never overwrite each other.
- **Upgrading again** finds the native catalogue and does not re-import
  changes the older client made to the version-1 list. To re-migrate from the
  current version-1 list:
  1. Quit the app.
  2. Move `<userData>/connections/device-connections.json` and
     `device-connections.backup.json` aside.
  3. Start the app with Local able to start.

  The snapshot file is write-once. It records the list as it was at the first
  migration, for manual comparison or recovery. Nothing reads it
  automatically.
- **An older browser or CLI** talking to a new backend sees only additive
  changes: `GET /__orkestrator/hello`, the `get_backend_profile` and
  `update_backend_profile` commands, the `backend-profile-changed` event, the
  optional `endpoints` array in `backend-instance.json`, and the optional
  loopback client listener. Existing commands, events and descriptor fields
  are unchanged.

## Presentation storage keys

Desktop renderers namespace persisted presentation state by machine identity
(`apps/web/src/lib/desktop-storage-key.ts`):

| Machine | Namespace |
| --- | --- |
| Local | `local`, unchanged |
| Verified remote | `backend:<installationId>` |
| Unverified, HTTPS route | The previous origin-derived namespace, unchanged |
| Unverified, SSH-only | `connection:<catalogue id>` |

When a machine is first seen as verified, each key whose new namespaced value
is empty adopts the value under the old origin-derived key, **once**. The old
key is left in place, which makes downgrade safe. A forwarded SSH port is
never part of a key. The earlier `…:desktop:migrated-v1` copy from Electron's
legacy default session runs as before.

Other storage:

- Machine panels use new partitions,
  `persist:orkestrator-panel-<hash of connection id>`.
- `machine-view-storage` is a new client-local key holding the filter,
  grouping, compact labels and outer panel layout.
- Hosted browsers keep their existing keys. Other machines are stored in
  `orkestrator.federation.machines` (`localStorage`), and their tokens in
  `orkestrator.federation.tokens` (`sessionStorage`).

## Feature flags

The flags are stored in the catalogue's `features` and toggled under
Settings → Connections. They default to on. Turning one off changes only this
client. It never stops or changes remote work, and it never edits saved
machines or routes, so turning it back on restores the previous behaviour.

| Flag | Disabling it |
| --- | --- |
| `federation` ("Show all machines together") | Ends every observation and refuses new ones. Disposes the renderer's machine runtimes. The sidebar returns to the single-machine switcher, which switches and reloads. Window bindings are kept. Open machine panels lose their machine view and close. |
| `sshRoutes` ("Managed SSH routes") | Removes SSH from the client's route kinds. Live SSH connections hand over to an approved HTTPS route, or end up `incompatible` if the machine has none. Adding SSH routes and probing host keys are refused. |
| `routeFallback` ("Automatic route fallback") | Only the preferred or current route is tried. Repeated event-stream drops never switch routes. An explicit **Use** still works. |

To get back to the last single-backend behaviour, turn off `routeFallback`,
then `sshRoutes`, then `federation`. HTTPS routes keep working throughout.

The hosted browser has no flags. To roll it back, forget the other machines
under Connections. The page's own backend is unaffected.

Backend side: `--loopback-client-port` is optional. Removing it stops the SSH
forwarding target, and SSH routes to that backend then fail with "no
Orkestrator client gateway answered". The profile record stays in the data
directory. An older backend binary does not use it.

## Compatibility as implemented

| Client | Backend | Behaviour |
| --- | --- | --- |
| New desktop | New | Hello verifies identity, canonical profile and capabilities. Several routes per machine; SSH when the backend serves `--loopback-client-port`; same-token fallback. |
| New desktop | Older, without hello | HTTPS works through the authenticated status check (`legacy`). Identity stays provisional: never merged, no fallback. SSH is refused (`legacy-backend`). The colour is the entry's persisted provisional colour (labelled cached) and there is no profile editing. The hello is attempted only per connection attempt, with no unknown-command polling. |
| New desktop | Incompatible client API range | `incompatible`, with no retry loop. |
| New desktop, Local not running | Any | Saved remote machines connect from the native catalogue. Local calls fail with "The Local backend on this computer is not running." This needs a native catalogue with at least one machine. |
| New hosted browser | New or older | Other machines over direct HTTPS. Each must list the page's origin in `--allowed-origins`. Without a hello, a machine is added provisionally and duplicates cannot be detected. SSH is not available. |
| Desktop without SSH support (Windows, or `sshRoutes` off) | Any | SSH routes are listed as unsupported. An SSH-only machine reports that it needs the desktop app's SSH support, and never fakes a connection. |
| Older desktop | New | Unaffected: additive API, and it keeps its version-1 list. |
| Older browser or CLI | New | Unaffected: additive API. |
| Any | Two installations sharing a copied ID | Two saved entries that verify the same ID show **conflict**, with fallback off. A new address added with **Add machine** that proves an ID already verified is refused (`identity-duplicate`); the user adds it explicitly as a connection method of that machine instead (the ID-02 path), which re-checks identity. Automatic fallback between routes still needs an identical token. There is no repair or re-pair UI. |
