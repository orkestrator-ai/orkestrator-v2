/**
 * The insight stage: a model reads new conversation parts and writes friction
 * notes; a stronger model groups the notes into themes across conversations;
 * each theme becomes a signal (`insight:<slug>`) the ledger tracks and verifies
 * like any other.
 *
 * A theme's measure is the share of read conversations that show it, per app
 * version, so a quiet week cannot pass for a fix. Notes, themes and the cursor
 * live in `<state dir>/insights/` (owner-only): they hold paraphrases and short
 * quotes of what people wrote, never tool output or file contents.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BundleData } from "../bundle.js";
import { writeAtomic } from "../ledger.js";
import { scoreSignal, type Signal, UNKNOWN_VERSION, versionTimeline } from "../signals.js";
import { type ModelRunner, NOTES_MODEL, THEMES_MODEL } from "./model.js";
import {
  cursorAfter,
  type InsightCursor,
  loadCursor,
  saveCursor,
  type Segment,
  selectSegments,
} from "./prepare.js";
import type { TranscriptSources } from "./transcripts.js";

/** Notes the theme step reads: the newest within this window. */
export const THEME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_THEME_NOTES = 400;
/** Notes kept on disk. */
const NOTE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_STORED_NOTES = 3000;
const MAX_THEME_CONVERSATIONS = 200;
/** Parts read at once. */
const NOTE_CONCURRENCY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NOTE_KINDS = [
  "repeated-instruction",
  "confusion",
  "workaround",
  "agent-mistake",
  "missing-feature",
  "slow-or-stuck",
  "other-friction",
] as const;
export const FIX_WHERE = ["orkestrator", "instructions", "provider", "unclear"] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];
export type FixWhere = (typeof FIX_WHERE)[number];

export interface Note {
  id: string;
  conversationId: string;
  provider: string;
  project: string;
  at: number;
  kind: NoteKind;
  area: string;
  summary: string;
  quote: string;
  severity: 1 | 2 | 3;
  fixWhere: FixWhere;
}

export interface ThemeConversation {
  at: number;
  project: string;
}

export interface Theme {
  slug: string;
  title: string;
  kind: NoteKind;
  fixWhere: FixWhere;
  summary: string;
  suggestion: string;
  acceptance: string;
  severity: 1 | 2 | 3;
  examples: Array<{ at: number; project: string; summary: string; quote: string }>;
  conversations: Record<string, ThemeConversation>;
  updatedAt: number;
}

export interface ThemeStore {
  schemaVersion: 1;
  themes: Record<string, Theme>;
  /**
   * Set when saved notes have not been grouped yet: a part's notes are saved
   * before grouping runs, so a failed grouping is retried from this marker on
   * the next run even when no new notes arrive.
   */
  pendingGrouping?: boolean;
}

const NOTES_SYSTEM = `You review one conversation between a person and an AI coding agent working inside Orkestrator, a desktop app that runs coding agents (Claude Code, Codex and others) in worktrees and containers, with build pipelines, reviews, a Kanban board, a coordinator agent and more.

Find friction in how the work went: the tools, the agents, the app and the workflow. Not the defects in the code being worked on: a bug the person asked the agent to fix is the task, not friction, even when the project is Orkestrator itself.

Look for:
- repeated-instruction: the person tells the agent something they clearly have to keep telling agents (a rule, a preference, a step).
- confusion: the person is unsure how something works, or the agent misreads what they meant.
- workaround: the person does a sequence by hand that the app or agent could do, or steers around something that does not work well.
- agent-mistake: the agent does something wrong the person has to catch (wrong tool, ignored rule, claims success without checking).
- missing-feature: the person asks for, or clearly needs, something the app does not do.
- slow-or-stuck: work stalls, is interrupted, retried or abandoned.
- other-friction: anything else that made the work harder than it should be.

Lines marked AGENT MESSAGE or SYSTEM were not typed by the person: count friction in them only when it is about how agents work together.

For each finding give: a short area name (for example "build pipeline", "git push", "transcript view", "agent instructions"); a one-sentence summary in your own words; a quote of at most 200 characters of the PERSON's own words that shows it ("" if none fits; never quote code, paths, tokens or the agent); severity 1 (minor) to 3 (blocked or cost real time); and where it is best fixed: orkestrator (the app), instructions (a rule in AGENTS.md, a skill or a prompt), provider (the model or agent itself), or unclear.

Report only clear findings. Return an empty list when the conversation went smoothly or there is too little to judge. At most 8 findings.`;

