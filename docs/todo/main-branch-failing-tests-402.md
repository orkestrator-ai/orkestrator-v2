# Two deterministic test failures on `main` from PR #402

Status: open as of 2026-08-16. Both failures are reproducible, deterministic,
and unrelated to each other in mechanism but share one origin commit.

`bun run test` is red on `main`. Two cases fail every time, in both aggregate
and isolated runs, so neither belongs in
[`docs/flaky-tests.md`](../flaky-tests.md) — that document is for tests whose
result varies between runs. These do not vary.

Both were introduced by `724f6326` — `feat(model-picker): support ordered
favorite models (#402)`, merged 2026-08-15 21:19 +0100. Six commits have landed
on `main` since; none of them touches the affected files, so the failures have
been on `main` continuously since #402 merged.

| # | Test | File | Mechanism |
| --- | --- | --- | --- |
| 1 | `bounded test diagnostics > never passes a DOM-producing query result directly to toBeNull` | `tests/unit/test-diagnostic-bounds.test.ts:28` | False positive in the repo's own static scanner |
| 2 | `CreateEnvironmentFlowDialog > restores the durably remembered selection after closing and reopening` | `tests/unit/components/CreateEnvironmentFlowDialog.test.tsx:766` | Assertion left behind by a mid-PR behaviour change |

## Reproduction and evidence baseline

Everything below was reproduced at base commit `94c8878429981e0864aa5d4aee7fe8a9e5db9bf3`,
in a throwaway `git worktree` with `node_modules` symlinked from a populated
checkout, to prove the failures are not caused by any in-progress branch work.

```bash
git worktree add /tmp/ork-baseline-check 94c8878429981e0864aa5d4aee7fe8a9e5db9bf3
# link root and per-package node_modules from a populated checkout
bun test ./tests/unit/test-diagnostic-bounds.test.ts \
  -t "never passes a DOM-producing query result directly to toBeNull"
bun test ./tests/unit/components/CreateEnvironmentFlowDialog.test.tsx \
  -t "restores the durably remembered selection after closing and reopening"
```

Both failed identically in the baseline worktree and in the working checkout.

`main` has since advanced to `79afea8a` (`fix(acp-bridge): enrich settled Cursor
tool titles while a turn is still running (#407)`), which touches only
`bridges/acp-bridge/`, so it cannot have changed either result.

---

## Failure 1 — the DOM-absence scanner false-positives on a scalar

### What fails

```
tests/unit/test-diagnostic-bounds.test.ts:39
expect(received).toEqual(expected)

- []
+ [
+   "apps/web/src/components/chat/AgentModelPicker.test.tsx",
+ ]
```

### What the rule exists for

`tests/unit/test-diagnostic-bounds.test.ts` scans every `*.test.*` /
`*.spec.*` file under `tests/`, `apps/` and `bridges/` and fails if any of them
passes a DOM node straight into `.toBeNull()`. The reason is output volume: when
`expect(screen.queryByRole("button")).toBeNull()` fails, Bun serialises the
received value, and a received *element* prints its entire subtree. That is the
unbounded diagnostic output the rest of the test-logging work exists to prevent.
The sanctioned form is `expect(x === null).toBe(true)`, which prints `false`.

The rule is sound. The detector implementing it is not.

### Root cause

`tests/dom-assertion-safety.ts:36-46`:

```ts
const received = node.expression.expression.arguments[0];
let containsDomQuery = false;
const findQuery = (candidate: ts.Node): void => {
  if (
    ts.isCallExpression(candidate)
    && isDomProducingQuery(candidate.expression)
  ) containsDomQuery = true;
  else candidate.forEachChild(findQuery);
};
if (received) findQuery(received);
if (received && containsDomQuery) { /* flag */ }
```

`findQuery` walks the **entire** received expression looking for a DOM-producing
call *anywhere inside it*, then flags the assertion. It never asks what the
received expression as a whole evaluates to.

The two flagged assertions are `AgentModelPicker.test.tsx:1083` and
`AgentModelPicker.test.tsx:1091`, both identical:

