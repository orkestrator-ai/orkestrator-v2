# A second backend can take the desktop's gateway port 34121

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e5`, while working on
[0244](0244-second-backend-on-one-host.md).

### Tasks

1. **Keep a second backend off the default gateway port**: decide which backend may default to 34121 and what every other one does when `--port` is omitted. Status: done in code (2026-10-31); not yet proved on a real install (task 3).
2. **Stop the desktop's gateway falling back onto 34122**: the desktop's own gateway fallback can land on the Control MCP's fixed port. Status: done in code (2026-10-31); not yet proved on a real install (task 3).
3. **Qualify**: in a disposable VM, a second service started before the desktop leaves the desktop's 34121 and 34122 alone. Status: open (needs a disposable VM; tasks 1 and 2 are built; steps under Outstanding work).

### 1. Keep a second backend off the default gateway port

**Problem.** A backend started without `--port` asks for the default gateway port 34121, whatever its data directory. A service for a second data directory that starts before the desktop app (a systemd user unit or LaunchAgent at login, say) takes 34121, and the desktop's gateway then falls back to the next free port.

**Context.** 0244 fixed the same takeover for the Control MCP port (only the default data directory's backend binds 34122). The gateway default is `DEFAULT_GATEWAY_PORT = 34121` (`apps/backend/src/gateway-support-core.ts:198`), used in `GatewayLifecycle` when neither `--port` nor `ORKESTRATOR_GATEWAY_PORT` is given (`apps/backend/src/gateway-lifecycle.ts:81`). `orkestrator service install` never adds `--port` (`packages/cli/src/client/service-setup.ts`, `askServeArguments`), so every service, for any data directory, asks for 34121. Remote machines are added in the desktop by their address on 34121, so the default install of a remote host must keep it.

**Investigation.** Unlike the Control MCP, the gateway already survives a taken port: `listenWithPortFallback` (`gateway-lifecycle.ts:169`) tries the next 1 to N ports and then an ephemeral one, unless `--strict-gateway-port` is set. So a second backend does not fail; it moves whichever backend starts second. The CLI and desktop find a backend through `backend-instance.json` and connection records, not the fixed port, for local use; remote use over Tailscale relies on 34121.

Checked against the code on 2026-10-31, the takeover needs both backends on the same address. The production desktop binds `127.0.0.1` (`--desktop-web-client` adds `--host 127.0.0.1`), and a service with no `--host` binds its Tailscale address, so those two can both hold 34121 today. The collision is between backends sharing an address: a `--tailscale-serve` or `--host 127.0.0.1` service and the desktop, or two tailnet services. `mise run dev` was a further route the analysis missed: `backend-process.ts` passed `--port 34121` for its own data directory (`orkestrator-v2-dev`), so it never reached a "port omitted" rule.

A free port also breaks Tailscale Serve across an unclean exit. Serve keeps proxying to the old port, and `TailscaleServeManager.start` only adopts a target on the port it has now, so the next start throws `TailscaleServeConflictError` and the service does not come back.

**Decisions.**

- **Which backend may default to 34121?**
  - **Only the default data directory's backend; any other one defaults to an ephemeral port unless `--port` or `ORKESTRATOR_GATEWAY_PORT` is given, and `service install --data-dir <other>` prints the port it got (recommended, implemented).**
    - Pros: the same rule as the Control MCP (`isDefaultDataDir`); a second service can never move the main install.
    - Cons: a remote second service over Tailscale needs an explicit `--port` to have a stable address; the setup flow has to say so. An existing tailnet second service changes address when it updates, even on a desktop host where it never collided.
  - **`service install` writes `--port 0` for a non-default data directory.**
    - Pros: smallest change; no backend behaviour change.
    - Cons: misses `serve` and hand-started backends, and units written by older CLIs.
  - **Leave it; the fallback already keeps both running.**
    - Pros: no change.
    - Cons: the main install's address changes depending on start order, and task 2's collision stays reachable.
- **How does a second backend keep Tailscale Serve working across an unclean exit?**
  - **`service install` writes a free `--port` chosen at install, and a reinstall keeps it; a hand-started `serve` or older unit logs a warning (recommended, implemented).**
    - Pros: small; new installs always come back after a crash; no new state file.
    - Cons: units written by older CLIs and hand-started backends can still refuse to start after an unclean exit, until they get `--port`.
  - **The backend remembers its free port in the data directory and asks for it again.**
    - Pros: covers every start, and gives every second backend a stable address, including remote ones.
    - Cons: a new state file and more startup logic, and the port can still be taken at the next start.
  - **Keep the fixed-port default for `--tailscale-serve`.**
    - Pros: no restart failure, and no change for these services.
    - Cons: these services bind loopback, which is exactly where they collide with the desktop, so the bug stays.
- **What does `mise run dev` ask for?**
  - **A free port: `--port 0` when the desktop runs in development with no profile port (recommended, implemented).**
    - Pros: closes the same takeover for a route every developer uses; the production argument does not change.
    - Cons: a developer loses the fixed 34121 in dev. Nothing in the repository relies on it, and `dev:web` still names its port.
  - **Omit `--port` and let the backend's rule decide.**
    - Pros: one rule, in one place.
    - Cons: the production desktop's 34121 would then depend on `isDefaultDataDir` agreeing with Electron's `userData`, which is more risk than the change is worth.
  - **Leave it.**
    - Pros: no change.
    - Cons: `mise run dev` started first still moves the installed app's gateway.
- **What should existing second services do when they update?**
  - **Nothing: they move to a free port, and release notes say to add `--port` (recommended; the release note is not written).**
    - Pros: one rule for every backend; no rewriting of service config.
    - Cons: a remote client saved on `:34121` loses that service after it updates, and has to be reconnected by someone with access to the host.
  - **The launcher adds `--port 34121` to existing second services on update.**
    - Pros: remote clients stay connected.
    - Cons: keeps those services on the main install's port, so the bug stays for them.
- **What about a second backend's SSH loopback client port?**
  - **Leave it for now (recommended).**
    - Pros: a taken port only fails that one listener, which the backend logs; this is a different flag from the one this file is about.
    - Cons: the setup questions offer 34125 to a second backend, so if the main install holds it, SSH access to the second backend does not work.
  - **Ask for a port in the setup questions, as for the tailnet address.**
    - Pros: fixes the setup flow for that population.
    - Cons: one more question, for a rare setup.
- **Should a backend refuse a free port the OS happens to pick on 34121 or 34122?**
  - **No, only the port `service install` writes is checked (recommended, implemented).**
    - Pros: no new retry path. The chance is about 2 in 28,000 per start, on Linux only, and an unwritten free port does not last past that start.
    - Cons: on Linux, a second backend can very rarely hold a fixed port until its next restart.
  - **Close and retry in the gateway's listener.**
    - Pros: closes it for the gateway.
    - Cons: the Control MCP and other free-port listeners have the same gap, so it would not close it overall.

### 2. Stop the desktop's gateway falling back onto 34122

**Problem.** The production desktop starts its backend with `--port 34121` and no `--strict-gateway-port` (`apps/desktop/electron/backend-process.ts`, `launch`; `main.ts` sets `strictGatewayPort` only for agent-test). If 34121 is taken, the first fallback candidate is 34122, which is the desktop backend's own Control MCP port. Its gateway then holds 34122, and its Control MCP retries the bind for ever (0244 task 2) with "Port 34122 is in use by another process" in Settings.

**Context.** Found reading `listenWithPortFallback` while implementing 0244's retry. Not observed live.

**Investigation.** The fallback walks `preferredPort + offset` for `GATEWAY_PORT_FALLBACK_ATTEMPTS` ports. Nothing skips ports another listener of the same backend needs.

Checked against the code on 2026-10-31, the problem above is narrower than it reads. `backend.init()` awaits `controlMcp.start()` (`core/index.ts`) before `main.ts` starts the gateway, so when 34122 is free the desktop's Control MCP binds first and the gateway's walk finds it taken and lands on 34123. The collision is still reachable in two ways, read from the code and not seen live:

- Another backend's gateway takes 34122 before the desktop starts: two backends asking for 34121 with no desktop running (the second walks onto 34122), after which the desktop's Control MCP retries for ever.
- The desktop's own gateway takes it: something else holds 34122 when the Control MCP binds, then lets go before the gateway walks. The Control MCP's retry then meets its own backend's gateway.

So the walk has to keep off 34122 even when it is free, which is the fix recommended here.

**Decisions.**

- **How to keep the gateway off 34122?**
  - **Skip the fixed Control MCP port (and the loopback client port when set) in the fallback walk (recommended, implemented).**
    - Pros: a few lines in one place; keeps the fallback for everything else.
    - Cons: the skip list must follow any new fixed port.
  - **Fall back straight to an ephemeral port.**
    - Pros: never collides with a fixed port.
    - Cons: the nearby-port behaviour some users may rely on goes away.
- **What else belongs on the skip list?**
  - **Also 34121 and a configured `ORKESTRATOR_CONTROL_MCP_PORT`, but never the port asked for by name (recommended, implemented).**
    - Pros: a backend walking up from `--port 34120` cannot take the main install's gateway port, and a Control MCP on a configured port is protected the same way; an explicit `--port 34122` still means what it says.
    - Cons: two more entries than this file first listed.
  - **Only 34122 and the loopback client port.**
    - Pros: the smallest list.
    - Cons: leaves the walk able to take 34121 from below.

### 3. Qualify

**Problem.** Neither fix is proved on a real install.

**Context.** Same constraints as 0244: never on a machine someone works on.

**Investigation.** The steps first written here would not have shown the bug, for three reasons found on 2026-10-31. A service with no `--host` and no Tailscale address does not start. With Tailscale it binds the tailnet address and does not collide with a loopback backend. And the main backend's gateway lands on 34123, not 34122, because its Control MCP binds first (task 2). The corrected steps are under Outstanding work.

**Decisions.**

- **Where to run it?**
  - **In the same VM run as 0244 task 5 (recommended; not run yet).**
    - Pros: one VM image, one set of steps.
    - Cons: that run grows by one start-order case.
  - **A separate run.**
    - Pros: independent of 0244's schedule.
    - Cons: duplicates the VM setup.

## Assumptions and decisions

### Which backend may default to 34121 (task 1)

Only the default data directory's backend, as this file recommended. `implicitGatewayPort` in `apps/backend/src/options.ts` applies when neither `--port` nor `ORKESTRATOR_GATEWAY_PORT` is given. It follows `controlMcpPortOverride`, so the test runner and `agent-test` backends take a free port too, on any data directory. An explicit port always wins. The check is in `parseOptions` because that is the one route every `serve`, service and hand-started backend takes. `OrkestratorGateway` keeps its own default for callers that build it directly.

### Printing the port (task 1)

`service install` already printed the address, but a loopback-only backend printed "no browser listener", and with Tailscale Serve the address hides the local port. So it now also prints the loopback client listeners, and `--output json` gains `clientUrls`. A second backend also gets a one-line note saying what its port does.

### Setup questions (task 1)

Only the tailnet choice asks for a port. That is the one choice where a client dials the gateway's port directly. Serve gets a chosen port without asking, and SSH clients use the loopback client port. The question refuses 34121 and 34122; a scripted `-- --port 34121` is still allowed, for someone keeping an existing address on purpose.

### Tailscale Serve keeps one port (task 1)

This goes beyond the file's recommendation, for the reason under task 1's Investigation: a free port would stop a Serve service coming back after a crash. Dry runs show the unchanged arguments and the note, because the port is only chosen on a real install.

### `mise run dev` takes a free port (task 1)

This also goes beyond the file. `desktopGatewayPort` in `backend-process.ts` keeps the production value explicit and asks for a free port in development.

### The skip list (task 2)

`fallbackSkippedPorts` in `gateway-lifecycle.ts` holds 34121, 34122, a configured `ORKESTRATOR_CONTROL_MCP_PORT` and the loopback client port. The port asked for is tried regardless. An invalid `ORKESTRATOR_CONTROL_MCP_PORT` is ignored here, so it cannot stop the gateway. The Control MCP reports its own error for it.

### The fixed ports' own module (tasks 1 and 2)

`apps/backend/src/fixed-ports.ts` holds both constants, so the gateway does not import the Control MCP server and the standalone CLI imports neither.

## Outstanding work

Run task 3 in a disposable Linux VM, never on a machine someone works on, with the new build and alongside 0244 task 5:

1. **Second backend first.** `orkestrator service install --data-dir /var/tmp/ork-b --yes -- --host 127.0.0.1 --allow-non-tailscale-bind`. The output includes the "changes on each start" note and a local listener. `jq '.url,.controlMcp' /var/tmp/ork-b/backend-instance.json` names neither 34121 nor 34122, and `ss -ltnp 'sport = :34121 or sport = :34122'` is empty.
2. **Main backend second.** `orkestrator service install --yes -- --host 127.0.0.1 --allow-non-tailscale-bind` (or start the desktop app). `ss -ltnp 'sport = :34121 or sport = :34122'` names the main backend's PID on both, and `jq .controlMcp ~/.config/orkestrator-v2/backend-instance.json` shows `"running":true`.
3. **Restarts.** Restart B's unit three times. B's port may change; the main backend's PID and ports do not.
4. **The fallback walk.** Stop both units. Hold a port with a process you start and note its PID (`python3 -m http.server 34120 --bind 127.0.0.1 &`). Run `orkestrator serve --data-dir /var/tmp/ork-c --host 127.0.0.1 --allow-non-tailscale-bind --port 34120`. It listens on 34123, and 34121 and 34122 stay free although nothing holds them. Stop both by their recorded PIDs, start the main unit, and check it holds both fixed ports.
5. **Tailscale Serve, if the VM is on a tailnet.** `orkestrator service install --data-dir /var/tmp/ork-d --yes -- --tailscale-serve --tailscale-serve-port 8443`. `/var/tmp/ork-d/backend/service.json` has a `--port`. SIGKILL the backend by the PID in its descriptor, confirming the PID's identity first. It comes back with the same URL and logs no "Refusing to replace". Reinstall and check the port is unchanged.
6. **Clean up.** `orkestrator service uninstall --data-dir <dir> --purge` for each service, then record the output here and re-rate the file.

## Constraints and rationale

- The default install keeps 34121 and 34122: remote machines are reached on
  34121 and external MCP clients on 34122.
- Agents must never bind 34121 or 34122, or run a backend against the real data
  directory; prove this with unit tests and isolated backends on OS-assigned
  ports, and the VM run.

## Related

- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md):
  the Control MCP half of the same problem.
- [remote-gateway.md](../../architecture/remote-gateway.md),
  [control-mcp.md](../../architecture/control-mcp.md).

## Replaces

Nothing; new on 2026-10-30.