const NOTES_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...NOTE_KINDS] },
          area: { type: "string", maxLength: 60 },
          summary: { type: "string", maxLength: 300 },
          quote: { type: "string", maxLength: 200 },
          severity: { type: "integer", minimum: 1, maximum: 3 },
          fixWhere: { type: "string", enum: [...FIX_WHERE] },
        },
        required: ["kind", "area", "summary", "quote", "severity", "fixWhere"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
};

const THEMES_SYSTEM = `You turn friction notes from many conversations between a person and AI coding agents (run through Orkestrator, a desktop app for coding agents) into a short list of themes worth acting on.

A theme is one underlying problem or opportunity that shows up across conversations: something the person keeps steering around, keeps repeating, keeps being confused by, or keeps doing by hand. Merge notes that share a cause even when worded differently. Prefer the change that would remove the friction, not a description of the symptom.

You are given the existing themes. When notes belong to an existing theme, reuse its slug exactly and list the new note ids under it; you may sharpen its title and texts. Create a new theme, with a new kebab-case slug, only for a different problem. Never reuse a slug for a different problem.

Include a theme only when its notes come from at least two different conversations, or from one conversation with severity 3. Leave out one-offs and themes about the code being worked on rather than the workflow. At most 12 themes, most important first.

For each theme give: slug; a title under 90 characters naming the problem; kind (the dominant note kind); fixWhere: orkestrator (a change to the app), instructions (a rule in AGENTS.md, a skill or a prompt template), provider (the model or agent; nothing to change here), or unclear; a summary of two or three sentences; a concrete suggestion for the change; one acceptance criterion a person could check; severity 1 to 3; and the ids of every note that belongs to it.`;

const THEMES_SCHEMA = {
  type: "object",
  properties: {
    themes: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 60 },
          title: { type: "string", maxLength: 90 },
          kind: { type: "string", enum: [...NOTE_KINDS] },
          fixWhere: { type: "string", enum: [...FIX_WHERE] },
          summary: { type: "string", maxLength: 800 },
          suggestion: { type: "string", maxLength: 800 },
          acceptance: { type: "string", maxLength: 300 },
          severity: { type: "integer", minimum: 1, maximum: 3 },
          noteIds: { type: "array", items: { type: "string" }, maxItems: 200 },
        },
        required: [
          "slug",
          "title",
          "kind",
          "fixWhere",
          "summary",
          "suggestion",
          "acceptance",
          "severity",
          "noteIds",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["themes"],
  additionalProperties: false,
};

interface NotesOutput {
  notes: Array<Omit<Note, "id" | "conversationId" | "provider" | "project" | "at">>;
}

interface ThemesOutput {
  themes: Array<{
    slug: string;
    title: string;
    kind: NoteKind;
    fixWhere: FixWhere;
    summary: string;
    suggestion: string;
    acceptance: string;
    severity: 1 | 2 | 3;
    noteIds: string[];
  }>;
}

export function insightsDir(stateDir: string): string {
  return path.join(stateDir, "insights");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadNotes(dir: string): Note[] {
  const stored = readJson<{ schemaVersion?: number; notes?: Note[] }>(
    path.join(dir, "notes.json"),
    {},
  );
  return stored.schemaVersion === 1 && Array.isArray(stored.notes) ? stored.notes : [];
}

export function saveNotes(dir: string, notes: Note[], now: number): void {
  const kept = notes
    .filter((note) => now - note.at <= NOTE_RETENTION_MS)
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_STORED_NOTES);
  writeAtomic(
    path.join(dir, "notes.json"),
    `${JSON.stringify({ schemaVersion: 1, notes: kept })}\n`,
  );
}

export function loadThemes(dir: string): ThemeStore {
  const stored = readJson<ThemeStore | null>(path.join(dir, "themes.json"), null);
  return stored?.schemaVersion === 1 && stored.themes ? stored : { schemaVersion: 1, themes: {} };
}

