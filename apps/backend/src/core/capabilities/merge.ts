/**
 * Three-way merge of a component's files for "Local changes"
 * (docs/architecture/agent-capabilities-management.md, "Reconciliation").
 *
 * `base` is the revision the machine's copy was installed from (kept in the
 * artifact cache), `ours` is what the machine has now, `theirs` is the
 * package's configured revision. A text file is merged line by line with the
 * classic diff3 chunking: a region only one side changed takes that side, a
 * region both sides changed identically takes it once, and anything else is
 * a conflict the user resolves by hand. Binary files cannot be merged; one
 * changed on both sides is reported, never guessed.
 *
 * Pure and bounded: no I/O, and a diff whose edit distance passes
 * `MAX_EDIT_DISTANCE` is treated as one conflict instead of exhausting memory.
 */

/** Edits beyond this make the whole differing region one conflict. */
const MAX_EDIT_DISTANCE = 2_000;

export type MergeChunk =
  | { kind: "stable"; lines: string[] }
  | { kind: "conflict"; base: string[]; ours: string[]; theirs: string[] };

export interface TextMergeResult {
  /** No conflicts: `text` is the merged file. */
  clean: boolean;
  /** The merged text; conflicts carry `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>` markers. */
  text: string;
  conflicts: number;
  chunks: MergeChunk[];
}

export interface MergeLabels {
  ours: string;
  base: string;
  theirs: string;
}

const DEFAULT_LABELS: MergeLabels = { ours: "local", base: "base", theirs: "configured" };

/** NUL in the first 8 KiB, or bytes that are not UTF-8: not mergeable as text. */
export function isBinaryContent(content: Uint8Array): boolean {
  const head = content.subarray(0, 8_192);
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return false;
  } catch {
    return true;
  }
}

/** Splits into lines that keep their `\n`; a last line without one stays as it is. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineEnding(text: string): "\r\n" | "\n" {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Matches `a` against `b` (Myers' O(ND) diff): `match[i]` is the index in `b`
 * of line `i` of `a`, or -1. `null` when the edit distance passes the bound.
 */
function matchLines(a: readonly string[], b: readonly string[]): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start;
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    match[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return match;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    // Only diagonals -d-1..d+1 are read when walking back from step d.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk the trace back, recording the diagonal (matching) moves.
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d]!;
    const at = (diagonal: number) => previous[diagonal + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      match[start + x] = start + y;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    match[start + x] = start + y;
  }
  return match;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** diff3 over lines: stable runs where all three agree, and the regions between them. */
export function mergeLines(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeChunk[] {
  const toOurs = matchLines(base, ours);
  const toTheirs = matchLines(base, theirs);
  if (!toOurs || !toTheirs) {
    return resolveRegion(base, ours, theirs);
  }
  const chunks: MergeChunk[] = [];
  let o = 0;
  let a = 0;
  let b = 0;
  const pushStable = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last?.kind === "stable") last.lines.push(...lines);
    else chunks.push({ kind: "stable", lines });
  };
  while (o < base.length || a < ours.length || b < theirs.length) {
    // The longest run from here where base, ours and theirs all match in step.
    let run = 0;
    while (o + run < base.length && toOurs[o + run] === a + run && toTheirs[o + run] === b + run) {
      run += 1;
    }
    if (run > 0) {
      pushStable(base.slice(o, o + run) as string[]);
      o += run;
      a += run;
      b += run;
      continue;
    }
    // The next base line both sides still keep (in order) ends the unstable region.
    let next = o;
    while (
      next < base.length &&
      !(toOurs[next]! >= a && toTheirs[next]! >= b && toOurs[next]! >= 0 && toTheirs[next]! >= 0)
    ) {
      next += 1;
    }
    const nextA = next < base.length ? toOurs[next]! : ours.length;
    const nextB = next < base.length ? toTheirs[next]! : theirs.length;
    for (const chunk of resolveRegion(
      base.slice(o, next),
      ours.slice(a, nextA),
      theirs.slice(b, nextB),
    )) {
      if (chunk.kind === "stable") pushStable(chunk.lines);
      else chunks.push(chunk);
    }
    o = next;
    a = nextA;
    b = nextB;
  }
  return chunks;
}

