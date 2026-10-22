# Managed SSH routes

> **Direction change (2026-10-21):** under
> [command-nodes.md](../architecture/command-nodes.md), SSH routes to leaf
> nodes are run by the **command node's backend**, not by the desktop
> client. The remote-side setup below (loopback client gateway, aliases,
> host-key trust) still applies; the desktop-managed tunnel described here is
> the transitional implementation.


Status: Living. This is the setup and troubleshooting guide for reaching a
remote backend through a desktop-managed OpenSSH tunnel. For how routes,
identities and fallback work, see
[federation.md](../architecture/federation.md). The loopback listener's flags
are documented in
[remote-gateway.md](../architecture/remote-gateway.md#loopback-client-gateway-ssh-forwarding-target).

An SSH route is one more way to reach a backend that is **already running**.
The desktop starts your system `ssh` with a single local forward,
`127.0.0.1:<ephemeral>` to `127.0.0.1:<remote client gateway port>`. It then
talks to the ordinary authenticated client API through that forward. The
gateway token is still required. The same machine can also keep its
HTTPS/Tailscale route, and both routes appear as one machine.

## 1. Prepare the remote backend

1. Run the backend as a standalone service with the loopback client gateway:

   ```bash
   orkestrator serve --loopback-client-port 34125
   ```

   To keep it running, use `orkestrator service install -- --loopback-client-port 34125`
   with your other serve arguments
   ([host-updates.md](../architecture/host-updates.md#standalone-service)).
   `ORKESTRATOR_LOOPBACK_CLIENT_PORT` works too. `34125` is only the value
   the **Add over SSH** form suggests; any free port works. `0` picks a free
   port, which you then have to read back.
2. Check the startup output. The `orkestrator-backend-ready` line has
   `loopbackClientUrl`, for example `http://127.0.0.1:34125/`, and the log
   says `[RemoteGateway] Loopback client gateway listening on …`. If the port
   is busy, only this listener fails: the ready line has `loopbackClientError`
   and the backend keeps serving.
3. This listener binds `127.0.0.1` only. It does not change where the
   Tailscale or browser listener binds. It serves the client API and answers
   `404` for control-only routes.
4. Copy the gateway token from the remote `gateway-auth.json`. The path is
   printed as `[RemoteGateway] Auth token stored at …`; by default it is
   `~/Library/Application Support/orkestrator-v2/gateway-auth.json` on macOS
   and `~/.config/orkestrator-v2/gateway-auth.json` on Linux.

Never point an SSH route at the control listener, which is the descriptor's
primary `url` on a desktop-supervised backend. The desktop refuses a forward
whose hello reports `endpointRole: "control"`, and quarantines that route.
The desktop app has no setting that adds a loopback client listener to the
backend it supervises itself. Use a standalone service as the SSH target.

## 2. Prepare an SSH alias

Orkestrator uses your own OpenSSH configuration: aliases, `Include`,
`Match`, users, ports, keys, `ProxyJump` and `ProxyCommand`. Fields left
blank in the form stay unset, so no port 22 or user is forced. Use a
**dedicated `Host` alias** for Orkestrator:

```text
Host orkestrator-build
  HostName build.example.internal
  User alice
  Port 2222
  IdentityFile ~/.ssh/id_ed25519_orkestrator
  # ProxyJump bastion        # supported
```

- **No `LocalForward`, `RemoteForward` or `DynamicForward`** may apply to the
  alias. Before each start the desktop runs `ssh -G <alias>` and refuses such
  an alias with `config-extra-forwards`. It does not clear them, because
  `ClearAllForwardings=yes` would also remove Orkestrator's own `-L`.
- `ProxyJump` and `ProxyCommand` are honoured. Your SSH configuration is
  trusted local configuration and can run local programs. Never copy SSH
  options from a repository or a remote machine into it.
- `PermitLocalCommand yes` with a `LocalCommand` is allowed, but logged as a
  configuration note.
- Some settings are always overridden on the command line:
  `StrictHostKeyChecking=yes`, `ForwardAgent=no`, `ForwardX11=no`,
  `ControlMaster=no`, `ControlPath=none`, `ExitOnForwardFailure=yes`,
  `ServerAliveInterval=20`, `ServerAliveCountMax=3`. Setting an identity file
  in the form adds `-i <file> -o IdentitiesOnly=yes`.
- The remote account needs TCP forwarding (`AllowTcpForwarding`). No remote
  shell command is run.

The destination field accepts `alias`, `host` or `user@host`. Allowed
characters are letters, digits and `. _ - @ : [ ]`. A value starting with
`-`, a URL, whitespace, more than one `@`, or more than 255 characters is
rejected before anything is spawned.

## 3. Add the route

Go to Settings → Connections:

- **Add over SSH** onboards a new machine.
- **Details → + SSH** (under "Connection methods on this device") adds a
  route to a machine that is already verified. That route must prove the same
  installation, or nothing is saved.

Enter the destination, an optional SSH port, an optional identity file, the
remote client gateway port, the gateway token and an optional nickname for
this device.

The token is stored with OS `safeStorage`. On Linux with the `basic_text`
backend, or when encryption is unavailable, it is kept for this session only.

### First-use host key

The desktop trusts host keys from two places:

- your effective `UserKnownHostsFile` list from `ssh -G` (and the system
  global file);
- Orkestrator's own file, `<userData>/ssh/known_hosts`. That is
  `~/Library/Application Support/orkestrator-v2/ssh/known_hosts` on macOS and
  `~/.config/orkestrator-v2/ssh/known_hosts` on Linux. Development builds use
  `orkestrator-v2-dev`.

If neither file knows the host, the connect fails with `host-key-unknown`.
The dialog then probes the key without offering any credential (every
authentication method is disabled), and shows its SHA256 fingerprints. Check
them on the server, for example with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. **Trust and connect**
appends exactly the probed lines to Orkestrator's file and retries. The file
is mode 0600 in a 0700 directory and is rewritten atomically. **Don’t trust**
saves nothing. Your own `~/.ssh/known_hosts` is never written.

### Changed host key

`host-key-changed` blocks the route until you act. It is never retried and
never bypassed by falling back to another route. To recover:

1. Confirm out of band that the machine was really re-keyed.
2. Remove the stale entry from the file that holds it:
   - Orkestrator's file:
     `ssh-keygen -R '<host>' -f "<userData>/ssh/known_hosts"`
   - your own file: `ssh-keygen -R '<host>'`

   For a non-default port the host is written `[host]:port`.
3. Trust the new key. Either connect once with your own `ssh <alias>` and
   verify the fingerprint it shows, then press **Retry** on the route under
   Connections → Details. (The button reads **Use** when the route is not
   blocked.) Or remove the route and add it again with **+ SSH**, which shows
   the fingerprint review.

**Use**/**Retry** on an existing route does not open the fingerprint review
itself. There is no in-app control that removes or rotates a trusted key.

## Passphrases, passwords and ssh-agent

- **Interactive prompts happen only after a user action**: adding the route,
  **Use** on a route, opening a window or machine panel bound to the machine,
  switching a window to it, or updating its token. OpenSSH's prompt text
  appears in an in-app dialog in the focused main window.
- Prompts go through a request-scoped askpass helper. A private 0700
  directory holds the helper script and a Unix socket guarded by a random
  nonce. A prompt times out after 120 s. Time spent with a prompt open does
  not count toward the 15 s readiness deadline. Cancelling sends no answer.
  The helper is torn down as soon as the tunnel is ready, or when the attempt
  fails, the window closes or the app exits. Answers are never logged or
  stored.
- **Background work never prompts.** That covers observation from the
  sidebar, reconnect timers and route handovers. They run `ssh` with
  `BatchMode=yes` and `SSH_ASKPASS_REQUIRE=never`. Key and agent
  authentication still reconnect silently, using the `SSH_AUTH_SOCK` the
  desktop inherited. A passphrase-protected key that is not loaded in an
  agent makes the machine show **Sign-in needed**
  (`authentication-required`). It waits there for a user action. There is no
  repeated dialog.

## What Orkestrator never does

- It never installs, starts, updates or stops the remote backend, and it never
  runs a remote shell command. Reconnecting is not an installer.
- It never runs a broad `pkill ssh`. Each route has one owned child, shared by
  reference-counted leases across windows and panels. The last release, or
  app exit, sends SIGTERM to that PID only. After 3 s it sends SIGKILL.
  Closing a tunnel never stops remote agents or turns.
- It never uses or terminates an external ControlMaster
  (`ControlMaster=no`, `ControlPath=none`).
- It never disables host-key checking, forwards your agent or X11, opens
  additional forwards, binds anything except `127.0.0.1`, or uses the
  forwarded port as a durable identity.
- It never passes the token to `ssh`, puts it in a URL or logs it. SSH login
  never replaces gateway authentication.

## Platform support

| Client | SSH routes |
| --- | --- |
| macOS and Linux desktop | Supported. `ssh` is looked up in `/usr/bin`, then absolute `PATH` entries. `ssh-keygen` is needed for host-key review. |
| Windows desktop | Not qualified. Finding `ssh.exe` is deliberately not treated as support (`SSH routes are not qualified on Windows yet.`). |
| Hosted browser | No. Browsers cannot run `ssh`. Use the machine's HTTPS route. |
| iOS | No. The app stays single-machine over HTTPS. |

A client without SSH support marks SSH routes as unsupported. If a machine
has only SSH routes, the client says it needs the desktop app.

## Troubleshooting by failure code

Typed codes appear as the machine's status detail, or as the dialog's error.
These come from the tunnel adapter
(`apps/desktop/electron/ssh/tunnel-failures.ts`):

| Code | Retried automatically | Meaning and fix |
| --- | --- | --- |
| `invalid-route` | No | The destination, port, identity file or route settings are invalid. `ssh -G` could not read the configuration for the alias, the route already has a tunnel with different settings, or a host-key approval expired (probe again). |
| `ssh-unavailable` | No | `ssh` (or `ssh-keygen`, for host-key review) was not found, or the platform is Windows. |
| `config-extra-forwards` | No | The alias resolves to `LocalForward`, `RemoteForward` or `DynamicForward`. Use a dedicated alias without them. |
| `host-key-unknown` | No | First connection. Review and approve the fingerprint. |
| `host-key-changed` | No | The key differs from a trusted entry. See [Changed host key](#changed-host-key). |
| `authentication-required` | No | A background attempt needed a passphrase or password, or a prompt was cancelled. Load the key into `ssh-agent`, or press **Use** to connect interactively. |
| `authentication-failed` | No | The server rejected the credentials in an interactive attempt. Check the user, key and `authorized_keys`. |
| `forwarding-denied` | No | sshd answered "administratively prohibited". Enable `AllowTcpForwarding` for the account. |
| `port-collision-exhausted` | Yes | Another process kept taking the chosen local port. The adapter tries 3 fresh ports and never connects to an unrelated listener. |
| `connect-failed` | Yes | DNS, refused, timed-out or reset SSH connection, or no readiness within 15 s. Check reachability and `ProxyJump`. |
| `tunnel-exited` | Yes, unless its cause is a trust or auth code | The child stopped after it was ready. The route manager reconnects, or falls back to an approved route. |
| `cancelled` | No | The attempt was abandoned: window closed, machine no longer observed, or app quitting. |

These outcomes come from the route manager after the tunnel is up:

| Code or message | Meaning and fix |
| --- | --- |
| "The SSH connection worked, but no Orkestrator client gateway answered on that remote port." | SSH succeeded, but nothing answers the remote port. Check `--loopback-client-port` and the `loopbackClientUrl` in the ready line. The machine is not marked connected. |
| "The gateway token was rejected." (`authentication-required`) | SSH succeeded, but the gateway token is wrong. Copy it again from `gateway-auth.json`. |
| `control-endpoint` | The remote port is the control listener. Forward the loopback client gateway instead. The route is quarantined. |
| `legacy-backend` | The remote backend predates the hello handshake, so SSH routes are refused. Update the backend or use HTTPS. |
| `identity-mismatch` | The forward reached a different installation than the saved machine. Nothing was merged, and the route is quarantined until **Retry**. |
| `no-route` / `incompatible` | No enabled route this client can open. Typical cases are SSH turned off under Connections, or a client without SSH. |

Raw OpenSSH stderr is never shown. Details are single redacted lines, with
users, paths and quoted values removed.

## Real-sshd integration test

`apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts` starts a disposable,
non-root `sshd` on `127.0.0.1`. It uses its own host keys,
`authorized_keys` and an explicit `ssh -F` client config, so nothing under
`~/.ssh` is read or written. It needs `sshd` (default `/usr/sbin/sshd`), `ssh`
and `ssh-keygen`. Without the opt-in every case is skipped. Run it with:

```bash
ORKESTRATOR_SSH_INTEGRATION=1 mise run test:logged -- --name ssh-integration -- \
  bun test --cwd apps/desktop --preload ../../tests/setup-node.ts \
  ./tests/ssh/ssh-tunnel-integration.test.ts --parallel=1
```

It covers:

- SH-01: an alias with a custom port, user and key;
- SH-02: unknown host keys refused until approved, and a rotated key blocked
  as `host-key-changed`;
- SH-03: a passphrase prompt only when interactive;
- SH-05: a taken local port retried a bounded number of times;
- SH-06: a closed remote gateway port;
- SH-07: `AllowTcpForwarding no` reported as `forwarding-denied`;
- SH-10/SH-11: shared leases, where the last release stops only the owned
  child.

ProxyJump (SH-04) and an external ControlMaster (SH-14) are not exercised
against a real server. Fake-process tests for the same adapter live beside it
in `apps/desktop/tests/ssh/`.
