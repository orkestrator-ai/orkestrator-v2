# Security review: outstanding work

What is left to do from the [security review](../2-26-10-27-security.md).

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0070-h5-host-github-token-default.md](0070-h5-host-github-token-default.md) | Very high | No | H5: the default credential, splitting container from backend use, scope warning | Every container agent gets a credential that usually reaches all the user's repositories, which crosses the container boundary by default. |
| 2 | [0010-h1-gateway-cookie-remainder.md](0010-h1-gateway-cookie-remainder.md) | High | No | H1: the `__Host-` name, and the session that still reaches other ports | A leaked session can still act as the user until it ends, which is a real exposure wherever a container can reach the gateway. |
| 3 | [0040-h4-bridge-credential-remainder.md](0040-h4-bridge-credential-remainder.md) | High | No | H4: credential out of the agent's uid, widening, self-answered approvals, `readOnly` | An agent on a hardened environment can still undo human approval, a reachable exposure that todo 3930 also rates High. |
| 4 | [0050-m6-renderer-csp.md](0050-m6-renderer-csp.md) | High | No | M6: CSP on the renderer and gateway HTML, Trusted Types, invoke allowlist | The renderer shows attacker-influenced content, and one sanitiser bypass reaches a generic host command bridge with no second layer. |
| 5 | [0080-m9-legacy-host-mounts.md](0080-m9-legacy-host-mounts.md) | High | No | M9: new containers from old images, and listing affected environments | Whole host agent homes reach any container from an older image, though current images are not affected. |
| 6 | [0090-m11-coordinator-delegation-scope.md](0090-m11-coordinator-delegation-scope.md) | High | No | M11: delegation scope and marking mail-originated delegations | An injected worker can reach a user-created environment under its looser policy, limited only by framing and budgets. |
| 7 | [0100-m12-egress-sni-and-dns.md](0100-m12-egress-sni-and-dns.md) | High | No | M12: SNI enforcement, DNS filtering, default allowlist, user-facing statement | Shared edges, attacker credentials and DNS remain working exfiltration channels from a restricted container. |
| 8 | [0140-l6-release-signing-and-pinning.md](0140-l6-release-signing-and-pinning.md) | High | No | L6: AppImage manifests, `install.sh` pin, npm provenance, updater lockfile | A compromised release or publish reaches users directly, and nothing but the feed hash and a workstation stands in the way. |
| 9 | [0060-m7-preload-sandbox.md](0060-m7-preload-sandbox.md) | Medium | No | M7: CommonJS preloads and `sandbox: true` | It is a build change that removes a real risk, but exploiting that risk needs a Chromium or V8 bug. |
| 10 | [0120-l2-tokens-in-docker-exec-argv.md](0120-l2-tokens-in-docker-exec-argv.md) | Medium | No | L2: bridge and agent-tools tokens in `docker exec` argv | It removes a real risk, but only another local user can read the argv and only while the CLI runs. |
| 11 | [0130-l5-renderer-permission-handler.md](0130-l5-renderer-permission-handler.md) | Medium | No | L5: default-deny permissions on renderer and realm sessions | It closes a gap in depth that only matters once script already runs in the renderer. |
| 12 | [0170-l15-agent-tools-bind-address.md](0170-l15-agent-tools-bind-address.md) | Medium | No | L15: agent-tools server on `0.0.0.0` | The server is token-protected, so the wider bind adds reach for a leaked token rather than a direct way in. |
| 13 | [0180-l16-control-mcp-and-reminder-soft-spots.md](0180-l16-control-mcp-and-reminder-soft-spots.md) | Medium | No | L16: operator token reads, confirm token wording, self-reminder framing | A coordinator reading the operator token gains wider authority, though it needs a command the read-only policy admits. |
| 14 | [0200-i1-workspace-grant-allowlist.md](0200-i1-workspace-grant-allowlist.md) | Medium | No | I1: grant deny-list against its documented guarantee | A grant holder can change global config and request host updates, but grants are short-lived and issued through the user's own command node. |
| 15 | [0260-s8-dynamic-browser-and-docker-tests.md](0260-s8-dynamic-browser-and-docker-tests.md) | Medium | No | §8: dynamic checks of H1, M1, M2 and H3 | It is a missing measurement of fixes that have only been proved up to the headers they send. |
| 16 | [0270-s8-ios-app-review.md](0270-s8-ios-app-review.md) | Medium | No | §8: the iOS app: Review the iOS app | It is a missing review of a client that holds the gateway token, with no specific defect known. |
| 17 | [0020-m1-isolated-preview-default.md](0020-m1-isolated-preview-default.md) | Low | No | M1: default flip and legacy route retirement | The sandbox header already closes the top-level path, and all remaining work is blocked in todo 0042. |
| 18 | [0030-h2-retire-in-container-firewall.md](0030-h2-retire-in-container-firewall.md) | Low | No | H2: retiring in-container firewall enforcement | The root paths are closed, and the one remaining item is blocked on todo 0018's qualification. |
| 19 | [0110-l18-dependency-advisories.md](0110-l18-dependency-advisories.md) | Low | No | L18: `undici`, `postcss-selector-parser`, Electron 45.x | The advisories are already accepted and blocked upstream in todo 0032. |
| 20 | [0150-l10-gateway-host-check-and-login-throttle.md](0150-l10-gateway-host-check-and-login-throttle.md) | Low | No | L10: Host allowlist and login throttling | A rebound page holds no session and guessing only threatens a weak user-chosen token. |
| 21 | [0160-l12-descriptor-process-binding.md](0160-l12-descriptor-process-binding.md) | Low | No | L12: pid reuse by the same user | It needs a crashed backend, pid reuse and a co-tenant on the old port all at once. |
| 22 | [0190-l17-provider-secrets-at-rest.md](0190-l17-provider-secrets-at-rest.md) | Low | No | L17: provider secrets in plaintext at 0600 | The report only says to consider it, and only a same-uid process can read the file. |
| 23 | [0210-i2-side-agent-doc-drift.md](0210-i2-side-agent-doc-drift.md) | Low | No | I2: two stale statements about side agents | This is documentation hygiene. |
| 24 | [0220-i3-github-token-in-gitconfig.md](0220-i3-github-token-in-gitconfig.md) | Low | No | I3: token in `~/.gitconfig`: Stop writing the GitHub token into the container's `~/.gitconfig` | It removes one copy of a token the agent can already read from its credential file. |
| 25 | [0230-i5-preview-publication-domain.md](0230-i5-preview-publication-domain.md) | Low | No | I5: same-site check for the publication domain | Publication is off by default, and the gateway's Origin check and opaque sessions limit what a same-site host gains. |
| 26 | [0240-i6-checkout-persist-credentials.md](0240-i6-checkout-persist-credentials.md) | Low | No | I6: `persist-credentials` on the image publish job | It is a one-line hygiene fix for a job-scoped token that only runs on the repository's own code. |
| 27 | [0250-i7-internal-token-prefix.md](0250-i7-internal-token-prefix.md) | Low | No | I7: `okb_` prefix and redaction rule | Redaction is best-effort defence in depth, and tails are already scrubbed. |

