# Security review: outstanding work

What is left to do from the [security review](../2-26-10-27-security.md).

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.

A batch file combines several reports as numbered parts and takes the rating of its most serious part. A number such as `0720` in this index names a part or a file, and the table below shows where it lives.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0080-m9-legacy-host-mounts.md](0080-m9-legacy-host-mounts.md) | High | No | M9: new containers from old images, and listing affected environments | Whole host agent homes reach any container from an older image, though current images are not affected. |
| 2 | [0090-x1-coordinator-trust-boundary.md](0090-x1-coordinator-trust-boundary.md) | High | No | **X1, Coordinator trust boundary.**<br>`Security 0090`: M11: delegation scope and marking mail-originated delegations<br>`Security 0180`: L16: operator token reads, confirm token wording, self-reminder framing<br>`Security 0210`: I2: two stale statements about side agents<br>`Coordinator 0120`: Labelling the home in `list_environments` and a live read-only step for the message gate.<br>`Coordinator 0310`: Refusing `adopt_workflow` from a side agent. | From `Security 0090`: An injected worker can reach a user-created environment under its looser policy, limited only by framing and budgets. |
| 3 | [0100-m12-egress-sni-and-dns.md](0100-m12-egress-sni-and-dns.md) | High | No | M12: SNI enforcement, DNS filtering, default allowlist, user-facing statement | Shared edges, attacker credentials and DNS remain working exfiltration channels from a restricted container. |
| 4 | [0170-l15-agent-tools-bind-address.md](0170-l15-agent-tools-bind-address.md) | Medium | No | L15: agent-tools server on `0.0.0.0` | The server is token-protected, so the wider bind adds reach for a leaked token rather than a direct way in. |
| 5 | [0020-m1-isolated-preview-default.md](0020-m1-isolated-preview-default.md) | Low | No | M1: legacy route retirement, and the two-machine run the default flip went ahead without | The sandbox header already closes the top-level path. The default is flipped; retirement waits on the support window in todo 0042. |
| 6 | [0110-l18-dependency-advisories.md](0110-l18-dependency-advisories.md) | Low | No | L18: `undici`, `postcss-selector-parser`, Electron 45.x | The advisories are already accepted and blocked upstream in todo 0032. |
| 7 | [0160-l12-descriptor-process-binding.md](0160-l12-descriptor-process-binding.md) | Low | No | L12: pid reuse by the same user | It needs a crashed backend, pid reuse and a co-tenant on the old port all at once. |
| 8 | [0190-l17-provider-secrets-at-rest.md](0190-l17-provider-secrets-at-rest.md) | Low | No | L17: provider secrets in plaintext at 0600 | The report only says to consider it, and only a same-uid process can read the file. |

## Parallel running

The full plan, with every lane across all four folders, is in [batches.md](../batches.md).

Batches in the same lane run one at a time, in the order shown. Batches in different lanes can run together unless **Not at the same time as** names the other one. A batch with no lane only has to respect that column.

This index only changes when a branch merges, so it can't show what is running now. Before starting a batch, check the running environments and open PRs for its lane and its **Not at the same time as** list. Put the batch ID in the environment and branch name so that check can find it.

### Batches

| Batch | Name | Parts | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| X1 | [Coordinator trust boundary](0090-x1-coordinator-trust-boundary.md) | `0090`, `0180`, `0210`; also coordinator `0120` task 1, `0310` | Coordinator backend, 1 of 3 | None | None |

Why these are grouped:

- **X1:** What a coordinator or side agent may reach, and how its mail is framed. `0120` task 2 is a live check and can run separately.

### Files built on their own

These still follow the lane and conflict rules above.

