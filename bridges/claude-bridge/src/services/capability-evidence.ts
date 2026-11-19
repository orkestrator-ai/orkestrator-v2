/**
 * Agent Capabilities runtime evidence for one session
 * (docs/architecture/agent-capabilities-management.md, "Runtime proof").
 *
 * Recorded from what the CLI itself reports, never from what was sent: each
 * query's `system/init` names the plugins it loaded (with their directories)
 * and the skills it lists, and a `Skill` tool call names a skill the agent
 * actually invoked. The backend matches a loaded plugin directory against the
 * content-addressed directory it staged, which is what makes a load
 * artifact-bound rather than a name match.
 *
 * Served on the no-touch `GET /session/:id/capability-evidence` route. Only
 * names and directories are kept, each bounded; never a skill's arguments.
 */
import {
  MAX_CAPABILITY_EVIDENCE_ENTRIES,
  MAX_CAPABILITY_EVIDENCE_NAME,
  MAX_CAPABILITY_EVIDENCE_PATH,
  type CapabilitySessionEvidence,
} from "@orkestrator/protocol/capability-evidence";

/** What the bridge keeps per session. */
export interface CapabilityEvidenceState {
  generation: number;
  loadedAt: string;
  providerVersion?: string;
  plugins: Array<{ name: string; path?: string }>;
  skills: string[];
  usedSkills: string[];
}

interface EvidenceHolder {
  capabilityEvidence?: CapabilityEvidenceState;
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

/** A query loaded: replaces the loaded plugins and skills, keeps what was used. */
export function noteCapabilityInit(
  session: EvidenceHolder,
  init: { plugins?: unknown; skills?: unknown; claude_code_version?: unknown },
  now: () => string = () => new Date().toISOString(),
): void {
  const plugins: CapabilityEvidenceState["plugins"] = [];
  if (Array.isArray(init.plugins)) {
    for (const candidate of init.plugins.slice(0, MAX_CAPABILITY_EVIDENCE_ENTRIES)) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;
      const name = text(row.name, MAX_CAPABILITY_EVIDENCE_NAME);
      if (!name) continue;
      const path = text(row.path, MAX_CAPABILITY_EVIDENCE_PATH);
      plugins.push({ name, ...(path ? { path } : {}) });
    }
  }
  const skills = Array.isArray(init.skills)
    ? init.skills.slice(0, MAX_CAPABILITY_EVIDENCE_ENTRIES).flatMap((entry) => {
        const name = text(entry, MAX_CAPABILITY_EVIDENCE_NAME);
        return name ? [name] : [];
      })
    : [];
  const version = text(init.claude_code_version, 128);
  const previous = session.capabilityEvidence;
  session.capabilityEvidence = {
    generation: (previous?.generation ?? 0) + 1,
    loadedAt: now(),
    ...(version ? { providerVersion: version } : {}),
    plugins,
    skills,
    usedSkills: previous?.usedSkills ?? [],
  };
}

/** The skill a `Skill` tool call invokes, from its input; undefined for any other call. */
export function invokedSkill(toolName: string, input: unknown): string | undefined {
  if (toolName !== "Skill" || !input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const name =
    text(record.skill, MAX_CAPABILITY_EVIDENCE_NAME) ??
    text(record.command, MAX_CAPABILITY_EVIDENCE_NAME);
  return name?.replace(/^\//, "");
}

/** The agent invoked a skill. Kept once per name, newest last, bounded. */
export function noteCapabilityUse(session: EvidenceHolder, skill: string): void {
  const evidence = session.capabilityEvidence;
  if (!evidence) return;
  const used = evidence.usedSkills.filter((entry) => entry !== skill);
  used.push(skill);
  evidence.usedSkills = used.slice(-MAX_CAPABILITY_EVIDENCE_ENTRIES);
}

/** The route's body: `missing` for an unknown session, `none` before the first load. */
export function capabilityEvidenceBody(
  session: EvidenceHolder | undefined,
): CapabilitySessionEvidence | { state: "missing" } | { state: "none" } {
  if (!session) return { state: "missing" };
  const evidence = session.capabilityEvidence;
  if (!evidence) return { state: "none" };
  return {
    state: "evidence",
    generation: evidence.generation,
    loadedAt: evidence.loadedAt,
    ...(evidence.providerVersion ? { providerVersion: evidence.providerVersion } : {}),
    plugins: evidence.plugins.map((plugin) => ({ ...plugin })),
    skills: [...evidence.skills],
    usedSkills: [...evidence.usedSkills],
  };
}