function resolveRegion(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeChunk[] {
  if (sameLines(ours, base)) return [{ kind: "stable", lines: [...theirs] }];
  if (sameLines(theirs, base)) return [{ kind: "stable", lines: [...ours] }];
  if (sameLines(ours, theirs)) return [{ kind: "stable", lines: [...ours] }];
  return [{ kind: "conflict", base: [...base], ours: [...ours], theirs: [...theirs] }];
}

function withNewline(lines: readonly string[]): string {
  const text = lines.join("");
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Merges three versions of one text file. Line endings are compared without
 * their `\r`, so a side that only converted CRLF/LF does not conflict; the
 * result uses the local file's ending when the local side changed it, else
 * the configured revision's.
 */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  labels: MergeLabels = DEFAULT_LABELS,
): TextMergeResult {
  const eol = lineEnding(ours) !== lineEnding(base) ? lineEnding(ours) : lineEnding(theirs);
  const normalize = (text: string) => splitLines(text.replace(/\r\n/g, "\n"));
  const chunks = mergeLines(normalize(base), normalize(ours), normalize(theirs));
  let text = "";
  let conflicts = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "stable") {
      text += chunk.lines.join("");
      continue;
    }
    conflicts += 1;
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text +=
      `<<<<<<< ${labels.ours}\n${withNewline(chunk.ours)}` +
      `||||||| ${labels.base}\n${withNewline(chunk.base)}` +
      `=======\n${withNewline(chunk.theirs)}` +
      `>>>>>>> ${labels.theirs}\n`;
  }
  if (eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  return { clean: conflicts === 0, text, conflicts, chunks };
}

/** True when a resolved text still carries diff3 conflict markers. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} /m.test(text) && /^={7}\r?$/m.test(text) && /^>{7} /m.test(text);
}

// --- Trees -------------------------------------------------------------------

export interface MergeTreeFile {
  content: Buffer;
  executable: boolean;
}

export type FileMergeOutcome =
  | { path: string; outcome: "unchanged" | "local" | "configured" | "merged"; file: MergeTreeFile }
  | { path: string; outcome: "deleted" }
  | {
      path: string;
      outcome: "conflict";
      kind: "text" | "binary" | "deleted-locally" | "deleted-in-revision";
      /** The executable bit a resolution keeps (the changed side's). */
      executable: boolean;
      base?: Buffer;
      ours?: Buffer;
      theirs?: Buffer;
      /** Text conflicts: the merged text with markers. */
      merged?: string;
      chunks?: MergeChunk[];
    };

function sameFile(a: MergeTreeFile | undefined, b: MergeTreeFile | undefined): boolean {
  if (!a || !b) return a === b;
  return a.executable === b.executable && a.content.equals(b.content);
}

/** Merges one path given its three versions (absent = not in that tree). */
export function mergeFile(
  path: string,
  base: MergeTreeFile | undefined,
  ours: MergeTreeFile | undefined,
  theirs: MergeTreeFile | undefined,
  labels: MergeLabels = DEFAULT_LABELS,
): FileMergeOutcome {
  if (sameFile(ours, theirs)) {
    if (!ours) return { path, outcome: "deleted" };
    return { path, outcome: sameFile(ours, base) ? "unchanged" : "local", file: ours };
  }
  if (sameFile(ours, base)) {
    return theirs ? { path, outcome: "configured", file: theirs } : { path, outcome: "deleted" };
  }
  if (sameFile(theirs, base)) {
    return ours ? { path, outcome: "local", file: ours } : { path, outcome: "deleted" };
  }
  // Both sides changed it, differently.
  if (!ours || !theirs) {
    return {
      path,
      outcome: "conflict",
      kind: ours ? "deleted-in-revision" : "deleted-locally",
      executable: (ours ?? theirs)?.executable ?? false,
      ...(base ? { base: base.content } : {}),
      ...(ours ? { ours: ours.content } : {}),
      ...(theirs ? { theirs: theirs.content } : {}),
    };
  }
  const executable =
    base && ours.executable !== base.executable ? ours.executable : theirs.executable;
  if (
    isBinaryContent(ours.content) ||
    isBinaryContent(theirs.content) ||
    (base && isBinaryContent(base.content))
  ) {
    if (ours.content.equals(theirs.content)) {
      return { path, outcome: "merged", file: { content: ours.content, executable } };
    }
    return {
      path,
      outcome: "conflict",
      kind: "binary",
      executable,
      ...(base ? { base: base.content } : {}),
      ours: ours.content,
      theirs: theirs.content,
    };
  }
  const merged = mergeText(
    base?.content.toString("utf8") ?? "",
    ours.content.toString("utf8"),
    theirs.content.toString("utf8"),
    labels,
  );
  if (merged.clean) {
    return { path, outcome: "merged", file: { content: Buffer.from(merged.text), executable } };
  }
  return {
    path,
    outcome: "conflict",
    kind: "text",
    executable,
    ...(base ? { base: base.content } : {}),
    ours: ours.content,
    theirs: theirs.content,
    merged: merged.text,
    chunks: merged.chunks,
  };
}

/** Merges three trees keyed by relative path; outcomes are sorted by path. */
export function mergeTrees(
  base: ReadonlyMap<string, MergeTreeFile>,
  ours: ReadonlyMap<string, MergeTreeFile>,
  theirs: ReadonlyMap<string, MergeTreeFile>,
  labels: MergeLabels = DEFAULT_LABELS,
): FileMergeOutcome[] {
  const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();
  return paths.map((path) =>
    mergeFile(path, base.get(path), ours.get(path), theirs.get(path), labels),
  );
}