export function saveThemes(dir: string, store: ThemeStore): void {
  writeAtomic(path.join(dir, "themes.json"), `${JSON.stringify(store, null, 2)}\n`);
}

function clamp(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

/** Reads one part and returns its notes. */
export async function notesFor(
  segment: Segment,
  runner: ModelRunner,
): Promise<{ notes: Note[]; costUsd: number }> {
  const { output, costUsd } = await runner<NotesOutput>({
    model: NOTES_MODEL,
    system: NOTES_SYSTEM,
    prompt: segment.text,
    schema: NOTES_SCHEMA,
  });
  const notes = (Array.isArray(output?.notes) ? output.notes : [])
    .slice(0, 8)
    .flatMap((note, index): Note[] => {
      if (!NOTE_KINDS.includes(note.kind) || !FIX_WHERE.includes(note.fixWhere)) return [];
      return [
        {
          id: `${segment.conversationId}#${segment.key}#${index}`,
          conversationId: segment.conversationId,
          provider: segment.provider,
          project: segment.project,
          at: segment.lastAt,
          kind: note.kind,
          area: clamp(note.area, 60),
          summary: clamp(note.summary, 300),
          quote: clamp(note.quote, 200),
          severity: Math.min(3, Math.max(1, Math.round(Number(note.severity) || 1))) as 1 | 2 | 3,
          fixWhere: note.fixWhere,
        },
      ];
    });
  return { notes, costUsd };
}

function renderNotes(notes: readonly Note[]): string {
  return notes
    .map(
      (note) =>
        `${note.id} | ${new Date(note.at).toISOString().slice(0, 10)} | ${note.project} | ${note.kind} | sev ${note.severity} | ${note.fixWhere} | ${note.area} | ${note.summary}${note.quote ? ` | quote: "${note.quote}"` : ""}`,
    )
    .join("\n");
}

function renderThemes(store: ThemeStore, statusOf: (slug: string) => string | null): string {
  const themes = Object.values(store.themes);
  if (themes.length === 0) return "(none yet)";
  return themes
    .map((theme) => {
      const status = statusOf(theme.slug);
      return `${theme.slug} | ${theme.title} | ${theme.kind} | ${theme.fixWhere} | ${Object.keys(theme.conversations).length} conversations${status ? ` | ticket ${status}` : ""}\n  ${theme.summary}`;
    })
    .join("\n");
}

/** Groups recent notes into themes, merged into the store. */
export async function updateThemes(
  store: ThemeStore,
  notes: readonly Note[],
  runner: ModelRunner,
  now: number,
  statusOf: (slug: string) => string | null,
): Promise<{ changed: string[]; costUsd: number }> {
  const recent = notes
    .filter((note) => now - note.at <= THEME_WINDOW_MS)
    .sort((left, right) => right.at - left.at)
    .slice(0, MAX_THEME_NOTES);
  if (recent.length === 0) return { changed: [], costUsd: 0 };
  const prompt = [
    "Existing themes (slug | title | kind | fix where | conversations | ticket status):",
    renderThemes(store, statusOf),
    "",
    `Notes from the last ${THEME_WINDOW_MS / DAY_MS} days (id | date | project | kind | severity | fix where | area | summary | quote):`,
    renderNotes(recent),
  ].join("\n");
  const { output, costUsd } = await runner<ThemesOutput>({
    model: THEMES_MODEL,
    system: THEMES_SYSTEM,
    prompt,
    schema: THEMES_SCHEMA,
  });
  const byId = new Map(recent.map((note) => [note.id, note]));
  const changed: string[] = [];
  for (const proposed of (Array.isArray(output?.themes) ? output.themes : []).slice(0, 12)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposed.slug)) continue;
    const members = proposed.noteIds
      .map((id) => byId.get(id))
      .filter((note): note is Note => note !== undefined);
    if (members.length === 0) continue;
    const existing = store.themes[proposed.slug];
    const conversations: Record<string, ThemeConversation> = { ...existing?.conversations };
    for (const note of members)
      conversations[note.conversationId] = { at: note.at, project: note.project };
    const kept = Object.entries(conversations)
      .filter(([, conversation]) => now - conversation.at <= NOTE_RETENTION_MS)
      .sort((left, right) => right[1].at - left[1].at)
      .slice(0, MAX_THEME_CONVERSATIONS);
    const examples = [...members]
      .sort((left, right) => right.severity - left.severity || right.at - left.at)
      .slice(0, 5)
      .map((note) => ({
        at: note.at,
        project: note.project,
        summary: note.summary,
        quote: note.quote,
      }));
    store.themes[proposed.slug] = {
      slug: proposed.slug,
      title: clamp(proposed.title, 90),
      kind: NOTE_KINDS.includes(proposed.kind) ? proposed.kind : "other-friction",
      fixWhere: FIX_WHERE.includes(proposed.fixWhere) ? proposed.fixWhere : "unclear",
      summary: clamp(proposed.summary, 800),
      suggestion: clamp(proposed.suggestion, 800),
      acceptance: clamp(proposed.acceptance, 300),
      severity: Math.min(3, Math.max(1, Math.round(Number(proposed.severity) || 1))) as 1 | 2 | 3,
      examples: examples.length > 0 ? examples : (existing?.examples ?? []),
      conversations: Object.fromEntries(kept),
      updatedAt: now,
    };
    changed.push(proposed.slug);
  }
  return { changed, costUsd };
}

