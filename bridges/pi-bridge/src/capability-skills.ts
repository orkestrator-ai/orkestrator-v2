/**
 * Agent Capabilities session-private skills for Pi
 * (docs/architecture/agent-capabilities-management.md, "Session-private
 * delivery"; 8314 task 2).
 *
 * The backend stages the skills a session's setups select for that session
 * alone into a content-addressed directory it owns (the same Orkestrator
 * session plugin a Claude session receives) and names it on each of that
 * session's prompts as `capabilityPlugins`. This bridge passes the
 * directory's `skills/` folder to Pi's resource loader as the session's own
 * `additionalSkillPaths`, which the pinned SDK keeps per session. Nothing is
 * written into the shared Pi home, so no other Pi session, provider or
 * account sees the skills.
 *
 * A prompt names paths, so they are accepted only from inside the root the
 * backend named at launch (`ORKESTRATOR_CAPABILITY_SESSION_PLUGINS_DIR`),
 * only as that root's own content-addressed children (no link, no nesting),
 * and only when each holds a `skills/` directory. A read-only turn or a
 * coordinator loads none: their boundary admits only the skills they already
 * read.
 *
 * Runtime proof comes from what the SDK itself loaded: each attach and resource reload records
 * the skills the session's resource loader resolved (names and `SKILL.md`
 * paths), served on the no-touch `GET /session/:id/capability-evidence`
 * route. The backend matches a path inside the content-addressed directory
 * it staged, which binds the loaded bytes rather than a name.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import {
  CAPABILITY_SESSION_PLUGINS_DIR_ENV,
  MAX_CAPABILITY_SESSION_PLUGINS,
} from "@orkestrator/protocol/capability-resources";
import {
  MAX_CAPABILITY_EVIDENCE_BYTES,
  MAX_CAPABILITY_EVIDENCE_ENTRIES,
  MAX_CAPABILITY_EVIDENCE_NAME,
  MAX_CAPABILITY_EVIDENCE_PATH,
  type CapabilitySessionEvidence,
} from "@orkestrator/protocol/capability-evidence";
import { createLogger } from "@orkestrator/protocol/logger";
import { loadSkills } from "./pi-sdk.js";
import type { SessionState } from "./state.js";

const log = createLogger("bridge.pi");

const DIGEST_NAME = /^[0-9a-f]{16,64}$/;

/** The prompt body's `capabilityPlugins`, bounded; anything else is dropped. */
export function parseCapabilityPlugins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 4096,
    )
    .slice(0, MAX_CAPABILITY_SESSION_PLUGINS);
}

/**
 * The skill directories a session's private plugins give Pi: each accepted
 * plugin's `skills/`. A path outside the backend's root, a link, or a plugin
 * without skills is refused and logged (content-free), never followed.
 */
export async function capabilitySessionSkillPaths(
  plugins: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (plugins.length === 0) return [];
  const root = env[CAPABILITY_SESSION_PLUGINS_DIR_ENV];
  if (!root || !isAbsolute(root)) {
    log.warn("capability-skills.refused", { reason: "no-root", count: plugins.length });
    return [];
  }
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) {
    log.warn("capability-skills.refused", { reason: "root-missing", count: plugins.length });
    return [];
  }
  const accepted: string[] = [];
  for (const plugin of plugins) {
    const skills = await acceptableSkills(plugin, realRoot);
    if (skills === "refused") {
      log.warn("capability-skills.refused", { reason: "outside-root", count: 1 });
      continue;
    }
    if (skills && !accepted.includes(skills)) accepted.push(skills);
  }
  return accepted;
}

/** The plugin's `skills/` directory, `null` when it has none, `refused` when not acceptable. */
async function acceptableSkills(
  path: string,
  realRoot: string,
): Promise<string | null | "refused"> {
  if (!isAbsolute(path) || !DIGEST_NAME.test(basename(path))) return "refused";
  try {
    if ((await realpath(dirname(path))) !== realRoot) return "refused";
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return "refused";
  } catch {
    return "refused";
  }
  const skills = join(realRoot, basename(path), "skills");
  try {
    const entry = await lstat(skills);
    if (entry.isSymbolicLink()) return "refused";
    return entry.isDirectory() ? skills : null;
  } catch {
    // A plugin carrying only commands or subagents has nothing for Pi.
    return null;
  }
}

/**
 * The private skill directories this session's resource loader takes now.
 * None on a read-only turn or for a coordinator, whose boundary admits only
 * the skills they already read.
 */
