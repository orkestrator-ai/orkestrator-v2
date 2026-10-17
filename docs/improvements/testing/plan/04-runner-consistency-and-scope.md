# 04 — Align test entrypoints and report suite scope

Status: Not started. Depends on: none. Findings: T3 and optional-suite reporting.

[Plan index](00-index.md) · [Previous](03-validation-status-and-ui.md) ·
[Next](05-browser-fixture-ownership.md)

## Outcome

Make a documented root-unit run use the same file isolation and setup as the
root portion of aggregate validation. Add a machine-readable account of the
suites requested, executed, omitted, or unavailable so aggregate success does
not conceal scope limitations.

## Owners and current behavior

- `mise.toml`: `test:unit`, `test`, `test:changed`, `test:all`, and logged tasks.
- `scripts/test-all.ts`: group construction, admission, diagnostics, summary,
  protocol fallback, and the conditional iOS branch.
- `scripts/test-admission.ts`: cooperative scheduler state.
- `scripts/run-logged.ts`: one-command wrapper using shared diagnostics.
- `bunfig.toml`, `tests/setup.ts`, `tests/register-dom.ts`, and
  `tests/setup-node.ts`: discovery and preloads.
- `tests/unit/mise-tasks.test.ts`, `monorepo-scripts.test.ts`,
  `test-all.test.ts`, and `run-logged.test.ts`: existing contract/runner tests.

The root-unit shortcut currently omits the aggregate's isolated parallel mode.
The aggregate's four groups already have bounded worker allocation; keep that
allocation and current root/support-file scope intact.

## Part A — entrypoint consistency

- [ ] Change the root-unit task to use `./tests/unit` and an explicit bounded
      isolated worker count. Start with `--parallel=1`; do not inherit an
      unbounded machine-wide count for a focused shortcut.
- [ ] Retain root-unit scope. Do not quietly expand it to all root/support or
      workspace tests just to make task names look similar.
- [ ] Compare preloads, environment defaults, and file paths between focused,
      root-unit, and aggregate-root runs. Document intentional scope differences.
- [ ] Audit nearby documented focused invocations for explicit paths and the
      required logged wrapper. Do not rewrite historical flake records.
- [ ] Add a small task contract check for scope and bounded isolation, plus a
      representative real run containing real native adapters and mocked users.
      Avoid asserting the entire task command as one brittle source string.
- [ ] If a failure is exposed, diagnose file globals/import order/mock behavior
      using the Bun testing skill. Keep one module graph per file; do not hide
      leakage by disabling isolation or renaming/reordering files.

## Part B — explicit scope metadata

Add a versioned suite inventory to the runner summary while retaining existing
group exit codes, artifact paths, and timeout fields. Proposed inventory fields:

| Field | Purpose |
| --- | --- |
| Stable suite ID | Workspace, root/support, bridge, protocol, iOS, or separate browser/native suite |
| Request state | Included by this entrypoint, explicitly requested, or outside its scope |
| Execution state | Executed, not selected, unavailable, blocked, cancelled, or failed to start |
| Validation depth | Full execution, changed-only selection, or reduced/offline compatibility check |
| Reason code | Missing platform/tool, failed prerequisite, queue deadline, cancellation, or intentionally separate workflow |
| Evidence reference | Group result/artifact reference when execution produced evidence |

Keep command content in private evidence; the inventory should use stable suite
IDs and bounded diagnostic reasons. Do not infer “executed tests” from the
presence of a successful build or cached prerequisite.

- [ ] Represent iOS requested by `test:all` but unavailable on Linux explicitly.
      Keep the documented aggregate exit behavior for backward compatibility;
      a dedicated iOS-required job must require an executed iOS result.
- [ ] Record iOS blocked by earlier failures, not merely absent from the list.
- [ ] Identify browser/native suites as outside the default aggregate's scope.
      These are not failed requirements unless the caller required them.
- [ ] Record changed-only scope and baseline identity without implying full
      validation. A stale/missing baseline must be explicit.
- [ ] Surface the Codex protocol offline fallback as reduced validation depth.
      Do not relabel a check of committed files as full regeneration.
- [ ] Extend cooperative metadata in a bounded backward-compatible way so
      in-app validation can consume scope without parsing console output.
      Absence in an older runner is unknown, not assumed full coverage.
- [ ] Preserve distinct exit semantics for assertion failure and infrastructure
      unavailability. Scope annotation must not override the real exit status.

## Tests

Cover Linux `test:all`, macOS with/without Xcode, explicit developer directory,
ordinary `test`, changed-only selection, protocol binary absent/present, failure
before iOS, queued cancellation, and malformed legacy/new summaries.

Use injected platform/capability checks for unit tests. Do not require an actual
simulator for summary construction. Platform execution proof belongs to step 09.
Verify the UI/backend adapter does not treat an unavailable requested suite as
satisfied merely because the aggregate exited zero.

## Verification and acceptance

Run owning task/runner tests, a logged root-unit run, and `mise run test` after
the targeted behavior is stable. Compare selected files and summary metadata;
counts need not be equal across intentionally different scopes.

Acceptance: isolation semantics are consistent, optional suites have explicit
scope records, existing summaries remain readable, and worker admission/log
bounds still hold. Update the testing guide alongside the task change.

## Delivery notes

Split entrypoint alignment and summary metadata into separate PRs if necessary.
The first is small and independently useful. Do not block it on UI or CI work.
Do not introduce new environment overrides for concurrency without a measured
need and the same host-capacity rules used by existing launchers.
