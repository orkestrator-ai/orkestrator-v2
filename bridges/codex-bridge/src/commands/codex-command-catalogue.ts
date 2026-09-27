/**
 * The Codex bridge's executable command catalogue (wire contract version 1,
 * see docs/architecture/native-agent-commands.md).
 *
 * Three kinds of row, each with its own tested executor:
 *
 * - `bridge-local` built-ins (`/help`, `/models`), answered without a turn.
 * - `bridge-template` prompt files, expanded by Orkestrator (compatibility).
 * - `structured-skill` Codex skills, sent as a `{type:"skill"}` input.
 *
 * The same resolution backs the picker (`list`), `/help`, typed dispatch and
 * selected dispatch, so all four agree on reserved names, shadowing and
 * availability. `/steer` and `/compact` are Orkestrator session actions the
 * backend merges itself; this catalogue never lists them.
 */
import {
  commandBindingRevision,
  COMMAND_CATALOGUE_LIMITS,
  NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
  truncateUtf8,
  utf8ByteLength,
  type BridgeCommandCatalogueResponse,
  type NativeAgentBridgeCommandInvocation,
} from "@orkestrator/protocol/agent-command-catalogue";
import { parseCommandToken } from "@orkestrator/protocol/agent-slash-commands";
import type {
  NativeAgentCommandRefreshOutcome,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import type { EngineGeneration } from "../engine/types.js";
import {
  loadTemplateBody,
  scanPromptTemplates,
  TEMPLATE_ID_PREFIX,
  TEMPLATE_LIMITS,
  templateRoots,
  type TemplateEntry,
  type TemplateScan,
} from "../prompts/template-discovery.js";
import { expandTemplateArguments, type TemplateExpansion } from "../prompts/template-format.js";
import {
  SKILL_ALIAS_PREFIX,
  SKILL_ID_PREFIX,
  SkillInventory,
  skillCommandRow,
  skillUnavailability,
  type SkillBinding,
  type SkillInventoryDeps,
  type SkillSnapshot,
} from "./skill-inventory.js";

export const BUILTIN_ID_PREFIX = "codex-builtin:";

export type BuiltinCommandKind = "help" | "models";

const BUILTINS: ReadonlyArray<{ name: string; kind: BuiltinCommandKind; description: string }> = [
  {
    name: "/help",
    kind: "help",
    description: "Show the commands available in this Codex session.",
  },
  {
    name: "/models",
    kind: "models",
    description: "List available Codex models and the current selection.",
  },
];

function builtinRow(builtin: (typeof BUILTINS)[number]): NativeAgentSlashCommand {
  return {
    name: builtin.name,
    id: `${BUILTIN_ID_PREFIX}${builtin.name}`,
    executionKind: "bridge-local",
    source: "builtin",
    origin: "orkestrator",
    scope: "global",
    description: builtin.description,
    bindingRevision: commandBindingRevision(["builtin", builtin.name]),
    inputPolicy: { arguments: "none", attachments: "none", busy: "queue" },
  };
}

export function templateCommandRow(entry: TemplateEntry): NativeAgentSlashCommand {
  return {
    name: entry.displayName,
    id: entry.id,
    executionKind: "bridge-template",
    source: entry.origin,
    origin: entry.origin,
    scope: entry.origin === "project" ? "session" : "global",
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
    bindingRevision: entry.bindingRevision,
    inputPolicy: { arguments: "optional", attachments: "images", busy: "queue" },
    ...(entry.problem
      ? {
          availability: {
            state: "unavailable" as const,
            reason: entry.problem.reason,
            message: truncateUtf8(
              entry.problem.message,
              COMMAND_CATALOGUE_LIMITS.maxAvailabilityMessageBytes,
            ),
          },
        }
      : {}),
  };
}

/**
 * What the prompt path should do with a submission.
 *
 * `refused` is a command error. For a selected command the bridge answers
 * HTTP 422 before journaling; for legacy typed text it answers locally. It is
 * never sent to the model as a plain prompt.
 */
export type CommandPlan =
  | { kind: "text" }
  | { kind: "builtin"; builtin: BuiltinCommandKind }
  | { kind: "template"; entry: TemplateEntry; args: string }
  | { kind: "skill"; binding: SkillBinding; args: string }
  | { kind: "refused"; message: string };

interface CollectedCatalogue {
  commands: NativeAgentSlashCommand[];
  status: "ready" | "stale";
  truncated: boolean;
  templates: TemplateScan;
  skills: SkillSnapshot | null;
}

const EMPTY_SCAN: TemplateScan = { effective: [], shadowed: [], truncated: false, skipped: 0 };
/** Headroom under the wire budget for the envelope around `commands`. */
const WIRE_HEADROOM_BYTES = 4 * 1024;
const HELP_MAX_BYTES = 16 * 1024;
const HELP_MAX_LINES = 300;

function spellingMatches(spellings: readonly string[], typed: string): boolean {
  if (spellings.includes(typed)) return true;
  const folded = typed.toLowerCase();
  return spellings.some((spelling) => spelling.toLowerCase() === folded);
}

/** Exact spelling first, then case-folded — the shared resolver's order. */
function matchByPrecedence<T>(
  items: readonly T[],
  spellingsOf: (item: T) => readonly string[],
  typed: string,
): T[] {
  const exact = items.filter((item) => spellingsOf(item).includes(typed));
  if (exact.length > 0) return exact;
  const folded = typed.toLowerCase();
  return items.filter((item) =>
    spellingsOf(item).some((spelling) => spelling.toLowerCase() === folded),
  );
}

export interface CodexCommandCatalogueOptions {
  engine: {
    listSkills: SkillInventoryDeps["list"];
    info(): { generation: EngineGeneration };
  };
  cwd: string;
  now: () => number;
  skillTtlMs?: number;
  skillRefreshDebounceMs?: number;
}

export class CodexCommandCatalogue {
  readonly skills: SkillInventory;
  /**
   * Bridge-owned inventory revision. Advances whenever an observed inventory
   * actually changes — a coalesced `skills/changed` re-read, a template rescan
   * from any path, or a status change — and never for a read that found the
   * same thing. 0 means nothing has been observed yet.
   */
  private revisionValue = 0;
  private templatesDigest = "";
  private skillsDigest = "";
  private compositeDigest: string | null = null;
  /** Collects parallel observations into a single revision step. */
  private deferredBumps = 0;
  /** Template id → fingerprint as last listed. Bounded by the template limit. */
  private listedTemplates = new Map<string, string | null>();

  constructor(private readonly options: CodexCommandCatalogueOptions) {
    this.skills = new SkillInventory({
      list: (params) => options.engine.listSkills(params),
      generation: () => options.engine.info().generation,
      cwd: options.cwd,
      now: options.now,
      ...(options.skillTtlMs !== undefined ? { ttlMs: options.skillTtlMs } : {}),
      ...(options.skillRefreshDebounceMs !== undefined
        ? { refreshDebounceMs: options.skillRefreshDebounceMs }
        : {}),
      onRefreshed: (read) => {
        this.skillsDigest = commandBindingRevision([
          String(read.fresh),
          read.snapshot
            ? JSON.stringify([read.snapshot.truncated, read.snapshot.bindings.map(skillCommandRow)])
            : "none",
        ]);
        this.bumpIfChanged();
      },
    });
  }

  /** In-memory only: safe for liveness-free status reads. */
  get revision(): number {
    return this.revisionValue;
  }

  private bumpIfChanged(): void {
    if (this.deferredBumps > 0) return;
    const composite = commandBindingRevision([this.templatesDigest, this.skillsDigest]);
    if (composite === this.compositeDigest) return;
    this.compositeDigest = composite;
    this.revisionValue += 1;
  }

  markSkillsChanged(): void {
    this.skills.markChanged();
  }

  withdrawGeneration(generation: EngineGeneration): void {
    this.skills.withdrawGeneration(generation);
  }

  dispose(): void {
    this.skills.dispose();
  }

  async scanTemplates(): Promise<TemplateScan> {
    let scan: TemplateScan;
    try {
      scan = await scanPromptTemplates(templateRoots(this.options.cwd));
    } catch {
      scan = { ...EMPTY_SCAN, truncated: true };
    }
    this.templatesDigest = commandBindingRevision([
      JSON.stringify([scan.truncated, scan.effective.map(templateCommandRow)]),
    ]);
    this.bumpIfChanged();
    return scan;
  }

  /** Template-only rows for the legacy global route: never spawns a child. */
  async listTemplateAndBuiltinRows(): Promise<NativeAgentSlashCommand[]> {
    const templates = await this.scanTemplates();
    return [...BUILTINS.map(builtinRow), ...templates.effective.map(templateCommandRow)];
  }

  private async collect(): Promise<CollectedCatalogue> {
    this.deferredBumps += 1;
    let templates: TemplateScan;
    let skillRead: Awaited<ReturnType<SkillInventory["read"]>>;
    try {
      [templates, skillRead] = await Promise.all([this.scanTemplates(), this.skills.read()]);
    } finally {
      this.deferredBumps -= 1;
    }
    this.bumpIfChanged();
    const candidates = [
      ...BUILTINS.map(builtinRow),
      ...templates.effective.map(templateCommandRow),
      ...(skillRead.snapshot?.bindings.map(skillCommandRow) ?? []),
    ];
    const commands: NativeAgentSlashCommand[] = [];
    let bytes = 0;
    let truncated = templates.truncated || (skillRead.snapshot?.truncated ?? false);
    for (const command of candidates) {
      const size = utf8ByteLength(JSON.stringify(command)) + 1;
      if (
        commands.length >= COMMAND_CATALOGUE_LIMITS.maxCommands ||
        bytes + size > COMMAND_CATALOGUE_LIMITS.maxWireBytes - WIRE_HEADROOM_BYTES
      ) {
        truncated = true;
        break;
      }
      bytes += size;
      commands.push(command);
    }
    return {
      commands,
      // Skills that could not be read, or a cwd app-server reported errors
      // for, make this a partial list rather than an authoritative one.
      status: skillRead.fresh ? "ready" : "stale",
      truncated,
      templates,
      skills: skillRead.snapshot,
    };
  }

  /**
   * The enhanced catalogue response. Metadata only: this touches no session,
   * attaches no thread and never starts a turn; skills come from `skills/list`
   * for the bridge's working directory.
   */
  async list(): Promise<BridgeCommandCatalogueResponse> {
    const collected = await this.collect();
    this.listedTemplates = new Map(
      collected.templates.effective.map((entry) => [entry.id, entry.fingerprint]),
    );
    return {
      catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
      status: collected.status,
      revision: this.revisionValue,
      generation: String(this.options.engine.info().generation),
      // `commandRevision` on the status route signals observed changes, but a
      // template edit is only observed by a rescan, so the backend must still
      // re-read on its TTL.
      freshness: "ttl",
      truncated: collected.truncated,
      commands: collected.commands,
    };
  }

  /** Explicit refresh: rescans skills from disk and rereads templates. */
  async refresh(): Promise<{ outcome: NativeAgentCommandRefreshOutcome; message?: string }> {
    const [skillRead] = await Promise.all([
      this.skills.read({ forceReload: true }),
      this.scanTemplates(),
    ]);
    if (skillRead.error || !skillRead.snapshot) {
      return { outcome: "failed", message: "Codex skills could not be reloaded." };
    }
    return { outcome: "reloaded" };
  }

  // ------------------------------------------------------------ resolution

  /**
   * Resolve an explicit selection from the backend.
   *
   * The id is looked up in this bridge's own registry, and everything the
   * backend claims about it — kind, spelling, binding revision — must still
   * agree. Any mismatch refuses; it never falls back to a prompt.
   */
  async resolveSelected(command: NativeAgentBridgeCommandInvocation): Promise<CommandPlan> {
    const stale = (name: string) => ({
      kind: "refused" as const,
      message: `${name} changed since it was selected. Choose it again from the menu.`,
    });
    const checkRow = (row: NativeAgentSlashCommand): CommandPlan | null => {
      if (row.executionKind !== command.executionKind) return stale(row.name);
      const spellings = [row.insertText ?? row.name, row.name, ...(row.aliases ?? [])];
      if (!spellingMatches(spellings, command.name)) return stale(row.name);
      if (
        command.bindingRevision !== undefined &&
        command.bindingRevision !== row.bindingRevision
      ) {
        return stale(row.name);
      }
      if (row.availability?.state === "unavailable") {
        return {
          kind: "refused",
          message: row.availability.message ?? `${row.name} is not available in this session.`,
        };
      }
      return null;
    };

    if (command.id.startsWith(BUILTIN_ID_PREFIX)) {
      const builtin = BUILTINS.find((entry) => `${BUILTIN_ID_PREFIX}${entry.name}` === command.id);
      if (!builtin) return this.unknownSelection();
      return checkRow(builtinRow(builtin)) ?? { kind: "builtin", builtin: builtin.kind };
    }

    if (command.id.startsWith(TEMPLATE_ID_PREFIX)) {
      const scan = await this.scanTemplates();
      const entry = scan.effective.find((candidate) => candidate.id === command.id);
      if (!entry) {
        const shadowed = scan.shadowed.find((candidate) => candidate.id === command.id);
        return shadowed
          ? {
              kind: "refused",
              message: `A project prompt named ${shadowed.name} now takes precedence over the one you selected. Choose it again from the menu.`,
            }
          : this.unknownSelection();
      }
      const refused = checkRow(templateCommandRow(entry));
      if (refused) return refused;
      if (
        this.listedTemplates.has(entry.id) &&
        this.listedTemplates.get(entry.id) !== entry.fingerprint
      ) {
        // Record what is there now so choosing it again succeeds.
        this.listedTemplates.set(entry.id, entry.fingerprint);
        return {
          kind: "refused",
          message: `${entry.name} changed after it was listed. Choose it again from the menu.`,
        };
      }
      return { kind: "template", entry, args: command.arguments };
    }

    if (command.id.startsWith(SKILL_ID_PREFIX)) {
      const read = await this.skills.read();
      if (!read.snapshot) {
        return {
          kind: "refused",
          message: "Codex skills could not be listed right now. Try again in a moment.",
        };
      }
      const binding = read.snapshot.byId.get(command.id);
      if (!binding) return this.unknownSelection();
      return (
        checkRow(skillCommandRow(binding)) ?? { kind: "skill", binding, args: command.arguments }
      );
    }

    return this.unknownSelection();
  }

  private unknownSelection(): CommandPlan {
    return {
      kind: "refused",
      message: "The selected command is no longer available. Choose it again from the menu.",
    };
  }

  /**
   * Legacy typed dispatch (no selection). Unknown tokens and ordinary text
   * stay ordinary text; a recognised command that cannot run is refused.
   * `$name` stays provider-native text: Codex resolves its own mentions.
   */
  async resolveTyped(prompt: string): Promise<CommandPlan> {
    const token = parseCommandToken(prompt, ["/"]);
    if (!token) return { kind: "text" };
    const typed = token.token;

    const builtin = matchByPrecedence(BUILTINS, (entry) => [entry.name], typed)[0];
    if (builtin) return { kind: "builtin", builtin: builtin.kind };

    if (typed.toLowerCase().startsWith(SKILL_ALIAS_PREFIX)) {
      return this.resolveTypedSkill(typed, token.arguments);
    }

    const scan = await this.scanTemplates();
    const matches = matchByPrecedence(scan.effective, (entry) => [entry.displayName], typed);
    if (matches.length === 0) return { kind: "text" };
    if (matches.length > 1) {
      return {
        kind: "refused",
        message: `${typed} matches more than one prompt. Choose one from the menu.`,
      };
    }
    const entry = matches[0]!;
    if (entry.problem) return { kind: "refused", message: entry.problem.message };
    return { kind: "template", entry, args: token.arguments };
  }

  private async resolveTypedSkill(typed: string, args: string): Promise<CommandPlan> {
    const read = await this.skills.read();
    if (!read.snapshot) {
      return {
        kind: "refused",
        message: "Codex skills could not be listed right now, so this skill was not run.",
      };
    }
    const matches = matchByPrecedence(
      read.snapshot.bindings,
      (binding) => [`${SKILL_ALIAS_PREFIX}${binding.name}`],
      typed,
    );
    if (matches.length === 0) {
      return {
        kind: "refused",
        message: `No Codex skill named ${typed.slice(SKILL_ALIAS_PREFIX.length)} is available here. Type /help to see the available skills.`,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "refused",
        message: `${typed} matches more than one Codex skill. Choose one from the menu.`,
      };
    }
    const binding = matches[0]!;
    const unavailable = skillUnavailability(binding);
    if (unavailable) return { kind: "refused", message: unavailable.message };
    return { kind: "skill", binding, args };
  }

  // -------------------------------------------------------------- execution

  /**
   * Load the chosen template and substitute its arguments. Pure apart from the
   * bounded file read: no shell, no network, no side effect before the
   * dispatch journal's prepared mark.
   */
  async expandTemplate(entry: TemplateEntry, args: string): Promise<TemplateExpansion> {
    const loaded = await loadTemplateBody(entry);
    if (!loaded.ok) return loaded;
    return expandTemplateArguments(loaded.body, args, TEMPLATE_LIMITS.maxExpandedBytes);
  }

  /** `/help`: the same qualified catalogue the picker shows, bounded. */
  async helpText(): Promise<string> {
    const collected = await this.collect();
    const lines: string[] = ["Available Codex slash commands:"];
    const describe = (row: NativeAgentSlashCommand, label: string) => {
      const hint = row.argumentHint ? ` ${row.argumentHint}` : "";
      const detail =
        row.availability?.state === "unavailable"
          ? ` (unavailable: ${row.availability.message ?? row.availability.reason ?? "not available"})`
          : row.description
            ? `: ${row.description}`
            : "";
      return `- ${label}${hint}${detail}`;
    };
    const builtins = collected.commands.filter((row) => row.executionKind === "bridge-local");
    const templates = collected.commands.filter((row) => row.executionKind === "bridge-template");
    const skills = collected.commands.filter((row) => row.executionKind === "structured-skill");
    lines.push("", "Built in:", ...builtins.map((row) => describe(row, row.name)));
    lines.push("", "Prompt templates (Orkestrator compatibility, .codex/prompts):");
    if (templates.length > 0) lines.push(...templates.map((row) => describe(row, row.name)));
    else lines.push("No Codex prompt commands were discovered in this environment.");
    lines.push("", "Skills (type $name; /skill:name also works):");
    if (skills.length > 0) {
      lines.push(...skills.map((row) => describe(row, row.insertText ?? row.name)));
    } else if (collected.skills) {
      lines.push("No Codex skills were discovered for this workspace.");
    }
    if (collected.status === "stale") {
      lines.push("", "Codex skills could not be fully listed; this list may be incomplete.");
    }
    if (collected.truncated)
      lines.push("", "Some commands were not listed because of size limits.");

    const bounded: string[] = [];
    let bytes = 0;
    for (const [index, line] of lines.entries()) {
      const size = utf8ByteLength(line) + 1;
      if (bounded.length >= HELP_MAX_LINES || bytes + size > HELP_MAX_BYTES) {
        bounded.push(`…and ${lines.length - index} more lines.`);
        break;
      }
      bytes += size;
      bounded.push(line);
    }
    return bounded.join("\n");
  }
}