/**
 * Conversations a model reviewed per app version within the window: the
 * denominator of a theme's share and the evidence a fix is judged on.
 * Conversations skipped for holding only system messages do not count.
 */
export function readConversationsByVersion(
  cursor: InsightCursor,
  versionAt: (at: number) => string,
  now: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of Object.values(cursor.conversations)) {
    const reviewedAt = entry.reviewedAt;
    if (reviewedAt === undefined || now - reviewedAt > THEME_WINDOW_MS) continue;
    const version = versionAt(reviewedAt);
    counts[version] = (counts[version] ?? 0) + 1;
  }
  return counts;
}

/**
 * One signal per theme. Its measure is the share of read conversations in the
 * window that show it; its version slices count the theme's conversations per
 * app version. `observedHours.insights` holds the conversations read per
 * version, so the ledger's per-version share is the same quantity.
 */
export function themeSignals(
  store: ThemeStore,
  readByVersion: Record<string, number>,
  versionAt: (at: number) => string,
  now: number,
): Signal[] {
  const totalRead = Object.values(readByVersion).reduce((sum, count) => sum + count, 0);
  const signals: Signal[] = [];
  for (const theme of Object.values(store.themes)) {
    const recent = Object.values(theme.conversations).filter(
      (conversation) => now - conversation.at <= THEME_WINDOW_MS,
    );
    if (recent.length === 0) continue;
    const versions: Signal["versions"] = {};
    const days = new Set<string>();
    for (const conversation of recent) {
      const version = versionAt(conversation.at);
      versions[version] = { count: (versions[version]?.count ?? 0) + 1 };
      days.add(new Date(conversation.at).toISOString().slice(0, 10));
    }
    const times = recent.map((conversation) => conversation.at);
    const share = totalRead > 0 ? Math.round((recent.length / totalRead) * 1000) / 1000 : 0;
    const signal: Signal = {
      signature: `insight:${theme.slug}`,
      category: "insight",
      source: "insights",
      title: theme.title,
      count: recent.length,
      firstAt: new Date(Math.min(...times)).toISOString(),
      lastAt: new Date(Math.max(...times)).toISOString(),
      activeDays: days.size,
      measure: { kind: "rate", unit: "of conversations", value: share },
      versions,
      evidence: {
        conversations: recent.length,
        projects: new Set(recent.map((conversation) => conversation.project)).size,
        severity: theme.severity,
        fixWhere: theme.fixWhere,
        kind: theme.kind,
      },
      score: 0,
    };
    signal.score =
      scoreSignal({ ...signal, measure: { ...signal.measure, value: recent.length / 30 } }) +
      theme.severity * 10;
    signals.push(signal);
  }
  return signals.sort(
    (left, right) => right.score - left.score || left.signature.localeCompare(right.signature),
  );
}

