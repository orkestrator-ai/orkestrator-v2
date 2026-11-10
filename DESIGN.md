---
name: Orkestrator
description: Coding agents in sealed containers, every change through a review graph.
colors:
  brand-blue: "#5b8def"
  brand-blue-bright: "#8ab4ff"
  brand-green: "#66c992"
  brand-amber: "#d6a75d"
  brand-red: "#e07a80"
  site-night: "#07090d"
  site-surface: "#0c1017"
  site-surface-raised: "#111722"
  site-ink: "#f2f5f9"
  site-ink-secondary: "#aeb8c7"
  site-ink-tertiary: "#758198"
  site-line: "#1f2736"
  site-line-strong: "#2c3749"
  primary: "#3b82f6"
  primary-fill: "#2563eb"
  primary-foreground: "#ffffff"
  background: "#0e1014"
  foreground: "#e7e9ee"
  muted-foreground: "#8d929e"
  card: "#14161b"
  popover: "#16181e"
  sidebar: "#101319"
  chrome: "#17191f"
  panel-surface: "#1c1f26"
  elevated: "#23262e"
  elevated-hover: "#2c303a"
  border: "#262a32"
  divider: "#22262d"
  input-surface: "color-mix(in srgb, oklch(19.5% 0.013 264) 90%, transparent)"
  compose-surface: "oklch(19.5% 0.013 264)"
  selected: "#1d2941"
  selected-edge: "#141d2e"
  selected-foreground: "#e8eefb"
  hover: "#1a2438"
  environment-hover: "#263650"
  success: "#5ee39b"
  failure: "#ff7b72"
  destructive: "#e5534b"
  status-stopped: "#71717a"
  flow-canvas: "#0b0d10"
  flow-node: "#14161b"
  flow-edge: "#3a3f4a"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(42px, 6.2vw, 76px)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(32px, 4vw, 48px)"
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  lead:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.65
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 620
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
  body-dense:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.33
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.45
  eyebrow:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: "0.1em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  terminal:
    fontFamily: "FiraCode Nerd Font, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  hairline: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "48px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #2563eb 85%, transparent)"
  button-secondary:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.elevated-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.lg}"
    size: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.input-surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  segment-selected:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  environment-row-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.selected-foreground}"
    rounded: "{rounded.lg}"
  environment-row-hover:
    backgroundColor: "{colors.environment-hover}"
  tool-card:
    backgroundColor: "{colors.sidebar}"
    rounded: "{rounded.lg}"
  pill:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "28px"
  modal:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.2xl}"
  compose-bar:
    backgroundColor: "{colors.compose-surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "12px"
    width: "min(calc(100% - 2rem), 56rem)"
  compose-control:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.lg}"
    padding: "0 8px"
    height: "28px"
  compose-control-hover:
    backgroundColor: "{colors.elevated-hover}"
  compose-send:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    size: "28px"
  compose-send-queued:
    backgroundColor: "color-mix(in srgb, #2563eb 30%, transparent)"
    textColor: "#dbeafe"
    rounded: "{rounded.lg}"
    size: "28px"
  compose-stop:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    size: "28px"
  floating-notice:
    backgroundColor: "color-mix(in srgb, #1c1f26 95%, transparent)"
    textColor: "{colors.foreground}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.xl}"
    padding: "12px"
    width: "18rem"
  floating-notice-pill:
    backgroundColor: "color-mix(in srgb, #1c1f26 95%, transparent)"
    textColor: "{colors.foreground}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "28px"
  floating-notice-action:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-dense}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "28px"
  containment-tag:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.mono}"
  site-button-primary:
    backgroundColor: "#5686e2"
    textColor: "#ffffff"
    rounded: "{rounded.lg}"
    padding: "0 20px"
    height: "48px"
  site-button-primary-hover:
    backgroundColor: "#6695eb"
  site-button-secondary:
    backgroundColor: "rgb(17 23 34 / 0.6)"
    textColor: "{colors.site-ink-secondary}"
    rounded: "{rounded.lg}"
    padding: "0 20px"
    height: "48px"
  site-chip:
    backgroundColor: "rgb(12 16 23 / 0.7)"
    textColor: "{colors.site-ink-secondary}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
---

# Design System: Orkestrator

## Overview