```ts
expect(document.querySelector("[data-native-model-list]")?.getAttribute("data-favorite-reorder"))
  .toBeNull();
```

TypeScript parses this as a `CallExpression` whose callee is a
`PropertyAccessExpression` named `getAttribute`. `isDomProducingQuery` correctly
returns `false` for `getAttribute`, so the walker recurses into the children,
reaches the inner `querySelector(...)` call, and sets `containsDomQuery = true`.

But `getAttribute` returns `string | null`. The value handed to `expect` is a
scalar. There is no element to serialise and no unbounded output — the exact
hazard the rule guards against cannot occur here. This is a false positive.

The PR author was clearly aware of the rule: the line immediately between the
two offenders (`AgentModelPicker.test.tsx:1090`) is already written in the
sanctioned form:

```ts
expect(document.querySelector("[data-favorite-sortable]") === null).toBe(true);
```

They just did not realise the scanner also catches the attribute variant, and
the merge went in red.

### Blast radius

A survey of every `expect(...).toBeNull()` in the repo (`tests/`, `apps/`,
`bridges/`) found **718** such assertions, of which exactly **2** — the two
above — are the nested-DOM-query-with-scalar-result shape. Whichever fix is
chosen, it touches almost nothing.

### Fix options

**Option A — rewrite the two call sites (minimal, verified).**

The repo already ships the fixer: `rewriteUnsafeDomAbsenceAssertions` in
`tests/dom-assertion-safety.ts:60`. Applying it produces

```ts
expect(document.querySelector("[data-native-model-list]")?.getAttribute("data-favorite-reorder") === null).toBe(true);
```

This is semantically equivalent for both reachable states: when the element is
missing, `?.` yields `undefined`, and `expect(undefined).toBeNull()` and
`expect(undefined === null).toBe(true)` both fail.

Verified: after applying the rewriter, `tests/unit/test-diagnostic-bounds.test.ts`
-> 8 pass / 0 fail, and the owning file
`apps/web/src/components/chat/AgentModelPicker.test.tsx` -> 53 pass / 0 fail.
The change was reverted after verification; it is not committed.

Cost: the detector stays wrong, so the next person who writes a perfectly safe
`querySelector(...)?.getAttribute(...)).toBeNull()` gets the same confusing
red, in a file they may not have touched.

**Option B — narrow the detector (correct, slightly riskier).**

Judge the received expression by what it *produces*, not by what it *contains*.
A first cut is to unwrap parentheses, non-null assertions and optional chains,
then flag only when the outermost operation yields a node.

Care is needed not to open a hole: `expect(screen.queryAllByRole("x")[0]).toBeNull()`
has an `ElementAccessExpression` outermost but still yields a node and must stay
flagged. A workable rule is "flag unless the outermost operation is known to
produce a non-node" — a method call whose name is not DOM-producing
(`getAttribute`, `getAttributeNS`, …) or a property access to a documented
scalar (`textContent`, `value`, `className`, `id`, `innerHTML`, `length`).

`tests/unit/test-diagnostic-bounds.test.ts:41` already has a
`detects and faithfully rewrites DOM-producing absence assertions` case; any
detector change should extend it with both a positive
(`querySelectorAll(...)[0]` stays flagged) and a negative
(`querySelector(...)?.getAttribute(...)` is not flagged) fixture.

**Recommendation:** do both, in that order and ideally in one change — A makes
`main` green immediately and is already verified; B stops the false positive
recurring. If only one is affordable, do A first, because a red `main` blocks
everyone.

---

## Failure 2 — an assertion left behind by a mid-PR behaviour reversal

### What fails

```
tests/unit/components/CreateEnvironmentFlowDialog.test.tsx:807
expect(received).toBe(expected)
Expected: "true"
Received: "false"
```

at

```ts
fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
  .toBe("true");
expect(screen.getByRole("button", { name: "codex models" })).toBeTruthy();
```

### Root cause

PR #402 landed as two commits squashed together. Its own message records the
reversal:

