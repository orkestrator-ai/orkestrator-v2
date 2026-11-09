---
target: main screen (native agent tab)
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:/Users/arkaydeus/orkestrator-v2/workspaces/orkestrator-v2-20261109-121331-f5f64aff930f/apps/web/src/components/native-agent/AgentNativeTab.tsx"
target_fingerprint: "sha256:3557f6c4bfd94c374ca9993193e84a29843c54a7c7e988390cca54f4be42f384"
target_path: /Users/arkaydeus/orkestrator-v2/workspaces/orkestrator-v2-20261109-121331-f5f64aff930f/apps/web/src/components/native-agent/AgentNativeTab.tsx
timestamp: 2026-11-09T14-34-05Z
slug: omponents-native-agent-agentnativetab-tsx-77843426
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Thinking shimmer and running states exist; the turn's end ("Completed in 10s") is 10px at 1.9:1 |
| 2 | Match System / Real World | 3 | "FINAL", "Default (recommended) (High)", "Ready to build!" need translating |
| 3 | User Control and Freedom | 3 | Stop, queue, Esc-to-stop, fork, confirmed delete; mode only escapable via icon dropdown |
| 4 | Consistency and Standards | 2 | Colour meanings contradict DESIGN.md (red Delete fill, yellow Build, orange Bypass, amber bell) |
| 5 | Error Prevention | 2 | Solid red Delete beside PR; approvals in Bypass never stated in words |
| 6 | Recognition Rather Than Recall | 2 | 11 icon-only toolbar buttons and 3 icon-only compose pickers; state decoded from icon colour |
| 7 | Flexibility and Efficiency | 3 | Rich shortcuts (mode cycle, focus input, find, steer), none hinted in the composer |
| 8 | Aesthetic and Minimalist Design | 2 | Calm transcript undermined by a see-through dock and coloured controls at rest |
| 9 | Error Recovery | 3 | Inline retry, drafts kept; error text uses destructive, which DESIGN.md reserves for fills |
| 10 | Help and Documentation | 2 | Good tooltips; modes, approvals and FINAL unexplained in context |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict
LLM: transcript and composer are category-interchangeable (centred column, right bubble, floating composer, model chip, blue up arrow). The shell (PR/Multi Review toolbar, Thread changes/FINAL row, fork, circle/square markers) is Orkestrator's own. The containment claim is nearly absent from the main screen: no branch, worktree/container, network or approvals state in text; "no files changed" asserted only by the model.
Deterministic scan: 93 findings (4 counted, 89 advisory) over native-agent/, chat/, layout/ (~280 files). side-tab x4 (RichCallout.tsx:19,25,31,37, real but low); design-system-font-size x84 (82 at 10px, 2 at 13px; partly a DESIGN.md token-ramp gap, mostly real functional 10px text); design-system-color x5 (mostly false positives). Live overlay (headless, injected): 21 issues on 17 elements: undersized-ui-text 10, low-contrast 6+1, nested-cards 2 (false positives: documented floating compose card, user bubble), line-length 1, tiny-text 1.

## Priority Issues
1. [P1] Compose dock is see-through: transcript prose shows through the composer, badly on phone. input-surface is zinc-900 at 90% alpha with no scrim. Fix: opaque dock surface, reserved bottom padding, short fade mask above; correct DESIGN.md's input-surface for the dock. Commands: polish, layout.
2. [P1] Functional metadata is 10px at failing contrast: "Completed in" 1.94:1, timestamp 2.64:1, tool duration 2.94:1, tool count 3.5:1, model name 3.55:1; PR button label white on #3b82f6 3.7:1 (brand #5b8def would be ~3.2:1). Fix: 11px floor for functional text, muted-foreground (#8d929e, 6.1:1) minimum; resolve white-on-blue contrast before the brand-blue migration. Commands: typeset, audit.
3. [P1] Colour semantics contradict DESIGN.md: Delete is a permanent destructive fill; Build mode yellow-500 (needs-you colour), Plan green-500 (success colour), approval modes sky/violet/teal/orange, amber unread bell, yellow-600 running. Fix: Delete ghost/overflow with coral on hover; mode/approval icons muted at rest, colour only risky non-defaults; blue unread dot. Commands: quieter, colorize.
4. [P2] Containment and evidence invisible where work happens: no system-computed changed-file count; Bypass approvals only an orange glyph. Fix: mono contract line (worktree/container · branch · network · approvals) near FINAL or above composer; system "0 files changed"; text label on non-default approvals. Command: clarify.
5. [P2] Keyboard and touch gaps: editor shows no focus indicator; Shift+Tab in the editor toggles Build/Plan instead of reverse-tabbing; Send/Stop named only by title; compose controls 28x28 and fork/copy 24x24 on phone vs DESIGN.md's 40-44px. Commands: adapt, harden.

## Persona Red Flags
Alex: shortcuts exist but unhinted; seeing which command ran needs an expand; "Agent finished" toast covers PR/Delete when Alex wants PR.
Sam: "Completed in" ~1.9:1; hidden "Ready to build!" h2 stays in the accessibility tree (max-h-0 opacity-0, not aria-hidden); Send/Stop title-only names; Shift+Tab trap; mode state by icon colour.
Casey: typed text over transcript text; 28px targets beside Send; environment switch via top-left hamburger; "Scroll down" pill covers body text; possible Plan->Build flash on first phone load (unconfirmed).

## Minor Observations
- Bug: select-all + Delete in the composer leaves a <br>; the draft serialises as "\n", the placeholder never returns, and the draft persists across clients.
- Folded tool group names only its latest call ("Read server.test.ts") and hides the command that mattered; open rows all show the same wrench and a green "success".
- Thinking rows set model prose in mono, against the Machine Voice Rule.
- Tab label truncates at ~190px with an empty strip; "(recommended) (High)" double parenthetical; "Ready to build!" off-voice.
- RichCallout uses 4px side bars, not in DESIGN.md.
- DESIGN.md's token ramp lacks the 10px step its prose allows.

## Questions to Consider
- Should every prompt be sent beneath a visible statement of the environment's containment, not just a model name?
- Why is Delete the second-loudest object in a product whose principle is "humans approve, merge and delete"?
- Should a turn end with system evidence (diff count, test exit status) rather than a muted duration?
