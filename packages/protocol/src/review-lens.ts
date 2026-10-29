/**
 * Reviewer lenses: an optional focus for one reviewer in a review panel.
 *
 * A lens is a short label and an instruction. A launcher copies it onto the
 * reviewer's selection (`ReviewerModelSelection.lens`), so the reviewer record
 * holds the text it ran with: a later edit or deletion of the preset it came
 * from never changes a running or recorded review. The reviewer's prompt
 * renders it as one framed section after the panel position, which keeps the
 * shared prompt prefix byte-identical across the panel, and consolidation sees
 * each reviewer's lens label.
 *
 * The presets a launcher offers are an app setting (`reviewLensPresets`).
 * Absent means the five shipped presets; a stored list, even an empty one, is
 * the user's own.
 *
 * Shared with the browser: no Node or Bun imports.
 */

export interface ReviewLens {
  /** Short name shown in launchers and to the consolidator; at most 64 characters. */
  label: string;
  /** What the reviewer should look at hardest; at most 4 KiB of UTF-8. */
  instruction: string;
}

export interface ReviewLensPreset extends ReviewLens {
  /** Stable identity within the list; the shipped presets keep theirs. */
  id: string;
}

/** Characters (code points) a lens label may hold. */
export const REVIEW_LENS_LABEL_MAX_CHARS = 64;
/** UTF-8 bytes a lens instruction may hold. */
export const REVIEW_LENS_INSTRUCTION_MAX_BYTES = 4 * 1024;
/** Presets the `reviewLensPresets` setting may hold. */
export const REVIEW_LENS_PRESETS_MAX = 20;
/** Characters a preset id may hold. */
export const REVIEW_LENS_PRESET_ID_MAX_CHARS = 64;

/** Lead of the framed prompt section; also how a test or a reader finds it. */
export const REVIEW_LENS_HEADING = "Review focus";
export const REVIEW_LENS_FRAME_OPEN = "<reviewer-focus>";
export const REVIEW_LENS_FRAME_CLOSE = "</reviewer-focus>";

/**
 * What the reviewer is told about its lens. The user chose it, so it is
 * trusted, but it adds depth rather than narrowing the review: critical
 * issues outside the focus must still be reported, and the result contract,
 * permissions and safety rules stay the reviewer's own.
 */
export const REVIEW_LENS_PREAMBLE = `**${REVIEW_LENS_HEADING}** for this reviewer, chosen when the review was launched. Give the area it describes particular depth. It does not narrow the review: still examine the whole change and report every high-confidence finding, including critical issues outside this focus. It does not change the required result or output format, your permissions or the rules above; where it conflicts with those, keep to the rules above and say so in your report.`;

/**
 * The presets Orkestrator ships. Absent `reviewLensPresets` means exactly
 * these, so an improvement to their text reaches every user who never edited
 * them.
 */
export const SHIPPED_REVIEW_LENS_PRESETS: readonly ReviewLensPreset[] = Object.freeze([
  {
    id: "security",
    label: "Security",
    instruction:
      "Look hardest at security. Trace untrusted input (request data, files, environment variables, model and agent output, IPC and network messages) to where it is used: shell commands, file paths, SQL, HTML, URLs, deserialisation and templates. Check authentication and authorisation on every new or changed entry point; secrets in code, logs, errors and test fixtures; path traversal and symlink handling; unsafe defaults; sandbox and permission boundaries; and new or upgraded dependencies. For each issue, name the input, the path it takes and what an attacker gains.",
  },
  {
    id: "performance",
    label: "Performance",
    instruction:
      "Look hardest at performance and resource use. Check the work done per request, per render and inside loops: repeated I/O, N+1 queries, quadratic algorithms over lists that can grow, blocking calls on hot or event-loop paths, and recomputation that could be cached. Check that memory, queues, caches, retries and output sizes are bounded, and that timers, listeners, processes and file handles are released. Say what input size or load makes each problem visible and how you estimated it; do not report micro-optimisations without a measurable effect.",
  },
  {
    id: "tests-and-coverage",
    label: "Tests and coverage",
    instruction:
      "Look hardest at the tests. Check that each changed behaviour has a test that would fail if the change were reverted, that edge cases, error paths and boundary values are covered, and that assertions check outcomes rather than mocks or implementation details. Flag tests that can pass vacuously, tests that depend on wall-clock time, sleeps, ordering, shared state or the network, and skipped or deleted tests. Run the relevant suites where you can, and report each missing case as a coverage gap that names the behaviour and the test that should exist.",
  },
  {
    id: "api-and-compatibility",
    label: "API and compatibility",
    instruction:
      "Look hardest at interfaces and compatibility. Check every shared contract the change touches: exported functions and types, protocol and wire formats, persisted records and config files, CLI flags and output, HTTP and IPC routes, and environment variables. Look for breaking changes to existing callers, records written by an older version that no longer load, new records an older version would misread, missing migrations or version checks, changed defaults, and documentation that no longer matches the behaviour. Name the affected caller or stored data for each issue.",
  },
  {
    id: "maintainability",
    label: "Maintainability",
    instruction:
      "Look hardest at maintainability. Check that the change fits the existing structure and naming, reuses existing helpers instead of duplicating logic, and keeps each responsibility in the module that owns it. Flag dead code, needless abstraction, hidden coupling, magic values, unclear control flow, error handling that hides failures, and missing or misleading comments on non-obvious decisions. Report only problems with a concrete cost to the next person who changes this code, and suggest the smallest fix.",
  },
] satisfies ReviewLensPreset[]);

