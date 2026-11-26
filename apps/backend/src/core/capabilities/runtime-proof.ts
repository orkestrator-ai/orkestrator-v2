/**
 * Runtime proof (docs/architecture/agent-capabilities-management.md,
 * "Runtime proof"): turns what a provider itself reported into verification
 * levels, never what Orkestrator sent.
 *
 * - **Claude session evidence** (`/session/:id/capability-evidence`): a
 *   session-private plugin is `load-confirmed` when the session's latest
 *   query reported loading the plugin from the content-addressed directory
 *   its launch record names (the directory name is a digest of the exact
 *   revisions, so the bytes are bound, and the generation is the query's).
 *   One of its skills the agent invoked is `observed-in-use`. A shared copy
 *   the query lists by name is `advertised` at most: a name cannot prove
 *   which bytes loaded.
 * - **Pi session evidence** (the same route): the bridge reports each skill
 *   the session's resource loader resolved with its `SKILL.md` path. A
 *   session-private skill is `load-confirmed` when that path is inside the
 *   content-addressed directory its launch record names. Pi keeps the first
 *   skill of a name, so a shared skill of the same name shadows the private
 *   one; its path then names the shared copy and the private skill is not
 *   confirmed. Pi has no skill tool, so nothing is `observed-in-use`.
 * - **Grok discovery** (`grok inspect --json`): the pinned binary's own
 *   listing names the `SKILL.md` it would load. A listed path inside the
 *   receipt's installed directory, whose bytes the inventory just matched, is
 *   `advertised` for the next session; Grok has no live per-session report.
 *
 * Every other provider keeps the receipt's level: present files are
 * "installed; not runtime-verified" until such evidence exists.
 */
import path from "node:path";

import type { CapabilitySessionEvidence } from "@orkestrator/protocol/capability-evidence";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  verificationRank,
  type CapabilityVerificationLevel,
} from "@orkestrator/protocol/capability-resources";
import { capabilityLocation } from "@orkestrator/protocol/capability-resources-support";

import { installName, locationDirectory, type CapabilityHomes } from "./native-ownership.js";
import type { ProviderCli } from "./provider-adapters/provider-cli.js";
import { SESSION_PLUGIN_NAME } from "./session-delivery.js";
import type {
  CapabilityLaunchRecord,
  CapabilityState,
  InstallationReceipt,
  RuntimeObservation,
} from "./types.js";

export interface RuntimeProof {
  componentId: string;
  level: CapabilityVerificationLevel;
  status: "ready" | "failed" | "installed-next-session";
  detail: string;
  source: RuntimeObservation["source"];
  generation?: string;
  receiptId?: string;
}

/** The installed skill name a Claude query lists for a session-private skill. */
export function sessionPluginSkillName(item: { name?: string; pathOrKey?: string }): string {
  return `${SESSION_PLUGIN_NAME}:${installName(item.name ?? "", item.pathOrKey ?? "", "directory")}`;
}

/** True when the evidence's loaded plugin rows include the launch's private plugin directory. */
export function loadedPrivatePlugin(evidence: CapabilitySessionEvidence, digest: string): boolean {
  return evidence.plugins.some((plugin) => {
    if (plugin.name !== SESSION_PLUGIN_NAME || !plugin.path) return false;
    const normalised = plugin.path.replaceAll("\\", "/").replace(/\/+$/, "");
    return path.posix.basename(normalised) === digest;
  });
}

/**
 * True when the evidence lists `item`'s skill loaded from the launch's private
 * directory: `<digest>/skills/<install name>/SKILL.md` (Pi's report).
 */
export function loadedPrivateSkill(
  evidence: CapabilitySessionEvidence,
  digest: string,
  item: { kind?: string; name?: string; pathOrKey?: string },
): boolean {
  if (item.kind !== "skill") return false;
  const directory = installName(item.name ?? "", item.pathOrKey ?? "", "directory");
  return (evidence.loadedSkills ?? []).some((skill) => {
    const segments = skill.path.replaceAll("\\", "/").split("/").filter(Boolean);
    const [owner, skills, name, file] = segments.slice(-4);
    return owner === digest && skills === "skills" && name === directory && file === "SKILL.md";
  });
}

/**
 * Grades a Claude or Pi session's own report for the components asked about.
 * Components the launch did not deliver privately are graded only by name
 * (`advertised`), and only when their installed name is listed.
 */