## Status of every finding

20 done, 15 partly done, 18 open, 12 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| H1 | Partly done | `apps/backend/src/gateway-sessions.ts:73-75`, `apps/backend/src/gateway-auth.ts:135-138` (commit `4f9cf3b32`); remainder in [0010-h1-gateway-cookie-remainder.md](0010-h1-gateway-cookie-remainder.md) |
| H2 | Partly done | `apps/backend/src/core/container-scripts.ts:13-20`, `docker/container-zshrc.zsh:20-24` (commit `5fc5982aa`); remainder in [0030-h2-retire-in-container-firewall.md](0030-h2-retire-in-container-firewall.md) |
| H3 | Done | `apps/backend/src/core/container-project-seed-files.ts:66-110`; no project file in `bindIfExists` calls (`apps/backend/src/core/commands-containers.ts:503-559`); commit `1565c7c16` |
| H4 | Partly done | `packages/protocol/src/execution-policy-narrowing.ts:140`, each bridge's `delete process.env` (commits `2d4528dc5`, `a2bba9d80`); remainder in [0040-h4-bridge-credential-remainder.md](0040-h4-bridge-credential-remainder.md) |
| H5 | Open | `packages/protocol/src/app-config-defaults.ts:48`; [0070-h5-host-github-token-default.md](0070-h5-host-github-token-default.md) |
| M1 | Partly done | `apps/backend/src/gateway-proxy.ts:231`, `apps/backend/src/gateway-auth.ts:305` (commit `4f9cf3b32`); remainder in [0020-m1-isolated-preview-default.md](0020-m1-isolated-preview-default.md) |
| M2 | Done | `apps/backend/src/core/preview-runtime.ts:238`, `apps/backend/src/gateway-handlers.ts:442-444`, `apps/backend/src/gateway-proxy.ts:234-235`, `apps/desktop/electron/remote-gateway-request-auth.ts:75`; commit `71fb369be` |
| M3 | Done | `apps/backend/src/core/commands-registry-mail.ts:278-288`, `apps/backend/src/core/commands-secret-sweep.test.ts`; commit `6c7539617` |
| M4 | Done | `bridges/claude-bridge/src/services/read-only-policy.ts:245`, `:704-713`, `bridges/claude-bridge/src/services/runtime-env.ts:215`; commits `7e3ceb7ce`, `f2f842514` |
| M5 | Done | `apps/backend/src/core/setup-approval.ts:55`, `:186`, `apps/backend/src/core/commands-environment.ts:1024-1031`; commit `f2f842514` |
| M6 | Open | No policy in `apps/web/index.html` or `apps/backend/src/gateway-proxy.ts:700`; [0050-m6-renderer-csp.md](0050-m6-renderer-csp.md) |
| M7 | Open | `apps/desktop/electron/window.ts:120`, `apps/desktop/electron/workspace-views.ts:230`; [0060-m7-preload-sandbox.md](0060-m7-preload-sandbox.md) |
| M8 | Done | `apps/backend/src/core/portable-inputs.ts:333`, `apps/backend/src/core/claude-container-config.ts:62`, `docker/entrypoint.sh:898`; commit `6ae99a3ed`; legacy raw mount stays with M9 |
| M9 | Partly done | Per-environment notice only (`apps/backend/src/core/portable-input-status.ts:170`, `apps/web/src/components/environments/EnvironmentInputsSection.tsx:104`); remainder in [0080-m9-legacy-host-mounts.md](0080-m9-legacy-host-mounts.md) |
| M10 | Done | `apps/backend/src/core/coordinator-worker-mail.ts:417-434`, `docs/architecture/coordinator.md:1178-1205`; commit `5161688cf`; a reason and user approval replace the report's outright refusal, and a message within 3 hours of a sent one goes at once |
| M11 | Open | `apps/backend/src/core/coordinator-worker-mail.ts:405-408`, `packages/protocol/src/agent-mail.ts:940`; [0090-m11-coordinator-delegation-scope.md](0090-m11-coordinator-delegation-scope.md) |
| M12 | Open | `docker/init-firewall.sh:140-155`, no proxy or resolver in `docker/Dockerfile`; [0100-m12-egress-sni-and-dns.md](0100-m12-egress-sni-and-dns.md) |
| M13 | Done | `bridges/codex-bridge/src/codex-config.ts:521`, `bridges/acp-bridge/src/acp-policy.ts:144`, `bridges/acp-bridge/src/acp-context.ts:1146`; commit `4cdc39fb6`; the app-server's own `/proc` entry belongs to H4 |
| L1 | Done | `apps/backend/src/core/commands-environment.ts:2303-2306`, `apps/backend/src/core/commands-project-files.ts:80`, `:94`; commit `f2f842514` |
| L2 | Open | `apps/backend/src/core/commands-containers.ts:970`, `apps/backend/src/core/commands-server-health.ts:31-36`; [0120-l2-tokens-in-docker-exec-argv.md](0120-l2-tokens-in-docker-exec-argv.md) |
| L3 | Done | `package.json:52-57`; commit `cb81012f9` |
| L4 | Done | `apps/desktop/electron/dev-mode.ts:28-32`, `apps/desktop/electron/main.ts:208`; commit `cb81012f9` |
| L5 | Open | Handlers only in `apps/desktop/electron/browser-preview-startup.ts:54-55` and `apps/desktop/electron/artifact-host-session.ts:432-435`; [0130-l5-renderer-permission-handler.md](0130-l5-renderer-permission-handler.md) |
| L6 | Open | `apps/web-public/public/install.sh:13`, `scripts/publish-cli.ts:22-37`, `packages/protocol/src/node/standalone-service.ts:343-352`; [0140-l6-release-signing-and-pinning.md](0140-l6-release-signing-and-pinning.md) |
| L7 | Done | `apps/backend/src/core/commands-environment-fork.ts:127`, `:141`, `apps/backend/src/core/commands-agent-support.ts:277`, `apps/backend/src/core/commands-projects.ts:462` |
| L8 | Done | `apps/backend/src/core/commands-registry-terminal.ts:148`, `:926`, `:984`; commit `75743022e` |
| L9 | Done | `apps/backend/src/core/commands-files.ts:991`, `apps/backend/src/core/git-fsmonitor.ts:22`; commit `abe48fb37` |
| L10 | Open | `apps/backend/src/gateway-auth.ts:205-214`, `:764-771`; [0150-l10-gateway-host-check-and-login-throttle.md](0150-l10-gateway-host-check-and-login-throttle.md) |
| L11 | Done | `apps/backend/src/gateway-bind-policy.ts:33-46`, `apps/backend/src/main.ts:144`; commit `129cb2d32` |
| L12 | Partly done | `packages/cli/src/client/targets.ts:130-146`, `:215-222` (commit `b88623136`); remainder in [0160-l12-descriptor-process-binding.md](0160-l12-descriptor-process-binding.md) |
| L13 | Done | `apps/web/src/lib/chat/file-url.ts:68-73`; commit `5c760e3c8` |
| L14 | Done | `apps/backend/src/preview-relay-supervisor.ts:24`, `:355-373`, `:381-382`; commit `6cdd8115e` |
| L15 | Open | `apps/backend/src/core/index.ts:536`, `apps/backend/src/core/agent-tools.ts:977`; [0170-l15-agent-tools-bind-address.md](0170-l15-agent-tools-bind-address.md) |
| L16 | Partly done | Cursor and Pi policy fields closed by `2d4528dc5` and `a2bba9d80`; remainder in [0180-l16-control-mcp-and-reminder-soft-spots.md](0180-l16-control-mcp-and-reminder-soft-spots.md) |
| L17 | Open | `apps/backend/src/core/storage-config.ts:359-365`, `apps/backend/src/core/storage-database.ts:284`; [0190-l17-provider-secrets-at-rest.md](0190-l17-provider-secrets-at-rest.md) |
| L18 | Open | `bun.lock:2389`, `:2117`, `:1583`; [0110-l18-dependency-advisories.md](0110-l18-dependency-advisories.md) |
| I1 | Open | `apps/backend/src/core/nodes/node-routing.ts:21`, `:135`; [0200-i1-workspace-grant-allowlist.md](0200-i1-workspace-grant-allowlist.md) |
| I2 | Partly done | `docs/architecture/coordinator.md:352` is corrected, `README.md:19` and `docs/architecture/control-mcp.md:505` are not; [0210-i2-side-agent-doc-drift.md](0210-i2-side-agent-doc-drift.md) |
| I3 | Open | `apps/backend/src/core/commands-files.ts:2392-2394`, `docker/workspace-setup.sh:374-377`; [0220-i3-github-token-in-gitconfig.md](0220-i3-github-token-in-gitconfig.md) |
| I4 | No action | Maintainer decision that `no-new-privileges` stays off because the entrypoint is `sudo` (`docs/architecture/container-lifecycle.md:1099`, `docs/todo/containers-and-environments/0018-container-network-and-credential-isolation.md:961`); policy 1 survives only on images older than policy 2 and is kept until rebuilt (`apps/backend/src/core/container-network.ts:47-50`, `docs/architecture/container-lifecycle.md:555`) |
| I5 | Open | `apps/backend/src/preview-publication.ts:256-260`; [0230-i5-preview-publication-domain.md](0230-i5-preview-publication-domain.md) |
| I6 | Open | `.github/workflows/publish-container.yml:54`, `:68`; [0240-i6-checkout-persist-credentials.md](0240-i6-checkout-persist-credentials.md) |
| I7 | Partly done | `apps/backend/src/core/container-log-bounds.ts:29-31` (commit `20e2863e5`); remainder in [0250-i7-internal-token-prefix.md](0250-i7-internal-token-prefix.md) |
| §7 Gateway controls | No action | The report records these as correct and asks for nothing; spot-checked only where a finding touched them |
| §7 Electron controls | No action | As above; `apps/desktop/electron/browser-preview-manager.ts:1012` still sandboxes preview views |
| §7 Previews and artifacts controls | No action | As above; not re-audited |
| §7 Filesystem and exec controls | No action | As above; not re-audited |
| §7 Containers controls | No action | As above; not re-audited |
| §7 MCP, mail and policy controls | No action | As above; not re-audited |
| §7 Secrets and supply chain controls | No action | As above; not re-audited |
| §8 User commands not reviewed | No action | Read for this split: reachable only from the composer, never Control MCP or agent tools, and the command is passed as an argument (`apps/backend/src/core/commands-registry-user-commands.ts:26-32`, `apps/backend/src/core/user-command-container.ts:17-36`, `docs/architecture/user-commands.md:91-94`) |
| §8 Validation worker spot-checked | No action | Read for this split: commands come from the environment's own preparation agent and run in that environment with the agent's privileges, so no boundary is crossed (`apps/backend/src/core/review-validation-worker.ts:287`, `docs/architecture/review-preparation.md:5-10`); not a full audit |
| §8 `tmux-hooks` `find` not reviewed | No action | Read for this split: the path is quoted and the other value is a number (`apps/backend/src/core/tmux-hooks.ts:966-968`, `apps/backend/src/core/tmux-shared.ts:299-301`, `:700`) |
| §8 Pi's `grep` and `find` tools | No action | They live in the Pi SDK outside this repository, and the report asks for nothing |
| §8 iOS app not reviewed | Open | [0270-s8-ios-app-review.md](0270-s8-ios-app-review.md) |
| §8 Dynamic testing | Open | [0260-s8-dynamic-browser-and-docker-tests.md](0260-s8-dynamic-browser-and-docker-tests.md) |
| §9 step 1 (H1 + M1) | Partly done | [0010-h1-gateway-cookie-remainder.md](0010-h1-gateway-cookie-remainder.md), [0020-m1-isolated-preview-default.md](0020-m1-isolated-preview-default.md) |
| §9 step 2 (H3) | Done | See H3 |
| §9 step 3 (H2) | Partly done | [0030-h2-retire-in-container-firewall.md](0030-h2-retire-in-container-firewall.md) |
| §9 step 4 (M3) | Done | See M3 |
| §9 step 5 (H4 + M13) | Partly done | [0040-h4-bridge-credential-remainder.md](0040-h4-bridge-credential-remainder.md); M13 is done |
| §9 step 6 (M4, M5, L1) | Done | See M4, M5 and L1 |
| §9 step 7 (M6, M7, L3, L4) | Partly done | [0050-m6-renderer-csp.md](0050-m6-renderer-csp.md), [0060-m7-preload-sandbox.md](0060-m7-preload-sandbox.md); L3 and L4 are done |
| §9 step 8 (H5, M8, M9) | Partly done | [0070-h5-host-github-token-default.md](0070-h5-host-github-token-default.md), [0080-m9-legacy-host-mounts.md](0080-m9-legacy-host-mounts.md); M8 is done |
| §9 step 9 (L18, remaining Low and Info) | Partly done | [0110-l18-dependency-advisories.md](0110-l18-dependency-advisories.md) to [0250-i7-internal-token-prefix.md](0250-i7-internal-token-prefix.md) |