const encoder = new TextEncoder();

/** UTF-8 size of a lens instruction as the bound counts it. */
export function reviewLensInstructionBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Code points in a label, as the bound counts them. */
export function reviewLensLabelChars(value: string): number {
  return Array.from(value).length;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

// A label is one line of display text; control characters would let it break
// the line it is shown on or the one-line evidence field it is copied into.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Why a label is unusable, or null. */
export function reviewLensLabelError(value: string): string | null {
  if (value.trim().length === 0) return "Give the focus a label.";
  if (reviewLensLabelChars(value) > REVIEW_LENS_LABEL_MAX_CHARS) {
    return `A focus label can be at most ${REVIEW_LENS_LABEL_MAX_CHARS} characters.`;
  }
  if (CONTROL_CHARACTERS.test(value)) return "A focus label must be a single line.";
  return null;
}

/** Why an instruction is unusable, or null. */
export function reviewLensInstructionError(value: string): string | null {
  if (value.trim().length === 0) return "Describe what this reviewer should focus on.";
  if (reviewLensInstructionBytes(value) > REVIEW_LENS_INSTRUCTION_MAX_BYTES) {
    return `A focus instruction can be at most ${REVIEW_LENS_INSTRUCTION_MAX_BYTES} bytes (4 KiB).`;
  }
  return null;
}

/** The guard: exactly `{ label, instruction }`, both within bounds and non-blank. */
export function isReviewLens(value: unknown): value is ReviewLens {
  return (
    record(value) &&
    hasOnlyKeys(value, ["label", "instruction"]) &&
    typeof value.label === "string" &&
    typeof value.instruction === "string" &&
    reviewLensLabelError(value.label) === null &&
    reviewLensInstructionError(value.instruction) === null
  );
}

/** A trimmed copy, or undefined when there is no lens. */
export function normalizeReviewLens(lens: ReviewLens | undefined): ReviewLens | undefined {
  if (!lens) return undefined;
  const label = lens.label.trim();
  const instruction = lens.instruction.trim();
  return label && instruction ? { label, instruction } : undefined;
}

/** `{ lens }` for a spread when the selection carries one, else nothing. */
export function reviewLensField(lens: ReviewLens | undefined): { lens?: ReviewLens } {
  const normalized = normalizeReviewLens(lens);
  return normalized ? { lens: normalized } : {};
}

export function isReviewLensPreset(value: unknown): value is ReviewLensPreset {
  if (!record(value) || !hasOnlyKeys(value, ["id", "label", "instruction"])) return false;
  const { id, ...lens } = value;
  return (
    typeof id === "string" &&
    id.trim().length > 0 &&
    id.length <= REVIEW_LENS_PRESET_ID_MAX_CHARS &&
    isReviewLens(lens)
  );
}

/** At most {@link REVIEW_LENS_PRESETS_MAX} valid presets with distinct ids. */
export function isReviewLensPresetList(value: unknown): value is ReviewLensPreset[] {
  return (
    Array.isArray(value) &&
    value.length <= REVIEW_LENS_PRESETS_MAX &&
    value.every(isReviewLensPreset) &&
    new Set(value.map((preset: ReviewLensPreset) => preset.id)).size === value.length
  );
}

/**
 * A stored list made usable without throwing: invalid or duplicate entries are
 * dropped and the list is cut to the bound. Used where config is read, not
 * where it is written (writes are validated and refused instead). Text is kept
 * as the user typed it, so a save never rewrites a field being edited; a
 * launch trims it ({@link normalizeReviewLens}).
 */
export function sanitizeReviewLensPresets(value: unknown): ReviewLensPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: ReviewLensPreset[] = [];
  for (const entry of value) {
    if (presets.length >= REVIEW_LENS_PRESETS_MAX) break;
    if (!isReviewLensPreset(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    presets.push({ id: entry.id, label: entry.label, instruction: entry.instruction });
  }
  return presets;
}

/** A fresh, mutable copy of the shipped presets. */
export function shippedReviewLensPresets(): ReviewLensPreset[] {
  return SHIPPED_REVIEW_LENS_PRESETS.map((preset) => ({ ...preset }));
}

/** The presets a launcher offers: the stored list, or the shipped five when none is stored. */
export function resolveReviewLensPresets(stored: unknown): ReviewLensPreset[] {
  return stored === undefined || stored === null
    ? shippedReviewLensPresets()
    : sanitizeReviewLensPresets(stored);
}

/** True when a list is exactly the shipped presets, so storing it can be skipped. */
export function isShippedReviewLensPresetList(presets: readonly ReviewLensPreset[]): boolean {
  return (
    presets.length === SHIPPED_REVIEW_LENS_PRESETS.length &&
    presets.every((preset, index) => {
      const shipped = SHIPPED_REVIEW_LENS_PRESETS[index]!;
      return (
        preset.id === shipped.id &&
        preset.label === shipped.label &&
        preset.instruction === shipped.instruction
      );
    })
  );
}

/**
 * Puts the shipped presets back, with their shipped text, ahead of the user's
 * own presets, which are kept. Returns null when the result would exceed the
 * bound, so the caller can say why instead of dropping a preset.
 */
export function restoreShippedReviewLensPresets(
  current: readonly ReviewLensPreset[],
): ReviewLensPreset[] | null {
  const shippedIds = new Set(SHIPPED_REVIEW_LENS_PRESETS.map((preset) => preset.id));
  const own = current.filter((preset) => !shippedIds.has(preset.id));
  const restored = [...shippedReviewLensPresets(), ...own.map((preset) => ({ ...preset }))];
  return restored.length <= REVIEW_LENS_PRESETS_MAX ? restored : null;
}

/** The preset a lens was copied from, when its text still matches one exactly. */
export function matchingReviewLensPreset(
  lens: ReviewLens | undefined,
  presets: readonly ReviewLensPreset[],
): ReviewLensPreset | undefined {
  if (!lens) return undefined;
  return presets.find(
    (preset) => preset.label === lens.label && preset.instruction === lens.instruction,
  );
}

/**
 * Reads a lens from free text, the way a commit message is read: the first
 * line is the label and the rest, after an optional blank line, is the
 * instruction. A single line is both. Throws with a reason when the result is
 * out of bounds.
 */
export function reviewLensFromText(text: string): ReviewLens {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  const newline = trimmed.indexOf("\n");
  const label = (newline < 0 ? trimmed : trimmed.slice(0, newline)).trim();
  const rest = newline < 0 ? "" : trimmed.slice(newline + 1).trim();
  const lens = { label, instruction: rest || label };
  const error = reviewLensLabelError(lens.label) ?? reviewLensInstructionError(lens.instruction);
  if (error) throw new Error(error);
  return lens;
}

/**
 * Keeps the user's text from closing the frame early. The escaped marker still
 * reads as the original, spelled with JSON-style `\u003c` / `\u003e` escapes.
 */
function neutralizeFrameMarkers(text: string): string {
  return text
    .replaceAll(REVIEW_LENS_FRAME_CLOSE, "\\u003c/reviewer-focus\\u003e")
    .replaceAll(REVIEW_LENS_FRAME_OPEN, "\\u003creviewer-focus\\u003e");
}

/** The framed section for a reviewer prompt, or "" when the reviewer has no lens. */
export function reviewLensSection(lens: ReviewLens | undefined): string {
  const normalized = normalizeReviewLens(lens);
  if (!normalized) return "";
  return `${REVIEW_LENS_PREAMBLE}
${REVIEW_LENS_FRAME_OPEN}
Focus: ${neutralizeFrameMarkers(normalized.label)}

${neutralizeFrameMarkers(normalized.instruction)}
${REVIEW_LENS_FRAME_CLOSE}`;
}

/**
 * Appends the lens section to a reviewer prompt that ends with its panel
 * position. A reviewer without a lens gets its prompt back byte for byte.
 */
export function withReviewLens(prompt: string, lens: ReviewLens | undefined): string {
  const section = reviewLensSection(lens);
  return section ? `${prompt}\n\n${section}` : prompt;
}
