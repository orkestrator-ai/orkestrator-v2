/**
 * Runtime capability evidence a bridge reports for one session
 * (docs/architecture/agent-capabilities-management.md, "Runtime proof").
 *
 * A bridge answers `GET /session/:id/capability-evidence` from what its
 * provider itself reported: the plugins the latest query loaded (with their
 * directories, so a content-addressed directory names the exact bytes), the
 * skills it listed (Pi: with each skill's `SKILL.md` path, since its
 * session-private skills arrive as skill paths rather than a plugin), and the
 * skills the agent invoked. The Claude and Pi bridges serve it. The route is no-touch
 * like `/activity`: it never resolves, hydrates or re-attaches a session, and
 * an unknown session is answered in band as `missing`, never 404.
 *
 * Nothing here carries content: names and directories only, each bounded.
 */

/** Maximum encoded response size the backend accepts. */
export const MAX_CAPABILITY_EVIDENCE_BYTES = 256 * 1024;

/** Most rows of each list a bridge reports or a reader keeps. */
export const MAX_CAPABILITY_EVIDENCE_ENTRIES = 256;
/** Longest name kept. */
export const MAX_CAPABILITY_EVIDENCE_NAME = 256;
/** Longest directory kept. */
export const MAX_CAPABILITY_EVIDENCE_PATH = 4096;

export interface CapabilitySessionEvidence {
  state: "evidence";
  /**
   * Increments on every provider load the bridge observed (Claude: each
   * query's `system/init`). Evidence is only as fresh as this generation.
   */
  generation: number;
  /** When the provider reported the load. */
  loadedAt: string;
  /** The provider's version string from that load, when it gave one. */
  providerVersion?: string;
  /** Plugins the load reported as loaded, with their directories. */
  plugins: Array<{ name: string; path?: string }>;
  /** Skill names the load listed (plugin skills are `plugin:skill`). */
  skills: string[];
  /**
   * The skills the load resolved with the file each one loads from, for a
   * provider that reports them (Pi). A path inside a content-addressed
   * directory binds the loaded bytes, as a plugin directory does.
   */
  loadedSkills?: Array<{ name: string; path: string }>;
  /** Some loaded skill rows could not fit the bridge or reader budget. */
  loadedSkillsIncomplete?: true;
  /** Skill names the agent invoked in this bridge process, oldest first. */
  usedSkills: string[];
}

export type CapabilitySessionEvidenceRead =
  | CapabilitySessionEvidence
  | { state: "missing" }
  | { state: "none" }
  | { state: "unsupported" }
  | { state: "not-running" };

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, MAX_CAPABILITY_EVIDENCE_ENTRIES)) {
    const name = text(entry, MAX_CAPABILITY_EVIDENCE_NAME);
    if (name) out.push(name);
  }
  return out;
}

/**
 * The evidence body as a reader may trust it: bounded, typed, and `none` for
 * anything malformed. A bridge with nothing loaded yet answers `none`.
 */
export function parseCapabilitySessionEvidence(body: unknown): CapabilitySessionEvidenceRead {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { state: "none" };
  const record = body as Record<string, unknown>;
  if (record.state === "missing") return { state: "missing" };
  if (record.state !== "evidence") return { state: "none" };
  const generation = record.generation;
  const loadedAt = text(record.loadedAt, 64);
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !loadedAt ||
    !Number.isFinite(Date.parse(loadedAt))
  ) {
    return { state: "none" };
  }
  const plugins: CapabilitySessionEvidence["plugins"] = [];
  if (Array.isArray(record.plugins)) {
    for (const candidate of record.plugins.slice(0, MAX_CAPABILITY_EVIDENCE_ENTRIES)) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;
      const name = text(row.name, MAX_CAPABILITY_EVIDENCE_NAME);
      if (!name) continue;
      const path = text(row.path, MAX_CAPABILITY_EVIDENCE_PATH);
      plugins.push({ name, ...(path ? { path } : {}) });
    }
  }
  const loadedSkills: NonNullable<CapabilitySessionEvidence["loadedSkills"]> = [];
  if (Array.isArray(record.loadedSkills)) {
    for (const candidate of record.loadedSkills.slice(0, MAX_CAPABILITY_EVIDENCE_ENTRIES)) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;
      const name = text(row.name, MAX_CAPABILITY_EVIDENCE_NAME);
      const path = text(row.path, MAX_CAPABILITY_EVIDENCE_PATH);
      if (name && path) loadedSkills.push({ name, path });
    }
  }
  const providerVersion = text(record.providerVersion, 128);
  return {
    state: "evidence",
    generation,
    loadedAt,
    ...(providerVersion ? { providerVersion } : {}),
    plugins,
    skills: names(record.skills),
    ...(Array.isArray(record.loadedSkills) ? { loadedSkills } : {}),
    ...(record.loadedSkillsIncomplete === true ||
    (Array.isArray(record.loadedSkills) && loadedSkills.length !== record.loadedSkills.length)
      ? { loadedSkillsIncomplete: true }
      : {}),
    usedSkills: names(record.usedSkills),
  };
}