export interface InsightRun {
  signals: Signal[];
  themes: ThemeStore;
  /** Conversations read per app version (the denominator of each share). */
  readByVersion: Record<string, number>;
  read: number;
  waiting: number;
  notesAdded: number;
  themesChanged: number;
  /**
   * Saved notes are still waiting to be grouped (grouping failed or did not
   * run): the themes undercount, so no fix may be judged from them this run.
   */
  groupingPending: boolean;
  costUsd: number;
  errors: string[];
}

export interface InsightOptions {
  stateDir: string;
  data: BundleData;
  runner: ModelRunner;
  sources: TranscriptSources;
  excludeDirs: string[];
  now: number;
  dryRun?: boolean;
  statusOf: (slug: string) => string | null;
  /** Called when the run moves on to grouping notes into themes. */
  onThemes?: () => void;
}

/** Reads new conversation parts, updates themes and returns one signal per theme. */
export async function runInsights(options: InsightOptions): Promise<InsightRun> {
  const dir = insightsDir(options.stateDir);
  const cursor = loadCursor(dir);
  const notes = loadNotes(dir);
  const store = loadThemes(dir);
  const timeline = versionTimeline(
    options.data.essential,
    options.data.manifest.appVersion || UNKNOWN_VERSION,
  );
  const run: InsightRun = {
    signals: [],
    themes: store,
    readByVersion: {},
    read: 0,
    waiting: 0,
    notesAdded: 0,
    themesChanged: 0,
    groupingPending: false,
    costUsd: 0,
    errors: [],
  };

  const selection = await selectSegments({
    sources: options.sources,
    cursor,
    now: options.now,
    excludeDirs: options.excludeDirs,
  });
  run.waiting = selection.waiting;

  if (options.dryRun) {
    run.read = selection.segments.length;
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const skipped of selection.skipped) {
      cursor.conversations[skipped.conversationId] = cursorAfter(
        skipped,
        false,
        cursor.conversations[skipped.conversationId],
        options.now,
      );
    }
    const queue = [...selection.segments];
    // One line per distinct problem, with how many parts it hit.
    const failures = new Map<string, number>();
    const worker = async () => {
      for (let segment = queue.shift(); segment; segment = queue.shift()) {
        try {
          const result = await notesFor(segment, options.runner);
          notes.push(
            ...result.notes.filter((note) => !notes.some((existing) => existing.id === note.id)),
          );
          run.notesAdded += result.notes.length;
          run.costUsd += result.costUsd;
          run.read += 1;
          cursor.conversations[segment.conversationId] = cursorAfter(
            segment,
            true,
            cursor.conversations[segment.conversationId],
            options.now,
          );
          // Marked before the notes are saved, so no saved note can miss grouping.
          if (result.notes.length > 0 && !store.pendingGrouping) {
            store.pendingGrouping = true;
            saveThemes(dir, store);
          }
          // Saved after every part, so an interrupted run loses nothing it paid for.
          saveNotes(dir, notes, options.now);
          saveCursor(dir, cursor, options.now);
        } catch (error) {
          const message = (error as Error).message;
          failures.set(message, (failures.get(message) ?? 0) + 1);
          // Nothing else can succeed without Claude Code, or once the backend stops.
          if (/not installed|backend is stopping/.test(message)) queue.length = 0;
        }
      }
    };
    await Promise.all(Array.from({ length: NOTE_CONCURRENCY }, worker));
    saveCursor(dir, cursor, options.now);
    for (const [message, count] of failures) {
      run.errors.push(
        count > 1
          ? `${message} (${count} parts; they are read again next run)`
          : `${message} (read again next run)`,
      );
    }

    // Also when an earlier run saved notes and then failed to group them.
    if (store.pendingGrouping) {
      options.onThemes?.();
      try {
        const themes = await updateThemes(
          store,
          notes,
          options.runner,
          options.now,
          options.statusOf,
        );
        run.themesChanged = themes.changed.length;
        run.costUsd += themes.costUsd;
        delete store.pendingGrouping;
        saveThemes(dir, store);
      } catch (error) {
        run.errors.push(`themes: ${(error as Error).message} (grouped again next run)`);
      }
    }
  }
  run.groupingPending = store.pendingGrouping === true;

  run.readByVersion = readConversationsByVersion(cursor, timeline.versionAt, options.now);
  run.signals = themeSignals(store, run.readByVersion, timeline.versionAt, options.now);
  return run;
}