**Creative North Star: "The Control Room"**

Orkestrator is a dark, calm room full of live instruments. Many systems run at once (agents, containers, pipelines, reviews), and the user is rarely watching the one that matters next. The interface stays quiet so that state can speak: the ground is a cool near-black, text is set small and dense, and colour is held back for meaning (blue for where you are and what you will do, green for passed and running, red for failed, yellow for an agent waiting on you). A screen at rest should look almost monochrome; a glance should find the one row that changed.

The product has two registers on one brand. **The app** (desktop, browser, iOS shell) is the operating floor: 11–14px type, 1px hairlines, flat tonal layers, controls that stay quiet until touched. **The public site** is the same room seen through the window: the brand palette at full strength, a 76px tight-tracked headline, a blue-to-green gradient across the claim, mono eyebrows and product illustrations drawn as real UI. The site's palette is the brand; the app is its quieter use. Where the two disagree today, the site's values are where the app is heading (see Colors, "Known drift").

Motion reports, it does not decorate. Shimmer sweeps across a name only when its environment needs an answer or its pull request is ready or conflicted; a ring turns only around an environment that is working; transcript rows grow in by their real height so the reader never loses their place. Every one of these stops under reduced motion and forced colours.

**Key Characteristics:**
- Cool near-black ground with a blue cast (hue 264), never neutral grey.
- Dense: most UI text is 12px; 14px is the reading size; display sizes live only on the public site.
- Colour encodes state, not decoration; one blue, one green, one red across the whole product.
- Flat tonal layers separated by 1px hairlines; shadow only for things that float.
- One 1px focus line everywhere.
- Motion is a signal with an off switch.

## Colors

A cool, blue-cast night with one blue voice and one green/red pair for outcomes.

### Primary
- **Signal Blue** (`brand-blue`): the brand blue. On the site it carries the primary button, links and the start of the headline gradient; its brighter partner **Signal Blue Bright** (`brand-blue-bright`) carries eyebrows, focus outlines and the gradient's first stop.
- **App Signal Blue** (`primary`): the app's current blue for lines, text and marks: links, the selected row's 2px accent bar, the focus hairline (`--color-ring`), the active tab underline, the unread-mail count, and the "creating" status. Bells are not blue; see Approval Amber.
- **Deep Signal Fill** (`primary-fill`): the same blue one step deeper, for any fill that carries white text or glyphs: primary buttons (Create PR), the selected segment, the compose bar's Send. White on `primary` is 3.7:1, below AA for 14px text; white on `primary-fill` is 5.2:1.

### Secondary
- **All-Clear Green** (`brand-green`): the brand green. Site security eyebrows, "allowed" rows, and the end of the headline gradient.
- **App All-Clear Green** (`success`): the app's one success colour. Diff additions, successful tool calls, running status (`--color-status-running`) and the merge-ready shimmer.

