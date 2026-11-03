# Retire in-container firewall enforcement

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Remove the `ORKESTRATOR_EGRESS=in-container` cap**: the last item in the report's H2 fix list. Status: open.

### 1. Remove the `ORKESTRATOR_EGRESS=in-container` cap

**Problem.** Where the firewall runs inside the workload, a process that gets root in the container can change it. The report wants this enforcement retired.

**Context.** Tracked as [todo 0018](../../todo/containers-and-environments/0018-container-network-and-credential-isolation.md) task 4, which is blocked on the gateway qualification in its tasks 1 to 3.

**Investigation.** The cap is still honoured (`apps/backend/src/core/egress-gateway.ts:62-63`, `:87`), and such a runtime still gets `NET_ADMIN` (`apps/backend/src/core/commands-containers.ts:331`). An image without the egress gateway also keeps the firewall inside the workload, and that stays true until it is rebuilt, so removing the cap does not end this for older runtimes. `docs/architecture/container-lifecycle.md:545` lists the cap as a rollout switch.

**Decisions.** None here: todo 0018 owns the qualification and the removal.

## Current state

Done, so not in Tasks. `git log -S` finds the helper in commit `5fc5982aa`, whose title (`docs(tests): ...`) does not mention it:

- Root `docker exec` and `docker run` use a fixed PATH (`CONTAINER_ROOT_USER_ARGS`, `apps/backend/src/core/container-scripts.ts:13-20`), as do root terminals (`:27-32`).
- Root scripts reset PATH themselves (for example `docker/orkestrator-drain.sh:28-29`, `docker/update-firewall.sh:29-30`). `docker/run-root-setup.sh` has no reset of its own and runs through sudo's `secure_path`.
- Root shells source no `node`-writable file (`orkestrator_source_root_env`, `docker/runtime-env.sh`), and root zsh uses `compinit -i` (`docker/container-zshrc.zsh:20-24`).
- `/usr/local/share` stays root-owned, with `npm-global` its own directory (`docker/Dockerfile:144-148`), and the build fails if `node` can write a root path (`docker/Dockerfile:519-521`).

Every other `--user` or `-u` call found in the backend names `node` or the artifact worker's own user.

## Related

- [Security report, H2](../2-26-10-27-security.md#h2-the-unprivileged-node-user-can-get-code-executed-as-root-inside-the-container)
- [Todo 0018](../../todo/containers-and-environments/0018-container-network-and-credential-isolation.md), task 4
- [0080](0080-m9-legacy-host-mounts.md): other behaviour that older images keep