1. `feat(model-picker): support ordered favorite models` — at this point the
   picker always opened on the favourites view.
2. `fix(model-picker): serialize favorite saves and restore provider-first open`
   — “**Open the picker on the selected provider when no favorites exist**”.

The second commit is what `preferredCatalogView` now implements
(`apps/web/src/components/chat/AgentModelPicker.tsx:111`):

```ts
function preferredCatalogView(
  favorites: AgentModelRef[],
  selectedPlatform: AgentPlatform | undefined,
  models: AgentModel[],
): AgentPlatform | "favorites" {
  return favorites.length > 0
    ? "favorites"
    : selectedPlatform ?? models[0]?.platform ?? "favorites";
}
```

It seeds `catalogView` once, in a `useState` initialiser
(`AgentModelPicker.tsx:484`), and both “Favorite models” buttons render
`aria-pressed={catalogView === "favorites"}`
(`AgentModelPicker.tsx:825` and `AgentModelPicker.tsx:988`).

Favourites are read from `config.global.favoriteModels`
(`apps/web/src/hooks/useAgentModelFavorites.ts:109`). The failing test never
seeds that key — the string `favorite` appears exactly once in the whole file,
on the failing assertion itself. So `favorites.length === 0`, the picker opens
on `selectedPlatform` (`"codex"`, restored from
`lastEnvironmentAgentSelection`), and “Favorite models” is correctly
`aria-pressed="false"`.

The first commit of #402 had rewritten this assertion *away* from the codex
button and onto the favourites button, which was right for the behaviour at that
moment. The second commit reverted the behaviour but not the assertion.

`git show 724f6326 -- tests/unit/components/CreateEnvironmentFlowDialog.test.tsx`:

```diff
-    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed"))
+    expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
       .toBe("true");
+    expect(screen.getByRole("button", { name: "codex models" })).toBeTruthy();
```

**The product behaviour is correct. Only the assertion is stale.** The test's
actual subject — that a reopened dialog restores the durably remembered agent,
model and reasoning selection — is still verified by the three assertions above
the failing line, and those pass.

### Fix

Restore the pre-#402 assertion and keep the intent of the added one, so the test
pins the post-reversal behaviour explicitly rather than by omission:

```ts
expect(screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"))
  .toBe("false");
expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed"))
  .toBe("true");
```

Verified: with this change the case passes (1 pass / 0 fail). The change was
reverted after verification; it is not committed.

### Worth considering alongside the fix

The reversal in #402 means "open on favourites" is now only reachable when
favourites exist, and no test in `CreateEnvironmentFlowDialog.test.tsx` covers
that branch — the file seeds no favourites anywhere. A sibling case that seeds
`config.global.favoriteModels` and asserts `aria-pressed="true"` on the
favourites button would cover the other half of `preferredCatalogView` and stop
a future revert of the reversal from going unnoticed.

`apps/web/src/components/chat/AgentModelPicker.test.tsx` does cover
`opens on the selected platform when no favorites exist`
(`AgentModelPicker.test.tsx:1093`) at the component level, so the gap is in the
dialog integration path only.

---

## How this reached `main`

Both failures are deterministic and both were introduced by the same merge, so
`bun run test` must not have been run — or must have been run and its result not
acted on — between the second commit of #402 and the merge. The failures are not
timing-dependent and do not require the full aggregate suite to surface: running
either owning file alone reproduces them in under two seconds.

Worth checking whether CI runs `bun run test` on the merge commit, and whether
its result gates the merge. Six subsequent PRs have merged on top of a red
`main`, which suggests the signal is either absent or routinely overridden.

## Suggested sequencing

1. Apply Failure 2's assertion fix and Failure 1's Option A rewrite. Both are
   verified, together they are four lines, and they make `main` green.
2. Fix the detector (Failure 1, Option B) with the positive and negative
   fixtures described above.
3. Add the missing favourites-seeded dialog case.
4. Separately, confirm whether `bun run test` gates merges to `main`.

Steps 1 and 2 are independent of any in-flight feature branch and can be taken
directly to `main` through a normal PR.