| Batch | Name | Files | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| S-0080 | [Legacy host mounts](0080-m9-legacy-host-mounts.md) | `0080` | Containers, 1 of 4 | None | None |
| S-0100 | [Egress SNI and DNS](0100-m12-egress-sni-and-dns.md) | `0100` | Containers, 2 of 4 | None | None |
| S-0170 | [Agent-tools bind address](0170-l15-agent-tools-bind-address.md) | `0170` | Containers, 3 of 4 | None | None |
| S-0190 | [Provider secrets at rest](0190-l17-provider-secrets-at-rest.md) | `0190` | Storage, 2 of 2 | None | None |
| S-0160 | [Descriptor process binding](0160-l12-descriptor-process-binding.md) | `0160` | Gateway, 3 of 3 | None | None |

### Not ready to start

When one of these becomes ready, it joins the lane shown.

| File | Why it waits | Lane |
| --- | --- | --- |
| [`0020`](0020-m1-isolated-preview-default.md) | Default flipped; retirement blocked on todo 0042 | Gateway |
| [`0110`](0110-l18-dependency-advisories.md) | Blocked upstream in todo 0032 | No lane |

## Status of every finding

33 done, 15 partly done, 5 open, 12 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| H1 | Partly done | `apps/backend/src/gateway-sessions.ts:73-75`, `apps/backend/src/gateway-auth.ts:135-138` (commit `4f9cf3b32`); the leaked-session exposure is accepted in `docs/architecture/remote-gateway.md`, Security notes; the `__Host-` name remains in [todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md) |
| H2 | Done | `apps/backend/src/core/container-scripts.ts:13-20`, `docker/container-zshrc.zsh:20-24` (commit `5fc5982aa`); cap removed from `egressEnforcement` (`apps/backend/src/core/egress-gateway.ts`); runtimes without a gateway keep the in-container firewall until rebuilt, and rootless gateway checks stay with [todo 0018](../../todo/containers-and-environments/0018-container-network-and-credential-isolation.md) task 2 |
| H3 | Done | `apps/backend/src/core/container-project-seed-files.ts:66-110`; no project file in `bindIfExists` calls (`apps/backend/src/core/commands-containers.ts:503-559`); commit `1565c7c16` |
| H4 | Partly done | `packages/protocol/src/node/bridge-credential.ts` (a bridge holds a verifier and is non-dumpable), `apps/backend/src/core/container-bridge-credential.ts` (root-only token), `apps/backend/src/core/native-agent-session-operations.ts` (a user's widening), `packages/protocol/src/execution-policy-narrowing.ts`; `apps/backend/src/core/agent-credential-files.ts` (OpenCode's credential plugin, [4981](../../todo/containers-and-environments/4981-opencode-password-readable-by-agent.md)); `apps/backend/tests/bridge-credential-docker.test.ts` on a real container. Remainder in [4980](../../todo/containers-and-environments/4980-agent-uid-process-control.md) and [4982](../../todo/containers-and-environments/4982-bridge-credential-live-evidence.md) |
| H5 | Done | `packages/protocol/src/app-config-defaults.ts:51`, `apps/backend/src/core/github-credentials.ts:31`; [container credential](../../architecture/github-cli.md#container-credential). New installs share nothing; an upgraded install keeps its current sharing, with a scope warning, until the user changes it. Per-environment repo-scoped credentials were not built. |
| M1 | Partly done | `apps/backend/src/gateway-proxy.ts:231`, `apps/backend/src/gateway-auth.ts:305` (commit `4f9cf3b32`); remainder in [0020-m1-isolated-preview-default.md](0020-m1-isolated-preview-default.md) |
| M2 | Done | `apps/backend/src/core/preview-runtime.ts:238`, `apps/backend/src/gateway-handlers.ts:442-444`, `apps/backend/src/gateway-proxy.ts:234-235`, `apps/desktop/electron/remote-gateway-request-auth.ts:75`; commit `71fb369be` |
| M3 | Done | `apps/backend/src/core/commands-registry-mail.ts:278-288`, `apps/backend/src/core/commands-secret-sweep.test.ts`; commit `6c7539617` |
| M4 | Done | `bridges/claude-bridge/src/services/read-only-policy.ts:245`, `:704-713`, `bridges/claude-bridge/src/services/runtime-env.ts:215`; commits `7e3ceb7ce`, `f2f842514` |
| M5 | Done | `apps/backend/src/core/setup-approval.ts:55`, `:186`, `apps/backend/src/core/commands-environment.ts:1024-1031`; commit `f2f842514` |
| M6 | Done | `packages/protocol/src/renderer-content-security-policy.ts`, `apps/web/vite-plugin-renderer-security.ts`, `apps/backend/src/gateway-proxy.ts` (`staticDocumentContentSecurityPolicy`), [renderer-security.md](../../architecture/renderer-security.md); Trusted Types and an invoke allowlist were considered and not adopted, with the reasons there |
| M7 | Done | `apps/desktop/scripts/electron-bundle.ts` (`ELECTRON_PRELOAD_ENTRYPOINTS`), `sandbox: true` in `apps/desktop/electron/window.ts`, `apps/desktop/electron/workspace-views.ts`, `apps/desktop/electron/toolchain-bootstrap-window.ts` |
| M8 | Done | `apps/backend/src/core/portable-inputs.ts:333`, `apps/backend/src/core/claude-container-config.ts:62`, `docker/entrypoint.sh:898`; commit `6ae99a3ed`; legacy raw mount stays with M9 |
| M9 | Partly done | Per-environment notice only (`apps/backend/src/core/portable-input-status.ts:170`, `apps/web/src/components/environments/EnvironmentInputsSection.tsx:104`); remainder in [0080-m9-legacy-host-mounts.md](0080-m9-legacy-host-mounts.md) |
| M10 | Done | `apps/backend/src/core/coordinator-worker-mail.ts:417-434`, `docs/architecture/coordinator.md:1178-1205`; commit `5161688cf`; a reason and user approval replace the report's outright refusal, and a message within 3 hours of a sent one goes at once |
| M11 | Open | `apps/backend/src/core/coordinator-worker-mail.ts:405-408`, `packages/protocol/src/agent-mail.ts:940`; [X1 part Security 0090](0090-x1-coordinator-trust-boundary.md#security-0090-limit-how-far-prompt-injection-can-spread-through-the-coordinator) |
| M12 | Open | `docker/init-firewall.sh:140-155`, no proxy or resolver in `docker/Dockerfile`; [0100-m12-egress-sni-and-dns.md](0100-m12-egress-sni-and-dns.md) |
| M13 | Done | `bridges/codex-bridge/src/codex-config.ts:521`, `bridges/acp-bridge/src/acp-policy.ts:144`, `bridges/acp-bridge/src/acp-context.ts:1146`; commit `4cdc39fb6`; the app-server's own `/proc` entry belongs to H4 |
| L1 | Done | `apps/backend/src/core/commands-environment.ts:2303-2306`, `apps/backend/src/core/commands-project-files.ts:80`, `:94`; commit `f2f842514` |
| L2 | Done | `launchContainerScript` (`apps/backend/src/core/container-bridge-credential.ts`); `apps/backend/tests/container-bridge-credential.test.ts`. Whether Docker Desktop exposes argv the same way no longer matters: the tokens are not in it |
| L3 | Done | `package.json:52-57`; commit `cb81012f9` |
| L4 | Done | `apps/desktop/electron/dev-mode.ts:28-32`, `apps/desktop/electron/main.ts:208`; commit `cb81012f9` |
| L5 | Done | `apps/desktop/electron/renderer-permissions.ts`, installed by `apps/desktop/electron/window.ts` and `apps/desktop/electron/main.ts` (`installPermissionPolicy`) |
| L6 | Partly done | `install.sh` pin: `apps/web-public/public/install.sh:6`, `scripts/pin-install-script.ts`, `tests/unit/install-script.test.ts`; `install.sh` Bun download checked against stated SHA-256s and first run from the release's lockfile: `apps/web-public/public/install.sh` (`install_bun`, `main`), `tests/unit/install-script-locked-run.test.ts`; updater lockfile: `packages/protocol/src/node/standalone-service.ts:350` (`installRelease`), `packages/cli/release-runtime/`, `packages/protocol/src/node/standalone-service-install.test.ts`; remainder in [5020](../../todo/cross-cutting/5020-signed-appimage-update-manifests.md) (signed AppImage manifests), [5021](../../todo/cross-cutting/5021-publish-npm-from-ci-with-provenance.md) (npm provenance) and [5022](../../todo/cross-cutting/5022-release-chain-live-evidence.md) (live evidence for the installer pin and the updater lockfile) |
| L7 | Done | `apps/backend/src/core/commands-environment-fork.ts:127`, `:141`, `apps/backend/src/core/commands-agent-support.ts:277`, `apps/backend/src/core/commands-projects.ts:462` |
| L8 | Done | `apps/backend/src/core/commands-registry-terminal.ts:148`, `:926`, `:984`; commit `75743022e` |
| L9 | Done | `apps/backend/src/core/commands-files.ts:991`, `apps/backend/src/core/git-fsmonitor.ts:22`; commit `abe48fb37` |
| L10 | Done | `apps/backend/src/gateway-host-policy.ts`, `apps/backend/src/gateway-credential-throttle.ts`, `apps/backend/tests/gateway-host-policy.test.ts`, `apps/backend/tests/gateway-credential-throttle.test.ts` |
| L11 | Done | `apps/backend/src/gateway-bind-policy.ts:33-46`, `apps/backend/src/main.ts:144`; commit `129cb2d32` |
| L12 | Partly done | `packages/cli/src/client/targets.ts:130-146`, `:215-222` (commit `b88623136`); remainder in [0160-l12-descriptor-process-binding.md](0160-l12-descriptor-process-binding.md) |
| L13 | Done | `apps/web/src/lib/chat/file-url.ts:68-73`; commit `5c760e3c8` |
| L14 | Done | `apps/backend/src/preview-relay-supervisor.ts:24`, `:355-373`, `:381-382`; commit `6cdd8115e` |
| L15 | Open | `apps/backend/src/core/index.ts:536`, `apps/backend/src/core/agent-tools.ts:977`; [0170-l15-agent-tools-bind-address.md](0170-l15-agent-tools-bind-address.md) |
| L16 | Partly done | Cursor and Pi policy fields closed by `2d4528dc5` and `a2bba9d80`; remainder in [X1 part Security 0180](0090-x1-coordinator-trust-boundary.md#security-0180-control-mcp-confirmation-operator-token-and-self-reminder-soft-spots) |
| L17 | Open | `apps/backend/src/core/storage-config.ts:359-365`, `apps/backend/src/core/storage-database.ts:284`; [0190-l17-provider-secrets-at-rest.md](0190-l17-provider-secrets-at-rest.md) |
| L18 | Open | `bun.lock:2389`, `:2117`, `:1583`; [0110-l18-dependency-advisories.md](0110-l18-dependency-advisories.md) |
| I1 | Done | Grants and the relay refuse the machine's administration: `WORKSPACE_ADMINISTRATION_COMMANDS` (`apps/backend/src/core/nodes/workspace-grant-scope.ts`) in `isWorkspaceExcludedCommand` (`apps/backend/src/core/nodes/node-routing.ts`); terminals stay allowed; an older realm's unchanged settings echo is answered (`isGlobalConfigEcho`). Tests: `apps/backend/tests/gateway-workspace-grant-scope.test.ts`, `apps/backend/src/core/nodes/workspace-grant-scope.test.ts`. Live two-node and older-realm checks in [todo 5740](../../todo/cross-cutting/5740-workspace-grant-scope-live-evidence.md) |
| I2 | Partly done | `docs/architecture/coordinator.md:352` is corrected, `README.md:19` and `docs/architecture/control-mcp.md:505` are not; [X1 part Security 0210](0090-x1-coordinator-trust-boundary.md#security-0210-correct-what-the-docs-say-a-side-agent-can-do) |
| I3 | Done | `docker/orkestrator-git-credential.sh`, `apps/backend/src/core/commands-files.ts:2429`; [container credential](../../architecture/github-cli.md#container-credential). An image older than `github-git-credential` keeps the rewrite. |
| I4 | No action | Maintainer decision that `no-new-privileges` stays off because the entrypoint is `sudo` (`docs/architecture/container-lifecycle.md:1099`, `docs/todo/containers-and-environments/0018-container-network-and-credential-isolation.md:961`); policy 1 survives only on images older than policy 2 and is kept until rebuilt (`apps/backend/src/core/container-network.ts:47-50`, `docs/architecture/container-lifecycle.md:555`) |
| I5 | Partly done | Publication warns, and does not refuse, when its domain shares a site with the app: `sameSiteWarning` (`apps/backend/src/preview-publication.ts`), `apps/backend/src/core/host-site.ts` (each `ts.net` tailnet name is its own site), shown in `apps/web/src/components/settings/PreviewSettings.tsx`; `apps/backend/src/preview-publication.test.ts`, `apps/backend/src/core/host-site.test.ts`. Live check on a real private zone in [5240](../../todo/previews-and-annotations/5240-same-site-preview-domain-live.md) |
| I6 | Done | `.github/workflows/publish-container.yml:71-72`, `tests/unit/publish-container-workflow.test.ts` |
| I7 | Done | `apps/backend/src/core/container-log-bounds.ts:29-31` (commit `20e2863e5`); `okb_` and `oka_` from `packages/protocol/src/node/bridge-credential.ts`, caught by `packages/protocol/src/secret-redaction.ts`. The gateway token keeps its format, part of the client contract |
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
| §8 iOS app not reviewed | Partly done | Reviewed on 2026-11-05 against `69a3b4ca5`: `isTrustedBridgeOrigin` and `loginFormBody` (`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`), `GatewayRedirectBlocker` (`apps/ios/OrkestratorMobile/Networking/GatewayConnectionValidator.swift`), with tests in `apps/ios/OrkestratorMobileTests/OrkestratorMobileTests.swift`; remainder in [5600](../../todo/cross-cutting/5600-ios-bridge-user-consent.md), [5601](../../todo/cross-cutting/5601-ios-runtime-security-checks.md) (device and signed-build checks) and [5602](../../todo/cross-cutting/5602-ios-session-and-privacy-hardening.md) |
| §8 Dynamic testing | Partly done | H1, M1 and M2 in Chromium, Firefox and WebKit (`e2e/preview/gateway-browser-security.spec.ts`); H3 on Docker Desktop and rootless, and gateway reach on Docker Desktop and Linux Engine (`docs/development/container-qualification.md`); shipping Safari remains in [todo 5500](../../todo/previews-and-annotations/5500-shipping-safari-gateway-security-checks.md) |
| §9 step 1 (H1 + M1) | Partly done | [Todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md), [0020-m1-isolated-preview-default.md](0020-m1-isolated-preview-default.md) |
| §9 step 2 (H3) | Done | See H3 |
| §9 step 3 (H2) | Done | See H2 |
| §9 step 4 (M3) | Done | See M3 |
| §9 step 5 (H4 + M13) | Partly done | The remainder of H4 is [4980](../../todo/containers-and-environments/4980-agent-uid-process-control.md) and [4982](../../todo/containers-and-environments/4982-bridge-credential-live-evidence.md); M13 is done |
| §9 step 6 (M4, M5, L1) | Done | See M4, M5 and L1 |
| §9 step 7 (M6, M7, L3, L4) | Done | See M6, M7, L3 and L4 |
| §9 step 8 (H5, M8, M9) | Partly done | [0080-m9-legacy-host-mounts.md](0080-m9-legacy-host-mounts.md); H5 and M8 are done |
| §9 step 9 (L18, remaining Low and Info) | Partly done | [0110-l18-dependency-advisories.md](0110-l18-dependency-advisories.md) to [0190-l17-provider-secrets-at-rest.md](0190-l17-provider-secrets-at-rest.md); I5 is partly done (see I5) |
