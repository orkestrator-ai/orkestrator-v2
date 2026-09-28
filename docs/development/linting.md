# Formatting and linting

Status: Living — oxfmt/oxlint configuration, severity policy and its rationale.

The short rules live in the root `AGENTS.md`. This guide keeps the reasons.

Formatting is [oxfmt](https://oxc.rs) (`.oxfmtrc.json`), linting is
[oxlint](https://oxc.rs) (`.oxlintrc.json`). Both are single Rust binaries and
run over the whole repo in well under a second, so there is no turbo task and no
per-package config — always run them from the repo root.

```bash
mise run format         # rewrite files in place
mise run format:check   # verify only; what CI runs
mise run lint           # report; fails on errors, not warnings
mise run lint:fix       # apply the auto-fixable subset
mise run check          # format:check && lint && typecheck
```

`.github/workflows/lint.yml` runs `format:check` and `lint` on every pull
request. The lint step uses `if: ${{ !cancelled() }}` so a formatting failure
does not hide lint output — one push reports both.

## What is excluded, and why

`bridges/codex-bridge/src/app-server/generated/**` is excluded from both tools.
It is a lockfile: `mise run verify:codex:protocol` regenerates it and compares
byte-for-byte, so reformatting it would fail that check against a generator this
repo does not control. `test-fixtures/**` is excluded from linting because those
files deliberately contain failing and malformed code.

Markdown and `docs/**` are excluded from oxfmt. The prose in this repo is
hand-wrapped and several documents are read as much as they are rendered;
reflowing them would produce churn with no reader benefit.

## Severity policy

`correctness` is the only enabled category, and it is an error — a failing lint
is a real defect, not a style opinion. The one exception is `no-unused-vars`,
which is a **warning**: the repo carries ~3,150 pre-existing unused imports and
declarations, and removing them is judgement work rather than a mechanical fix.
Clean them up opportunistically in files you are already touching. Do not
silence the rule, and do not raise it to `error` until the backlog is actually
gone.

The `jsx-a11y` plugin is not enabled. Its interaction rules reported 58
findings that are real accessibility gaps, but fixing them means adding keyboard
handlers, roles and focus targets to live UI — behaviour changes that belong in
their own reviewed change, not in a lint rollout. Turning the plugin back on is
a deliberate decision with that work attached, not a config tidy-up.

`no-control-regex` is off. Orkestrator strips ANSI escapes and control
characters as a matter of course — terminal output, tmux capture, transcript
sanitising — so a control character in a regex here is the intent rather than
the typo the rule is looking for.

Warnings never fail the build, so `mise run lint` exiting `0` means zero errors,
not zero findings. Read the output.

## Disable directives

Reach for a disable directive only when the rule is wrong about that specific
site, and always with the reason immediately above it. Placement is fiddly:

- `// oxlint-disable-next-line <rule>` must sit above the **reported** line,
  which is not always the line you expect. For `react/no-did-update-set-state`
  it is the `setState` call, not the method declaration.
- `react-hooks/exhaustive-deps` does not honour the next-line form at all.
  Wrap the whole hook in `/* oxlint-disable react-hooks/exhaustive-deps */` and
  `/* oxlint-enable react-hooks/exhaustive-deps */` instead.

Before suppressing an `exhaustive-deps` finding, check whether the dependency is
genuinely missing. Most of them were. The ones that are not share a shape: the
value has a new identity every render (a memo keyed on something coarser, an
object rebuilt per poll), so adding it re-runs the hook far more often than the
author intended — refetching, re-arming a debounce, or resetting a tab the user
is looking at.

## Iterating a collection you are about to mutate

Write `for (const x of Array.from(collection))`, not `for (const x of [...collection])`.

Both materialise a snapshot, and the snapshot is load-bearing wherever the loop
body deletes from the collection it is walking — `destroy`, `retire`,
`untrack`, `respond` and friends all do. Map and Set iterators are live, so
dropping the copy makes the loop skip entries.

`unicorn/no-useless-spread` cannot see that mutation and flags the spread form
as redundant; its suggested fix silently introduces the skip. `Array.from`
is exactly equivalent, says "materialise this" out loud, and is not flagged.

## The formatting baseline commit

The repo was formatted in one commit, listed in `.git-blame-ignore-revs`. To
keep `git blame` readable locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub applies that file automatically.