### Tertiary
- **Approval Amber** (`brand-amber`): the site's "approval needed" and fix-stage accent. In the app, waiting-on-you and new-activity states are yellow: the needs-answer shimmer uses Tailwind's `yellow-400`, and every bell uses `amber-400` with a `fill-amber-400/20` body (the unread bell on an environment row and in its toast, the sidebar's waiting-environments counter, the project-home activity icon). A bell is how a glance finds the row that changed, so it keeps its yellow at rest rather than taking Signal Blue.
- **Fault Red** (`brand-red`, app `failure`): text-weight red for failures, blocked rows, diff deletions and error status. **Destructive Coral** (`destructive`) is the fill for destructive buttons; it is deliberately not `failure`, which is tuned for text and would put white glyphs on a pale fill at roughly 2.5:1.

### Neutral
- **Control-Room Night** (`background`): the app ground and the default terminal background. The central panel rebinds `background`, `card`, `popover`, `muted` and `secondary` to the user's terminal background, so the chat and terminal read as one surface.
- **Sidebar Night** (`sidebar`): the project panel and the tool-call card; the darkest app layer.
- **Chrome** (`chrome`): toolbar and header bands.
- **Card / Popover** (`card`, `popover`): resting containers and floating menus.
- **Panel Surface** (`panel-surface`): raised informational panels (for example the coordinator's "How it works" box).
- **Elevated** (`elevated`, `elevated-hover`): the resting fill of a control sitting on chrome or sidebar. Controls use `elevated`, never `accent`/`secondary`, because those are rebound inside the central panel and would vanish.
- **Ink** (`foreground`, `muted-foreground`): primary and secondary text. **Hairlines** (`border`, `divider`): `divider` separates shell panels, tool-card rows and modal header/footer; it is a flat colour so it renders identically over any layer.
- **Selection** (`selected` → `selected-edge`, `selected-foreground`): a left-to-right blue-tinted gradient for the selected row. **Hover** (`hover`, `environment-hover`) is a weaker shade of the same blue, never a grey wash.
- **The cool zinc ramp** (`--color-zinc-50`…`950`, OKLCH at hue 264): Tailwind's `zinc` retinted so the ~200 call sites that name it share the cool cast. Use the semantic tokens above first; the ramp is for steps they don't name.
- **Site neutrals** (`site-night`, `site-surface`, `site-surface-raised`, `site-ink*`, `site-line*`): the public site's own deeper night and three-step ink scale.
- **Flow graph** (`flow-canvas`, `flow-node`, `flow-edge`): Multi Review, build pipeline and Graphs canvases. The canvas sits below the panel, nodes above it; `flow-edge` is the dashed line of an unreached step.

### Known drift
The brand palette lives on the site; the app still ships older values: blue `#3b82f6` vs `#5b8def`, success `#5ee39b` vs `#66c992`, failure `#ff7b72` vs `#e07a80`. Moving fills to the brand blue would fail contrast (white on `#5b8def` is about 3.2:1, and the site's own `#5686e2` button is about 3.6:1), so the migration keeps a deep fill step such as `primary-fill` for anything carrying white text. The direction is to move the app to the brand values. App code reads every one of these through CSS variables in `apps/web/src/index.css`, so the migration is a token change there plus a contrast check (white on `#5b8def` and the selected-row gradient), not a call-site rewrite. *(Treating the site values as the target and the app values as drift was inferred from the "unify toward the site" answer; the follow-up question timed out.)*

### Named Rules
**The Fill Rule.** White text sits only on `primary-fill`, never on `primary`. `primary` is for lines, text and marks on the dark ground, where the deeper blue would lose contrast.

**The Quiet Floor Rule.** A screen at rest is near-monochrome. Colour appears only to mark selection, an outcome, or a state that needs the user.

**The One Pair Rule.** Success and failure have exactly one colour each, everywhere: diff counts, tool outcomes, run status. Never pick a different green or red step for the same meaning.

**The Mode Colour Exception.** Mode and approval icons keep a colour each as identity, by choice: Build `yellow-500`, Plan `green-500`; approvals Ask `sky-500`, Accept edits `violet-500`, Auto `teal-500`, Bypass `red-500`. Bypass, the one mode in which commands run without asking, is red and also named in words beside its icon; it is the one place red marks a risk rather than a failed outcome.

**The Outcome Colour Rule.** Results always keep their colour: a tool row's "success" is green, "failure" red and "running..." yellow, so a run of results can be read at a glance.

**The Platform Hue Exception.** `emerald` and other accent hues that distinguish agent platforms in the model picker are identity, not status. Never use them to mean success.

## Typography

**Display Font:** System UI (`-apple-system`, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial)
**Body Font:** the same system stack
**Label/Mono Font:** `ui-monospace` (SF Mono, Menlo, Consolas); **FiraCode Nerd Font** for terminals

**Character:** One native sans in every role, so the app feels like part of the operating system, with monospace as the second voice for anything a machine produced or would accept: branch names, hosts, commands, findings counts, eyebrows. The site gets its drama from weight 650 and very tight tracking, not from a second typeface.

### Hierarchy
- **Display** (650, `clamp(42px, 6.2vw, 76px)`, 1.02, −0.045em): the site hero only; balanced wrapping; the second sentence may carry the blue-to-green gradient.
- **Headline** (650, `clamp(32px, 4vw, 48px)`, 1.08, −0.035em): site section headings, max 720px wide.
- **Lead** (400, 18px, 1.65): site intro paragraphs in secondary ink, max 620px.
- **Title** (620, 16px, −0.01em): site card headings; in the app, dialog and panel titles use 16–18px semibold.
- **Body** (400, 14px): the app's reading size: messages, dialog copy, inputs at desktop.
- **Body Dense** (500, 12px): the workhorse of the app (rows, toolbars, tabs, tool calls, chips). Used about twice as often as 14px.
- **Label** (500, 11px): counts, durations, state tags and turn status ("Completed in"). 11px in `muted-foreground` (6.1:1) is the floor for text a user reads to understand state; never fade it further with an alpha. Uppercase labels add `tracking-wide`.
- **Message metadata** (10px, `muted-foreground` at 55%, the author at 70%): the model name, time and response time under each message. Deliberately small and faded so it recedes behind the conversation; it is reference, not state. Do not enlarge or brighten it. A count inside a filled pill may also be 10px.
- **Eyebrow** (mono, 12px, 0.1em, uppercase): site section kickers in Signal Blue Bright or All-Clear Green; 10–11px variants label nodes in product illustrations.
- **Terminal** (FiraCode Nerd Font, 14px default, user-configurable).

### Named Rules
**The Machine Voice Rule.** If a machine wrote it or would accept it (a path, branch, host, command, hash, count), set it in mono. Prose stays in the system sans.

**The Readable Floor Rule.** Status text is never below 11px and never fainter than `muted-foreground`. "Completed in 10s" at 10px and 40% opacity (1.9:1) was the faintest thing on the screen and the one that says the turn is done. The one deliberate exception is message metadata (model name and time), which stays 10px and faded by design.

**The 16px Touch Floor Rule.** On coarse pointers and below 768px, inputs, textareas, selects and the compose bar render at 16px so mobile browsers do not zoom on focus; line height stays at the shared 20px.

## Layout

The app is a three-pane shell: a resizable project sidebar (280px default, collapsible to compact or hidden with a 180ms flex transition), the central workspace (chrome toolbar, a tab row with a 2px blue underline on the active tab, then chat or terminal), and an optional files panel (30% default, minimum 240px). The desktop title bar is 37px, with a 12px traffic-light inset on macOS only. Spacing follows Tailwind's 4px scale; dense rows use 4–8px gaps, panels 12–16px padding, dialogs 16px (24px from `sm`).

Below 640px the shell collapses to a single column with a slide-over sidebar; toolbar buttons grow to 40px minimum and menu items to 44px; bottom bars pad by the safe-area inset. Hover-revealed controls appear only under `hover-fine` (hover-capable precise pointer), so an iPad wider than the desktop breakpoint still shows its touch actions.

Modals take the full width minus a 0.5rem gutter on phones and cap at a size from Tailwind's container scale (24rem to 72rem, default 32rem) inside a 1rem gutter from `sm`.

The public site uses a 1180px content column with 24px gutters, 96px hero top padding and sticky 64px navigation.

**The Viewport Lock Rule.** `html`, `body` and `#root` are locked to the viewport with percentage heights (not `vh`/`dvh`, which break under CSS zoom). Any page that must scroll, like the landing page, is its own scroll container.

## Elevation & Depth

The app is flat. Depth comes from tonal layers (sidebar darkest, then background, card, chrome, elevated) and 1px hairlines (`divider`, `border`). Shadow is reserved for things that float above the work: modals, menus, popovers and toasts. A modal sits on a 75% black backdrop with a medium blur. The site is allowed more atmosphere: faint radial blue and green glows on the page ground, and product "windows" with an inner top highlight and a deep drop shadow.

### Shadow Vocabulary
- **Modal** (`box-shadow: 0 28px 90px rgba(0,0,0,0.72)`): dialogs and alert dialogs, with a 16px radius and a `zinc-700` hairline at 70%.
- **Compose dock** (`shadow-xl` at black 20%): the native tab's compose bar, which floats over the bottom of the transcript.
- **Floating notice** (`shadow-xl` at black 40% with a small backdrop blur; its folded pill uses `shadow-lg` at black 30%): agent mail and other pane notices floating at a pane's top right.
- **Control lift** (`shadow-xs` / `shadow-sm`): inputs and the selected segment only.
- **Site window** (`box-shadow: inset 0 1px 0 #2a3446, 0 30px 80px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 / 0.4)`): illustration frames on the public site.
- **Site primary glow** (`box-shadow: inset 0 1px 0 #86aef5, 0 10px 30px rgb(39 81 155 / 0.3)`): the site's primary button; it lifts 1px on hover.

### Named Rules
**The Flat Floor Rule.** Anything that sits *in* the work is flat and separated by tone or a hairline. Only what floats *over* the work casts a shadow.

## Shapes

Gently rounded and consistent: 8px (`lg`) for buttons, rows, segmented controls and the tool card; 6px (`md`) for inputs and inner segments; 12px (`xl`) for cards and the site's windows; 16px (`2xl`) for modals; full pills for chips, prompt suggestions, goal pills and status dots. Environment markers carry meaning in their shape: a circle is a local worktree, a square is a container, and the working ring follows that shape.

## Components

### Buttons
Quiet until touched. Most app buttons are ghost or tonal; the filled blue is rare and means "the one thing to do here". *(This character line was inferred; the question timed out.)*
- **Shape:** gently rounded (8px); heights 32/36/40px (`sm`/default/`lg`), icon buttons square at the same steps.
- **Primary:** Deep Signal Fill (`primary-fill`), white 14px medium text (5.2:1); hover drops to 85% and active to 75%. The focus line sits outside the fill.
- **Secondary:** `elevated` fill, `elevated-hover` on hover.
- **Ghost:** no fill, muted text; hover adds the `elevated` fill and full-strength text. The toolbar is almost entirely ghost icon buttons.
- **Outline:** 1px `border`, transparent fill.
- **Destructive:** Destructive Coral fill, white text, for the confirming button inside a dialog. In a toolbar, a destructive action (Delete environment) is a ghost icon that turns coral (`hover:text-failure` on a `destructive` 15% wash) on hover.
- **Site:** 48px tall, 20px padding, 15px semibold; the primary carries an inner highlight and blue glow and lifts 1px on hover.

### Chips / Pills
- **Style:** full-pill, 1px `border` at 70%, muted text at 12px, 28–36px tall. Used for prompt suggestions, goal pills and the compose bar's model chip. Hover is a 6% foreground wash.
- **Site chips:** agent platform names in a pill with a `site-line` border over a translucent surface.

### Cards / Containers
- **Corner Style:** 12px for cards, 8px for the tool card.
- **Background:** `card` for generic cards, `panel-surface` for informational panels, `sidebar` for tool-call groups.
- **Shadow Strategy:** none at rest (see Elevation).
- **Border:** 1px `input`/`divider`; tool-call groups divide their rows with `divider`.
- **Internal Padding:** 24px for generic cards, 12–16px for panels.

### Inputs / Fields
- **Style:** `input-surface` fill (a translucent `zinc-900`), 1px `border` at 70%, 6px radius, 36px tall, 14px text (16px on touch).
- **Focus:** the 1px focus hairline, inset 2px. No glow, no border-colour shift.
- **Error / Disabled:** `aria-invalid` turns the border and focus line Destructive Coral; disabled drops to 50% opacity.

### Navigation
- **Sidebar rows:** 8px-radius rows inset 4px from the panel edge. Hover is `environment-hover`; the selected row is the `selected` → `selected-edge` gradient with a 2px Signal Blue bar on the left that gives way to the drag grip on hover. Offline machines dim to 60%.
- **Workspace tabs:** 12–14px labels with an icon; the active tab gets a 2px Signal Blue underline. The top section tabs (Home, Coordinator, Kanban…) mark the active one with a filled blue pill.
- **Segmented selector:** an `input-surface` track with a `divider` border and 2px inset; the selected segment is a filled blue with bold text.
- **Mobile:** hamburger to a slide-over sidebar; touch targets at least 40–44px.

### Live Signals (signature)
The Control Room's instruments. **Name shimmer:** a light band sweeps across an environment's name: yellow-tinted when an agent needs an answer, green when its PR is ready to merge, coral when it has conflicts (1.9s, calm). **Thinking shimmer:** the transcript's "is thinking" status sweeps faster (1.2s) in muted text. **Working ring:** a conic sweep from a light head through grey to nothing, masked to a 1.5px ring around a working environment's marker (it rotates for a circle and sweeps its angle for a square). **Arrivals:** live transcript rows grow in by their real height over 300ms; tool groups fold over 500ms. All of these stop under `prefers-reduced-motion` (shimmers hold the band's colour still) and fall back to system colours under forced colours.

### Focus Hairline (signature)
One keyboard-focus indicator for the whole product: a single 1px outline in `--color-ring`, inset 2px so it never touches selection, outset 2px on solid fills and bare text. It needs no border, leaves shadows alone, and becomes `Highlight` under forced colours.

### Compose Bar (native tab, signature)
The input bar at the bottom of every native agent tab (Claude, Codex, OpenCode, Cursor, Grok, Pi) and the Coordinator. It is the one control that floats in the work, so it is the one place outside overlays that casts a shadow.
- **Frame:** a 12px-radius card on the opaque `compose-surface` (not the translucent `input-surface`), 1px `border` at 70%, 12px padding, compose-dock shadow. It centres in the transcript's 56rem column (full width less 0.75rem on phones) and sits 16px above the pane's bottom edge. When the prompt input is focused, the card's border steps up one neutral shade (`zinc-700`, 150ms). It is never blue and never an outline: the input is focused almost all the time, and a standing blue frame around the composer was rejected.
- **Ground:** docked, the dock lays the background colour behind itself, fading in over its top 2rem, so transcript text scrolling beneath never shows through the composer, the goal pill or the scroll-down control.
- **Input:** borderless, 14px with a fixed 20px line height (16px on touch). It grows from one line (28px) to twelve lines (256px), then scrolls. These limits are shared by every agent so one prompt wraps the same everywhere. The placeholder is muted text ("What would you like to get done?").
- **Attachments row (above the input):** image thumbnails as 48px squares with a 6px radius and a corner remove button; files as small 4px-radius chips on `muted`; browser annotations as a blue-tinted pill (`blue-500` at 10%, `blue-400` border at 30%).
- **Toolbar (below the input, 12px gap):** a single row that scrolls sideways without a scrollbar. On the left are the primary controls (attach `+`, the model and reasoning picker, the mode and approvals pickers), all 28px tall (40px on touch) with an 8px radius on `elevated`, hovering to `elevated-hover`, with 12px text. On the right are the secondary controls.
- **Model chip:** the model name, then the reasoning level after a middle dot in muted text ("Default (recommended) · High"); the name truncates first.
- **Mode and approvals:** icons in their own colours (see the Mode Colour Exception). Auto-approve adds its name ("Bypass") beside the icon from the @md container width up. The mode control's tooltip names its Shift+Tab shortcut.
- **Send:** a 28px square on Deep Signal Fill with an up arrow and an accessible name. While a turn runs the same button queues instead: same shape, stepped back to the fill at 30% with `blue-100` glyphs, because a different colour would read as a different action. Clicking it never takes focus from the input.
- **Stop:** a 28px Destructive Coral square with a filled stop glyph, shown beside Send while a turn runs. It stays enabled while a prompt is being submitted, because that is exactly when the user may need it.
- **Disabled / sending:** the input dims to 60%; controls drop to 50%.

### Containment Line (signature)
The environment's containment, stated where the work happens. It sits in the change row above the transcript, right-aligned before "Turn changes", and is shown before the first turn as well as after. It is mono 11px muted text with an icon: a folder for a worktree or a box for a container, then the isolation, the network and the branch ("worktree · host network · fix-demo"). A local worktree always reads "host network", because it has no container firewall. Narrow panes keep only the icon and the isolation. The tooltip explains the boundary in a sentence.

The same row leads with the system's own account of the turn: "Thread changes", the line counts or "No file changes", then the Final or Live state tag. An agent saying "I didn't change any files" is never the only evidence.

### Tool Group
Three or more calls fold to one line: the newest call, then a wrench icon with the call count and the span, both small and muted (10px). Opened, each row's icon says what the call did: a terminal for commands, a file for reads, a file-pen for edits, a magnifier for searches and a wrench for anything else. Each row's result keeps its outcome colour: "success" in All-Clear Green, "failure" in Fault Red, "running..." pulsing in `yellow-600`.

### Agent Mail Notice (floating notice)
Agent mail announces itself in a floating notice at the top right of the agent pane rather than a strip that pushes the transcript down. It uses the shared floating-notice card, so mail, pull-request updates and other pane notices stack in one corner with errors first, then warnings, then information.
- **Card:** 18rem wide (14rem minimum), a 12px radius on `panel-surface` at 95% with a small backdrop blur, 1px `border`, 12px padding, 12px text at a 20px line height, and the floating-notice shadow. It scrolls past 28rem tall.
- **Header:** an 11px uppercase muted label ("AGENT MAIL") led by an 8px tone dot, with 24px icon buttons to minimise and dismiss.
- **Tone is a dot, not a tint:** Signal Blue for information, `yellow-300` for a warning (delivery paused, waiting for an agent, undeliverable), `failure` for an error (delivery failed). The card itself stays neutral.
- **Body:** the status sentence wraps rather than truncates, because it is the reason the user acts on. Below a `border` hairline sit the newest message's sender and time in muted text, and its subject clamped to two lines. Action errors appear in `failure` text.
- **Actions:** 28px buttons with 12px text, 6px apart: secondary for the act (Retry, Resume, Deliver now), ghost for the alternatives (Discard, View).
- **Placement:** beside the centred 56rem column when the pane has room (covering nothing), over the content when it does not, and folded into a 28px pill (icon, count, tone dot) on narrow panes. In an agent tab it sits 40px from the top to clear the thread-changes row.

### Modal
A 16px-radius panel on the ground colour, with header and footer bands separated by `divider` hairlines, centred on a blurred 75% black scrim. Fields inside use `input-surface`, so every control in a dialog reads as one raised surface. The footer stacks buttons in reverse on phones and right-aligns them from `sm`.

## Do's and Don'ts

### Do:
- **Do** reach for semantic tokens (`elevated`, `divider`, `selected`, `success`, `failure`) before any raw ramp step or hex.
- **Do** keep a resting screen near-monochrome and let blue, green, red and yellow mark only selection, outcome and needs-you states.
- **Do** use `elevated` for controls on chrome or sidebar; `accent`, `secondary`, `muted`, `card` and `popover` are rebound inside the central panel.
- **Do** set machine output (paths, branches, hosts, commands, counts) in mono.
- **Do** use the 1px focus hairline (`focus-hairline`, with `focus-hairline-outset` on solid fills) for every focusable control.
- **Do** give every animation a `prefers-reduced-motion` stop and a forced-colours fallback.
- **Do** animate real layout height (grid rows, Radix content height) for anything inside the bottom-anchored transcript, so the reader's place holds.
- **Do** keep touch targets at 40–44px below 640px and gate hover-only controls behind `hover-fine`.
- **Do** match a status row's height across its states, so the transcript does not jump at the end of a turn.
- **Do** carry a notice's tone in its 8px dot on a neutral card, never in a tinted background.
- **Do** draw every bell (unread activity, waiting environments, project-home activity) in `amber-400`, never in Signal Blue.
- **Do** keep the compose bar's input limits (one to twelve 20px lines) shared across every agent platform.
- **Do** put white text only on `primary-fill`.
- **Do** keep status text at 11px or larger in `muted-foreground` or brighter; message metadata (model name, time) is the deliberate 10px faded exception.
- **Do** state containment and change evidence in system text, not only in the agent's words.

### Don't:
- **Don't** introduce a second green or red for success or failure, or use a platform accent hue as a status colour.
- **Don't** use `failure` as a button fill or `destructive` as text colour; they are tuned for different jobs.
- **Don't** add shadows to things that sit in the work: rows, cards, panels and the tool card stay flat.
- **Don't** use a grey hover beside a blue selection; hover is a weaker shade of the selection blue.
- **Don't** use `vh`/`dvh` for the app's root height; it overflows under CSS zoom.
- **Don't** bring the site's display sizes, gradient text or glow shadows into the app's operating surfaces.
- **Don't** add a second focus style (rings, glows, border swaps) alongside the hairline.
- **Don't** outline the compose card in blue on focus; the composer is almost always focused, so its focus cue is a one-shade lighter neutral border.
- **Don't** animate anything that is not reporting a state change.
- **Don't** give a destructive action a standing red fill in a toolbar; it is a ghost that turns coral on hover, behind its confirmation.
- **Don't** use a coloured side bar thicker than 1px; callouts carry their kind in a 1px frame (solid, dotted for Tip, dashed for Warning; Caution 2px), an icon, a label and a hue.