export function effectiveCapabilitySkillPaths(
  state: Pick<SessionState, "capabilitySkillPaths" | "readOnly" | "policy">,
): string[] {
  if (state.readOnly === true || state.policy?.id === "coordinator-read-only") return [];
  return state.capabilitySkillPaths ?? [];
}

/** True when the live session was built with another private skill set than it should hold. */
export function capabilitySkillsNeedRebuild(
  state: Pick<
    SessionState,
    "capabilitySkillPaths" | "capabilitySkillPathsLoaded" | "readOnly" | "policy"
  >,
): boolean {
  const wanted = effectiveCapabilitySkillPaths(state);
  const loaded = state.capabilitySkillPathsLoaded ?? [];
  return wanted.length !== loaded.length || wanted.some((path, index) => loaded[index] !== path);
}

/**
 * Pi keeps the first skill by name. Reuse its discovery rules for private
 * paths alone so the selected copy wins when merging the resolved lists.
 */
export function preferCapabilitySkills(
  skillPaths: string[],
  cwd: string,
  agentDir: string,
): (base: LoadSkillsResult) => LoadSkillsResult {
  return (base) => {
    const selected = loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false });
    const names = new Set(selected.skills.map((skill) => skill.name));
    return {
      skills: [...selected.skills, ...base.skills.filter((skill) => !names.has(skill.name))],
      diagnostics: base.diagnostics,
    };
  };
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

/**
 * Records the private skill set the resource loader uses and
 * the skills its resource loader actually resolved. Names and paths only.
 */
export function noteCapabilityLoad(
  state: SessionState,
  loadedWith: readonly string[],
  skills: ReadonlyArray<{ name?: unknown; filePath?: unknown }>,
  now: () => string = () => new Date().toISOString(),
): void {
  state.capabilitySkillPathsLoaded = [...loadedWith];
  const snapshot: NonNullable<SessionState["capabilityEvidence"]> = {
    generation: (state.capabilityEvidence?.generation ?? 0) + 1,
    loadedAt: now(),
    loadedSkills: [],
  };
  // Reserve space for response metadata, delimiters and the truncation flag.
  // Each row is encoded both as an object and as a name in the skills array.
  let remaining = MAX_CAPABILITY_EVIDENCE_BYTES - 1024;
  const add = (skill: (typeof skills)[number]) => {
    const name = text(skill.name, MAX_CAPABILITY_EVIDENCE_NAME);
    const path = text(skill.filePath, MAX_CAPABILITY_EVIDENCE_PATH);
    if (name && path && snapshot.loadedSkills.length < MAX_CAPABILITY_EVIDENCE_ENTRIES) {
      const row = { name, path };
      const bytes =
        Buffer.byteLength(JSON.stringify(row)) + Buffer.byteLength(JSON.stringify(name)) + 2;
      if (bytes <= remaining) {
        snapshot.loadedSkills.push(row);
        remaining -= bytes;
        return;
      }
    }
    snapshot.loadedSkillsIncomplete = true;
  };
  const privateRoots = new Set(loadedWith);
  const isPrivate = (skill: (typeof skills)[number]) =>
    typeof skill.filePath === "string" && privateRoots.has(dirname(dirname(skill.filePath)));
  for (const skill of skills) if (isPrivate(skill)) add(skill);
  for (const skill of skills) if (!isPrivate(skill)) add(skill);
  state.capabilityEvidence = snapshot;
}

/** The route's body: `missing` for an unknown session, `none` before the first load. */
export function capabilityEvidenceBody(
  state: Pick<SessionState, "capabilityEvidence"> | undefined,
): CapabilitySessionEvidence | { state: "missing" } | { state: "none" } {
  if (!state) return { state: "missing" };
  const evidence = state.capabilityEvidence;
  if (!evidence) return { state: "none" };
  return {
    state: "evidence",
    generation: evidence.generation,
    loadedAt: evidence.loadedAt,
    // Pi loads no plugins; the session's skills carry their own paths.
    plugins: [],
    skills: evidence.loadedSkills.map((skill) => skill.name),
    loadedSkills: evidence.loadedSkills.map((skill) => ({ ...skill })),
    ...(evidence.loadedSkillsIncomplete ? { loadedSkillsIncomplete: true } : {}),
    // Pi has no skill tool to observe; a skill is read like any file.
    usedSkills: [],
  };
}
