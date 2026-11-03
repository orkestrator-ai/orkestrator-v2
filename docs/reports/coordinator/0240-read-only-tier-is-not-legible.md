# Make the read-only tier legible

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Show the tier by name**: a pill in the picker and the toolbar badge, with a popover that explains it. Status: open.
2. **Stop repeating the caveat**: a picker note does not say "cannot verify" twice. Status: open.

### 1. Show the tier by name

**Problem.** The tier is the main safety fact the user chooses, and its name is never shown. The badge also calls two different tiers "advisory".

**Context.** Tiers are `enforced`, `provider-configured` and `advisory` (`docs/architecture/coordinator.md:482-486`). The snapshot carries them per platform.

**Investigation.** `advisoryPlatform` is set whenever the tier is not `enforced` (`CoordinatorPanel.tsx:862-865`), so a `provider-configured` Claude or Cursor reads "Read-only protection is advisory" (`CoordinatorPanelNotices.tsx:55-57`), and the tooltip says Orkestrator "cannot enforce that" (`:66-71`). In the picker a platform's caveat is an amber marker and a title (`AgentModelPicker.tsx:209-222`). Nothing links the safety-level setting.

**Decisions.**

- **Where does the explanation live?**
  - **A pill on each platform row and on the badge, with the badge's tooltip giving the tier's sentence and a link to Settings (recommended).**
    - Pros: the existing focusable tooltip already holds this text; `requestGlobalSettings("platforms")` exists.
    - Cons: tooltips with links are awkward by touch, so the link may need a popover.
  - **Leave the picker and only correct the badge's wording.**
    - Pros: fixes the wrong label at once.
    - Cons: the user still chooses a platform without seeing its tier.

### 2. Stop repeating the caveat

**Problem.** A picker note can state the same limit twice.

**Context.** Part of U13 in the report.

**Investigation.** `platformNotes` appends "Orkestrator cannot verify this boundary independently." to any non-enforced reason (`CoordinatorPanel.tsx:338-341`), and a reason from the enforcement matrix can already say so: Cursor's ends "exposes no approval callback to verify them" (`packages/protocol/src/graphs/capability-enforcement.ts:199`).

**Decisions.** None: once the pill says the tier, drop the appended sentence and rely on the reason text.

## Related

- [Coordinator report, 5.3](../2026-10-27-coordinator.md#53-make-the-read-only-tier-legible) and [4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [0026-coordinator-read-only-adapters.md](../../todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md): the per-platform decisions behind the tiers