export function gradeSessionEvidence(input: {
  launch: CapabilityLaunchRecord | undefined;
  evidence: CapabilitySessionEvidence;
  componentIds: readonly string[];
  state: Pick<CapabilityState, "components">;
  provider?: AgentPlatform;
}): Map<string, RuntimeProof> {
  const proofs = new Map<string, RuntimeProof>();
  const { evidence } = input;
  const provider = input.provider ?? "claude";
  const generation = `${provider}:${evidence.generation}:${evidence.loadedAt}`;
  const privateRecord = input.launch?.privatePlugin;
  // Pi reports each loaded skill's file; Claude reports the plugin directory.
  const perSkill = evidence.loadedSkills !== undefined;
  const pluginLoaded =
    privateRecord && !perSkill ? loadedPrivatePlugin(evidence, privateRecord.digest) : false;
  const used = new Set(evidence.usedSkills);
  const listed = new Set(evidence.skills);
  for (const componentId of input.componentIds) {
    const item = privateRecord?.items.find((entry) => entry.componentId === componentId);
    if (item && privateRecord) {
      const loaded = perSkill
        ? loadedPrivateSkill(evidence, privateRecord.digest, item)
        : pluginLoaded;
      if (!loaded) {
        proofs.set(componentId, {
          componentId,
          level: "present",
          status: "failed",
          detail: perSkill
            ? "The session's latest load did not report this skill from its own directory (a shared skill of the same name may have taken its place), so it is not confirmed loaded."
            : "The session's latest load did not report its own plugin directory, so this component is not confirmed loaded.",
          source: "bridge-inventory",
          generation,
        });
        continue;
      }
      const skillName = item.kind === "skill" ? sessionPluginSkillName(item) : undefined;
      if (skillName && used.has(skillName)) {
        proofs.set(componentId, {
          componentId,
          level: "observed-in-use",
          status: "ready",
          detail: `The agent invoked ${skillName}, loaded from this session's own plugin (generation ${evidence.generation}).`,
          source: "session-use",
          generation,
        });
        continue;
      }
      proofs.set(componentId, {
        componentId,
        level: "load-confirmed",
        status: "ready",
        detail: perSkill
          ? `Loaded from this session's own skill directory ${privateRecord.digest.slice(0, 12)} (generation ${evidence.generation}).`
          : `Loaded from this session's own plugin directory ${privateRecord.digest.slice(0, 12)} (generation ${evidence.generation}).`,
        source: "bridge-inventory",
        generation,
      });
      continue;
    }
    const component = input.state.components[componentId];
    if (!component || component.kind !== "skill") continue;
    const name = installName(component.name, component.pathOrKey, "directory");
    if (!listed.has(name) && !used.has(name)) continue;
    proofs.set(componentId, {
      componentId,
      level: "advertised",
      status: "ready",
      detail: used.has(name)
        ? `The session listed and invoked a skill named ${name}. A shared copy is identified by name only, so the loaded revision is not confirmed.`
        : `The session lists a skill named ${name}. A shared copy is identified by name only, so the loaded revision is not confirmed.`,
      source: used.has(name) ? "session-use" : "bridge-inventory",
      generation,
    });
  }
  return proofs;
}

/** Skills the pinned Grok binary discovers, from `grok inspect --json`; null when it cannot say. */
export async function grokDiscoveredSkills(
  cli: ProviderCli,
): Promise<Array<{ name: string; path: string }> | null> {
  const result = await cli(["inspect", "--json"]);
  if (result.exitCode !== 0 || result.timedOut) return null;
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const skills = (body as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return null;
  return skills.slice(0, 2_000).flatMap((entry) => {
    const row = entry as { name?: unknown; source?: { path?: unknown } } | null;
    return typeof row?.name === "string" && typeof row.source?.path === "string"
      ? [{ name: row.name, path: row.source.path }]
      : [];
  });
}

/**
 * Grades receipts against Grok's own listing: a skill whose listed
 * `SKILL.md` is inside the receipt's installed directory is advertised.
 * Receipts whose bytes did not match the inventory are left alone.
 */
export function gradeGrokDiscovery(input: {
  receipts: readonly InstallationReceipt[];
  matching: ReadonlySet<string>;
  discovered: ReadonlyArray<{ name: string; path: string }>;
  homes: CapabilityHomes;
  state: Pick<CapabilityState, "components">;
  version?: string;
}): Map<string, RuntimeProof> {
  const proofs = new Map<string, RuntimeProof>();
  const listed = input.discovered.map((entry) => path.resolve(entry.path));
  for (const receipt of input.receipts) {
    if (!input.matching.has(receipt.id)) continue;
    const location = capabilityLocation(receipt.locationId);
    const component = input.state.components[receipt.componentId];
    if (!location || location.layout !== "directory" || component?.kind !== "skill") continue;
    if (!readsLocation("grok", location.readBy)) continue;
    let installed: string;
    try {
      installed = path.resolve(
        locationDirectory(receipt.locationId, input.homes),
        installName(component.name, component.pathOrKey, "directory"),
      );
    } catch {
      continue;
    }
    if (!listed.some((entry) => entry === path.join(installed, "SKILL.md"))) continue;
    proofs.set(receipt.componentId, {
      componentId: receipt.componentId,
      level: "advertised",
      status: "installed-next-session",
      receiptId: receipt.id,
      detail: `Grok${input.version ? ` ${input.version}` : ""} lists this skill from its installed directory; it loads in the next Grok session.`,
      source: "provider-config",
    });
  }
  return proofs;
}

function readsLocation(provider: AgentPlatform, readBy: readonly AgentPlatform[]): boolean {
  return readBy.includes(provider);
}

/** The higher of two levels. */
export function strongerLevel(
  a: CapabilityVerificationLevel | "unverified" | string,
  b: CapabilityVerificationLevel,
): CapabilityVerificationLevel {
  const known = (level: string): level is CapabilityVerificationLevel =>
    verificationRank(level as CapabilityVerificationLevel) >= 0;
  if (!known(a)) return b;
  return verificationRank(a) >= verificationRank(b) ? a : b;
}
