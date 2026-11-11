import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { captureWorktreePathIdentity } from "@orkestrator/protocol/node/worktree-paths";

import { AGENT_TEST_AGENT_TOOLS_PORT_RANGE } from "../../electron/runtime-profile.js";
import { assertAgentToolsPortFree, processMatches } from "./profile-io.js";

/**
 * Host-wide claims on agent-test agent tools ports (to-do 7500).
 *
 * A launcher checks its port long before its backend binds it: Electron and
 * the bridges compile in between, often for a minute. A bind check alone
 * therefore lets two launchers starting together both take the same port,
 * and the second backend then fails. Each launcher instead records a claim,
 * one file per port in the development root every profile on this host
 * shares, naming the profile and its launcher (PID and start time). A claim
 * holds while that launcher runs; once it exits the claim is stale and the
 * next launcher replaces it, so nothing has to release one.
 *
 * The bind check still runs after the claim, for whatever else listens on the
 * port. Two launchers that replace the same stale claim at the same instant
 * can still both proceed; the second backend's bind then fails the start, as
 * it did before claims existed. A launcher that gives a port up never leaves
 * its own claim on it.
 */

export type AgentToolsPortOwner = {
  /** The profile id the claim is for. */
  profile: string;
  /** The launcher's PID and start time: the claim lives as long as it does. */
  pid: number;
  startTime: number;
};

type Claim = AgentToolsPortOwner & { version: 1; port: number };

export type AgentToolsPortClaimOptions = {
  developmentRoot: string;
  owner: AgentToolsPortOwner;
  /** Whether a claim's launcher is still running; defaults to a PID and start-time match. */
  isLive?: (owner: AgentToolsPortOwner) => boolean;
  /** Throws when something already listens on the port; defaults to {@link assertAgentToolsPortFree}. */
  checkFree?: (port: number) => Promise<void>;
};

type ClaimOutcome =
  | { ok: true }
  | { ok: false; reason: "claimed"; by: string }
  | { ok: false; reason: "in-use"; error: unknown };

const CLAIM_BYTES_LIMIT = 4096;
const CLAIM_ATTEMPTS = 3;
/** How long a missing claim is re-read for before it counts as gone (about 100 ms). */
const SETTLE_READS = 20;
const SETTLE_INTERVAL_MS = 5;

export function agentToolsPortClaimsDir(developmentRoot: string): string {
  return path.join(developmentRoot, "agent-tools-port-claims");
}

/** The development root a profile lives in (`<root>/profiles/<id>`). */
export function developmentRootOfProfile(profileRoot: string): string {
  return path.dirname(path.dirname(profileRoot));
}

/**
 * Removes every claim naming `profile`, for `dev:reset`, which refuses a
 * running profile, so none of them is live. A stale claim is harmless (the
 * next launcher replaces it); removing it keeps a reset from leaving anything
 * of the profile behind. Returns how many were removed.
 */
export async function releaseAgentToolsPortClaims(
  developmentRoot: string,
  profile: string,
): Promise<number> {
  const directory = agentToolsPortClaimsDir(developmentRoot);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let released = 0;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    const existing = await readClaim(file);
    if (existing?.claim?.profile === profile && (await retire(file, existing.raw))) {
      released += 1;
    }
  }
  return released;
}

/**
 * Claims exactly `port` for `owner`: refused when another live profile holds
 * it or something listens on it. A restart of the same profile takes its own
 * claim back.
 */
export async function claimAgentToolsPort(
  options: AgentToolsPortClaimOptions & { port: number },
): Promise<number> {
  const outcome = await tryClaim(options, options.port);
  if (outcome.ok) return options.port;
  if (outcome.reason === "in-use") throw outcome.error;
  throw new Error(
    `--agent-tools-port ${options.port} is claimed by the running profile ${outcome.by}; choose another port in the range or pass --agent-tools-port auto`,
  );
}

/**
 * `--agent-tools-port auto`: the first port of
 * {@link AGENT_TEST_AGENT_TOOLS_PORT_RANGE} that no other live profile has
 * claimed and nothing listens on. `preferred` (the profile's recorded port)
 * is tried first when it is in the range, so a restart keeps its port when it
 * can. Refuses, naming every port's reason, when the range is exhausted: a
 * port outside it would not pass the host firewall rule the range exists for.
 */
