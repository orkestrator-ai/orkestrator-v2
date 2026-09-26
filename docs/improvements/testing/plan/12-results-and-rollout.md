# 12 — Add structured reporting and complete rollout

Status: Not started. Depends on: 01–11 for final rollout. Structured case-report
adapters are optional and must not block closure of the core findings.

[Plan index](00-index.md) · [Previous](11-flakes-and-test-quality.md)

## Outcome

Complete the cross-layer rollout with consistent documentation, compatibility,
and actual acceptance evidence. Optionally add structured test-case summaries
where a runner already provides a trustworthy report; do not infer test counts
or failures by scraping arbitrary terminal text.

## Part A — optional structured result adapters

The current command evidence model is valid without case reports. Extend it
only when a concrete report format improves navigation or completeness.

Start with the existing Playwright JSON output because the repository already
produces it. Add other formats only with a named consumer and versioned parser.
Verify supported reporter APIs against current official documentation before
changing tool configuration; do not assume the pinned Bun exposes a particular
reporter merely because another runner does.

### Proposed report contract

| Field | Meaning |
| --- | --- |
| Producer and schema version | Identifies the report adapter and accepted input |
| Command/run ID | Links to actual process evidence and prevents cross-run reuse |
| Availability | Available, absent, malformed, truncated, unsupported, or expired |
| Counts | Passed/failed/skipped/total as explicitly reported, not estimated |
| Bounded failure entries | Case identity, concise message, source location if supplied, artifact pointer |
| Capture completeness | Whether parsing/accounting reached the full report within limits |
| Digest/relative path | Immutable evidence reference sealed with the package |

Proposed starting parser bounds: 16 MiB input, 20,000 counted cases, 256 retained
failure summaries, and 4 KiB per textual summary. If a limit is exceeded, retain
bounded evidence and mark the report partial. Do not present truncated counts as
an exact total unless the producer supplied a separately validated total.

### Tasks

- [ ] Read reports from explicit workspace-relative paths attached to a command;
      enforce containment, regular-file ownership, size bounds, and no symlink
      escapes. Never accept an arbitrary absolute path from agent output.
- [ ] Parse after the command settles and before sealing. Hash the completed
      report and record provenance; a same-named file from an earlier run must
      not be adopted as fresh evidence.
- [ ] Keep the process exit status authoritative. A report claiming all tests
      passed cannot overwrite a nonzero exit; a report with failures and exit
      zero becomes an explicit inconsistent-evidence condition.
- [ ] Treat an absent optional report as unavailable detail, not a failed test.
      A repository-required report that cannot be read is incomplete evidence.
- [ ] Keep case names/messages in bounded private evidence and user-requested
      detail views. Do not put them into operational metrics or public CI
      annotations without sanitization.
- [ ] Display structured counts only when present. Continue displaying command
      counts for arbitrary shell checks and old records.
- [ ] Integrate report availability with step 10 retention and immutable package
      hashing. Expired reports must not leave apparently live detail links.
- [ ] If an XML/JUnit adapter is later added, disable external entity/network
      resolution and bound nesting, strings, and records. Do not add an XML
      dependency before that adapter is actually in scope.

### Verification

Test valid reports, no tests, skipped-only suites, malformed JSON, oversized
input, mismatched run IDs, stale files, contradictory exits, truncated failures,
and expired evidence. Retain a valid command result even when optional parsing
fails. Update lockfiles only if dependencies/recorded manifest metadata change.

## Part B — final integration audit

- [ ] Exercise the completion matrix in the index against the implementation.
      Reference actual command/browser/CI evidence for every closed finding.
- [ ] Load legacy and new persisted workflows, including one active run across
      backend recreation. Ensure no implicit redispatch or evidence upgrade.
- [ ] Verify manual review, looped review, and build-pipeline assessment agree.
      Confirm review can still analyze failure evidence without claiming success.
- [ ] Verify a source-drift run stays qualified after package sealing and later
      renderer reload. Check old hashed packages remain byte-for-byte unchanged.
- [ ] Check CI artifacts on both a failed and passing run, with executed and
      omitted scope represented correctly.
- [ ] Verify retention under pressure with active/pinned data and after restart.
      Confirm expired UI output has an explicit state rather than repeated errors.
- [ ] Confirm fixture cleanup on local, browser CI, native, and container paths.
- [ ] Run required owning tests, relevant browser/platform lanes, static checks,
      and the default aggregate for the final implementation change. Use iOS
      execution on a qualified host for the release-sensitive verification.

## Documentation and handoff

Update these living documents when the corresponding behavior ships:

- `docs/development/testing-guide.md`: entrypoint scope, summary fields,
  evidence interpretation, and when each suite is required.
- `docs/development/agent-testing.md`: credential-free deterministic fixtures,
  live-provider distinction, ownership, startup, cleanup, and failure evidence.
- `docs/development/test-logs.md`: local versus CI versus in-app retention.
- `docs/architecture/review-preparation.md`: actual source guarantee,
  requirements/completeness, legacy compatibility, and retained evidence.
- `docs/README.md`: catalog entry for this plan and correct status after delivery.
- The source review: append implementation references/status rather than
  rewriting what the static review originally observed.

Document any newly introduced field or setting where its owner lives. Do not
copy long invariant lists into multiple runbooks. Keep CLI examples aligned with
the existing task-contract tests and avoid inventing root package scripts.

## Release checklist

- [ ] Index and step statuses reflect reality; unimplemented optional adapters
      are explicitly deferred rather than described as shipped.
- [ ] All eight review findings have implementation/evidence references or a
      concrete remaining limitation. High-priority findings cannot disappear
      into a generic “tests improved” statement.
- [ ] Required CI check names and suggested branch-protection changes are
      documented for a human maintainer; no agent merges into `main`.
- [ ] New readers accept old data; unsupported new formats fail clearly.
- [ ] Retention rollback/admission behavior is documented, including pinned
      over-budget legacy data.
- [ ] Test profiles are stopped/reset or intentionally retained with exact
      identity and reason. No temporary fault injection remains in code.
- [ ] Final handoff names tested commit, commands, outcomes, artifacts, missing
      platform/provider scope, and unresolved risks.

## Completion rule

Close the core improvement plan when T1–T8 meet their acceptance criteria with
actual evidence and the documentation describes the shipped behavior. Optional
case-report adapters may remain a separately tracked enhancement. A generated
plan, a passing unit suite alone, or configured-but-never-run CI is not completion
of the corresponding implementation step.