export async function chooseAgentToolsPort(
  options: AgentToolsPortClaimOptions & {
    preferred?: number;
    range?: { first: number; last: number };
  },
): Promise<number> {
  const { first, last } = options.range ?? AGENT_TEST_AGENT_TOOLS_PORT_RANGE;
  const range = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  const preferred =
    options.preferred !== undefined && range.includes(options.preferred)
      ? options.preferred
      : undefined;
  const candidates =
    preferred === undefined ? range : [preferred, ...range.filter((port) => port !== preferred)];
  const reasons: string[] = [];
  for (const port of candidates) {
    const outcome = await tryClaim(options, port);
    if (outcome.ok) return port;
    reasons.push(
      outcome.reason === "claimed" ? `${port} claimed by ${outcome.by}` : `${port} in use`,
    );
  }
  throw new Error(
    `--agent-tools-port auto found no free port in ${first}-${last} (${reasons.join(", ")}); stop a profile or pass an exact --agent-tools-port`,
  );
}

async function tryClaim(options: AgentToolsPortClaimOptions, port: number): Promise<ClaimOutcome> {
  const isLive =
    options.isLive ?? ((owner: AgentToolsPortOwner) => processMatches(owner.pid, owner.startTime));
  const checkFree = options.checkFree ?? assertAgentToolsPortFree;
  const directory = agentToolsPortClaimsDir(options.developmentRoot);
  const recheckDirectory = captureWorktreePathIdentity(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  recheckDirectory();
  const file = path.join(directory, `${port}.json`);
  const claim: Claim = { version: 1, port, ...options.owner };
  const contents = `${JSON.stringify(claim)}\n`;

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const existing = await readClaim(file);
    if (existing) {
      const holder = existing.claim;
      if (holder && holder.profile !== options.owner.profile && isLive(holder)) {
        return { ok: false, reason: "claimed", by: holder.profile };
      }
      // Stale, unreadable, or this profile's own earlier claim.
      if (!(await retire(file, existing.raw))) continue;
    }
    const temporary = path.join(directory, `.${port}.${randomUUID()}.tmp`);
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    try {
      // `link` publishes the complete file or fails with EEXIST, unlike a
      // rename, which would silently replace a claim another launcher just
      // made.
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    try {
      await checkFree(port);
    } catch (error) {
      await releaseIfOwned(file, contents);
      return { ok: false, reason: "in-use", error };
    }
    // A launcher replacing the same stale claim at the same moment may have
    // replaced this one; whoever's claim is on disk now keeps the port.
    const after = await settledClaim(file);
    // Nothing on disk: another launcher's retire moved this claim aside, saw
    // it was not the stale one and has not put it back, or never will. Giving
    // up here would leave the claim to be restored later, holding a port this
    // launcher no longer uses, so publish it again instead.
    if (after === null) continue;
    if (after.raw !== contents) {
      return { ok: false, reason: "claimed", by: after.claim?.profile ?? "another launcher" };
    }
    return { ok: true };
  }
  // Out of attempts: whatever this launcher left published must not outlive
  // the decision to give the port up.
  await releaseIfOwned(file, contents);
  return { ok: false, reason: "claimed", by: "another launcher" };
}

/**
 * Reads a claim, waiting briefly when the file is missing: a concurrent
 * {@link retire} moves a claim aside before deciding whether to put it back,
 * so a missing file is often a claim in flight rather than none at all.
 * `null` once the file has stayed missing for the whole wait.
 */
async function settledClaim(file: string): Promise<{ raw: string; claim: Claim | null } | null> {
  for (let wait = 0; ; wait += 1) {
    const current = await readClaim(file);
    if (current || wait >= SETTLE_READS) return current;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
  }
}

async function readClaim(file: string): Promise<{ raw: string; claim: Claim | null } | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { raw, claim: raw.length > CLAIM_BYTES_LIMIT ? null : parseClaim(raw) };
}

function parseClaim(raw: string): Claim | null {
  try {
    const value = JSON.parse(raw) as Partial<Claim> | null;
    if (
      value &&
      value.version === 1 &&
      typeof value.profile === "string" &&
      Number.isSafeInteger(value.pid) &&
      typeof value.startTime === "number" &&
      Number.isSafeInteger(value.port)
    ) {
      return value as Claim;
    }
  } catch {
    // An unreadable claim protects nothing; it is replaced like a stale one.
  }
  return null;
}

/**
 * Moves a stale claim out of the way, only if it is still the one that was
 * read. Renaming is atomic, so of two launchers retiring the same claim only
 * one moves it; a claim that changed in between is put back.
 */
async function retire(file: string, expected: string): Promise<boolean> {
  const retired = `${file}.${randomUUID()}.retired`;
  try {
    await rename(file, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const moved = await readFile(retired, "utf8");
    if (moved === expected) return true;
    await link(retired, file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return false;
  } finally {
    await rm(retired, { force: true });
  }
}

async function releaseIfOwned(file: string, contents: string): Promise<void> {
  const current = await readClaim(file);
  if (current?.raw === contents) await retire(file, contents);
}
