/**
 * Command-node handover of capability authority
 * (docs/architecture/agent-capabilities-management.md, "Authority").
 *
 * `NodeService.completeHandover` calls {@link sendCapabilityHandover} before
 * it asks the target to accept command. The handing-over node:
 *
 * 1. marks its state `sending`, which stops it acting as the authority (its
 *    reconciler stops, its mutations refuse), and waits for passes in flight;
 * 2. sends every artifact its state references through the chunked transfer
 *    bundle (`stage_capability_node_handover`, part `artifact`; the receiver
 *    verifies each against its digest before storing it);
 * 3. sends the state itself (part `state`) as one canonical JSON bundle in
 *    bounded chunks, verified against its sha256 digest on arrival.
 *
 * `NodeService.acceptHandover` on the target calls
 * {@link CapabilityHandoverReceiver.install} after it has adopted the
 * machines: the staged bundle becomes the target's state with epoch
 * `max(seen) + 1` and the target as controller, and its own executor moves
 * to that epoch. Once accepted, the old node records `sent` and moves its
 * executor to the new epoch too, so nothing (it included) takes its plans.
 *
 * Every step is idempotent per handover id, so the handover journal's retry
 * (`pendingHandover`) resumes a partial transfer or a lost answer: staged
 * chunks and artifacts are content-addressed, and an install already done
 * answers as done.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  CAPABILITY_LIMITS,
  isTerminalCapabilityOperationState,
} from "@orkestrator/protocol/capability-resources";
import { stageCapabilityNodeHandoverCommand } from "@orkestrator/protocol/contract/domains/capabilities";
import { isIncompatibilityError } from "@orkestrator/protocol/contract/errors";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { newCorrelationId, recordActivity } from "./operations.js";
import { CapabilityError } from "./security.js";
import { CAPABILITY_COLLECTIONS, type CapabilitySettings, type CapabilityState } from "./types.js";

const HANDOVER_ID = /^[a-zA-Z0-9-]{1,64}$/;
const STATE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUNDLE_FORMAT = 1;
/** The state bundle's bound; the collections it carries are bounded far below this. */
export const MAX_HANDOVER_STATE_BYTES = 128 * 1024 * 1024;
/** Staged handover chunks nobody installed are swept after this. */
const STAGED_TTL_MS = 24 * 60 * 60_000;

/** Short-lived previews stay behind: the new authority makes its own. */
const TRANSFERRED_COLLECTIONS = CAPABILITY_COLLECTIONS.filter(
  (collection) => collection !== "inspections" && collection !== "imports",
);

type Collection = (typeof CAPABILITY_COLLECTIONS)[number];

export interface CapabilityHandoverBundle {
  formatVersion: typeof BUNDLE_FORMAT;
  handoverId: string;
  fromControllerId: string;
  epoch: number;
  revision: number;
  settings: CapabilitySettings;
  collections: Partial<Record<Collection, Record<string, unknown>>>;
  /** Artifacts sent ahead of the state; the receiver must hold each before installing. */
  artifactDigests: string[];
}

/** Runs one command on the target over the handover's transport. */
export type HandoverInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function assertHandoverId(value: unknown): string {
  if (typeof value !== "string" || !HANDOVER_ID.test(value))
    throw new CapabilityError("invalid-request", "Invalid handover ID.");
  return value;
}

/** Every artifact digest the state references: package revisions and recorded artifacts. */
export function referencedArtifactDigests(state: CapabilityState): string[] {
  const digests = new Set<string>(Object.keys(state.artifacts));
  for (const pkg of Object.values(state.packages)) {
    if (pkg.artifactDigest) digests.add(pkg.artifactDigest);
    for (const revision of pkg.previousRevisions ?? []) digests.add(revision.artifactDigest);
  }
  return [...digests].filter((digest) => /^sha256:[0-9a-f]{64}$/.test(digest)).sort();
}

/** Nothing worth carrying: no package, receipt or operation in flight. */
function isTrivialState(state: CapabilityState): boolean {
  return (
    Object.keys(state.packages).length === 0 &&
    Object.keys(state.receipts).length === 0 &&
    Object.values(state.operations).every((operation) =>
      isTerminalCapabilityOperationState(operation.state),
    )
  );
}

export function buildHandoverBundle(
  state: CapabilityState,
  input: { handoverId: string; fromControllerId: string; artifactDigests: string[] },
): { text: string; digest: string } {
  const collections: CapabilityHandoverBundle["collections"] = {};
  for (const collection of TRANSFERRED_COLLECTIONS) {
    collections[collection] = state[collection] as Record<string, unknown>;
  }
  const bundle: CapabilityHandoverBundle = {
    formatVersion: BUNDLE_FORMAT,
    handoverId: input.handoverId,
    fromControllerId: input.fromControllerId,
    epoch: state.epoch,
    revision: state.revision,
    settings: state.settings,
    collections,
    artifactDigests: input.artifactDigests,
  };
  const text = JSON.stringify(bundle).replace(
    /[\u0080-\uFFFF]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (text.length > MAX_HANDOVER_STATE_BYTES)
    throw new CapabilityError("too-large", "The capability state is too large to hand over.");
  return { text, digest: sha256Text(text) };
}

function chunkText(text: string): string[] {
  const size = CAPABILITY_LIMITS.artifactChunkBytes;
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size)
    chunks.push(text.slice(offset, offset + size));
  return chunks.length > 0 ? chunks : [""];
}

export interface HandoverSenderDeps {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  selfId(): Promise<string>;
  /** Waits for reconcile passes in flight once this node stopped being the authority. */
  quiesce(): Promise<void>;
  /** The marker changed: re-read whether this node is the authority. */
  authorityChanged(): void;
  now(): string;
}

type StageAnswer = { complete?: unknown; installed?: unknown };

/**
 * The handing-over side: stop acting as the authority, then send the
 * artifacts and the state to `targetId`. Throws when the target cannot take
 * the state; the caller abandons or retries the handover.
 */
export async function sendCapabilityHandover(
  deps: HandoverSenderDeps,
  input: { handoverId: string; targetId: string; invoke: HandoverInvoke },
): Promise<{ sent: boolean; artifacts: number }> {
  const handoverId = assertHandoverId(input.handoverId);
  const controllerId = await deps.selfId();
  deps.storage.capabilities.mutateCapabilityState((state) => {
    const marker = state.handover;
    if (marker?.role === "sent" && marker.id !== handoverId) {
      throw new CapabilityError(
        "conflict",
        "This machine already handed capability management to another command node.",
      );
    }
    // A retried handover (the journal's recovery) keeps its marker.
    if (marker?.id === handoverId && (marker.role === "sending" || marker.role === "sent"))
      return { result: undefined, changed: false };
    state.handover = {
      id: handoverId,
      role: "sending",
      peerId: input.targetId,
      epoch: state.epoch,
      at: deps.now(),
    };
    return { result: undefined, changed: true };
  });
  deps.authorityChanged();
  await deps.quiesce();

  const state = await deps.storage.capabilities.loadCapabilityState();
  const epoch = state.epoch;
  const present: string[] = [];
  for (const digest of referencedArtifactDigests(state)) {
    if (await deps.artifacts.has(digest)) present.push(digest);
  }
  const bundle = buildHandoverBundle(state, {
    handoverId,
    fromControllerId: controllerId,
    artifactDigests: present,
  });
  const call = async (args: Record<string, unknown>): Promise<StageAnswer> => {
    const full = { controllerId, epoch, handoverId, ...args };
    try {
      return ((await input.invoke(stageCapabilityNodeHandoverCommand.name, full)) ??
        {}) as StageAnswer;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "outcome-unknown") throw error;
      // A lost answer: every stage is idempotent, so ask once more.
      return ((await input.invoke(stageCapabilityNodeHandoverCommand.name, full)) ??
        {}) as StageAnswer;
    }
  };

  let sentArtifacts = 0;
  try {
    for (const digest of present) {
      const chunks = CapabilityArtifactStore.bundleChunks(await deps.artifacts.get(digest));
      for (let index = 0; index < chunks.length; index += 1) {
        const answer = await call({
          part: "artifact",
          digest,
          index,
          count: chunks.length,
          data: chunks[index]!,
        });
        if (answer.installed === true) return { sent: true, artifacts: sentArtifacts };
        if (answer.complete === true) break;
      }
      sentArtifacts += 1;
    }
    const chunks = chunkText(bundle.text);
    for (let index = 0; index < chunks.length; index += 1) {
      const answer = await call({
        part: "state",
        digest: bundle.digest,
        index,
        count: chunks.length,
        data: chunks[index]!,
      });
      if (answer.installed === true) return { sent: true, artifacts: sentArtifacts };
      if (index === chunks.length - 1 && answer.complete !== true) {
        throw new CapabilityError(
          "source-unavailable",
          "The new command node did not confirm the capability state.",
        );
      }
    }
  } catch (error) {
    if (isIncompatibilityError(error)) {
      // A target from before capability management has nothing to follow.
      if (isTrivialState(state)) return { sent: false, artifacts: 0 };
      throw new CapabilityError(
        "unsupported",
        "The new command node's Orkestrator cannot take over capability management. Update it, then hand over again.",
      );
    }
    throw error;
  }
  return { sent: true, artifacts: sentArtifacts };
}

/**
 * The new command node accepted: this node keeps its copy for reference but
 * is no longer the authority, and its own executor refuses the old epoch.
 */
export function completeCapabilityHandover(
  deps: Pick<HandoverSenderDeps, "storage" | "authorityChanged" | "now">,
  input: { handoverId: string; targetId: string; sent: boolean },
): void {
  const moved = deps.storage.capabilities.mutateCapabilityState((state) => {
    if (state.handover?.id !== input.handoverId) return { result: null, changed: false };
    if (!input.sent) {
      // Nothing travelled (a target without capability management).
      delete state.handover;
      return { result: null, changed: true };
    }
    const epoch = state.handover.role === "sent" ? state.handover.epoch : state.epoch + 1;
    state.handover = {
      id: input.handoverId,
      role: "sent",
      peerId: input.targetId,
      epoch,
      at: deps.now(),
    };
    recordActivity(state, {
      action: "handover-sent",
      summary: "Capability management moved to the new command node.",
      packageIds: [],
      setupIds: [],
      correlationId: newCorrelationId(),
    });
    return { result: epoch, changed: true };
  });
  if (moved !== null) {
    deps.storage.capabilities.mutateCapabilityExecutorState((executor) => {
      if (executor.epoch < moved) {
        executor.epoch = moved;
        executor.controllerId = input.targetId;
      }
    });
  }
  deps.authorityChanged();
}

/** The handover was refused before the target adopted anything: this node stays the authority. */
export function abandonCapabilityHandover(
  deps: Pick<HandoverSenderDeps, "storage" | "authorityChanged">,
  handoverId: string,
): void {
  deps.storage.capabilities.mutateCapabilityState((state) => {
    if (state.handover?.id !== handoverId || state.handover.role !== "sending")
      return { result: undefined, changed: false };
    delete state.handover;
    return { result: undefined, changed: true };
  });
  deps.authorityChanged();
}

/** True while this node's state says another node holds (or is taking) the authority. */
export function handedOverAuthority(state: CapabilityState): boolean {
  return state.handover?.role === "sending" || state.handover?.role === "sent";
}

export interface HandoverReceiverDeps {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  dataDir: string;
  selfId(): Promise<string>;
  /** The executor's single-writer check: only this node's current authority may stage. */
  admitEpoch(controllerId: string, epoch: number): void;
  now(): string;
}

/** The receiving side: stages the bundle, then installs it when command is accepted. */
export class CapabilityHandoverReceiver {
  private readonly root: string;

  constructor(private readonly deps: HandoverReceiverDeps) {
    this.root = path.join(deps.dataDir, "capability-handover");
  }

  private async installed(handoverId: string): Promise<boolean> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    return state.handover?.role === "received" && state.handover.id === handoverId;
  }

  /** One chunk of an artifact or of the state, from this node's current command node. */
  async stage(
    args: Record<string, unknown>,
  ): Promise<{ complete: boolean; missing: number[]; installed?: true }> {
    const handoverId = assertHandoverId(args.handoverId);
    if (await this.installed(handoverId)) return { complete: true, missing: [], installed: true };
    const controllerId = typeof args.controllerId === "string" ? args.controllerId : "";
    if (!controllerId) throw new CapabilityError("invalid-request", "controllerId is required.");
    this.deps.admitEpoch(controllerId, Number(args.epoch));
    const digest = typeof args.digest === "string" ? args.digest : "";
    const data = typeof args.data === "string" ? args.data : "";
    const index = Number(args.index);
    const count = Number(args.count);
    if (args.part === "artifact") {
      return this.deps.artifacts.stageChunk(digest, index, count, data);
    }
    if (args.part !== "state")
      throw new CapabilityError("invalid-request", "Unknown handover part.");
    return this.stageState(handoverId, controllerId, digest, index, count, data);
  }

  private async stageState(
    handoverId: string,
    controllerId: string,
    digest: string,
    index: number,
    count: number,
    data: string,
  ): Promise<{ complete: boolean; missing: number[] }> {
    const maxChunks = Math.ceil(MAX_HANDOVER_STATE_BYTES / CAPABILITY_LIMITS.artifactChunkBytes);
    if (!STATE_DIGEST.test(digest))
      throw new CapabilityError("invalid-request", "Not a state digest.");
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > maxChunks ||
      index < 0 ||
      index >= count
    ) {
      throw new CapabilityError("invalid-request", "Chunk numbers are out of range.");
    }
    if (data.length > CAPABILITY_LIMITS.artifactChunkBytes)
      throw new CapabilityError("too-large", "A chunk is larger than the transfer limit.");
    await this.sweep(handoverId);
    const staged = this.bundleFile(handoverId);
    const existing = await this.readStaged(handoverId).catch(() => null);
    if (existing && existing.digest === digest) return { complete: true, missing: [] };
    const directory = path.join(this.root, handoverId, digest.slice("sha256:".length));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${index}-of-${count}`), data, "utf8");
    const present = new Set(
      (await fs.readdir(directory))
        .map((name) => /^(\d+)-of-(\d+)$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null && Number(match[2]) === count)
        .map((match) => Number(match[1])),
    );
    const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !present.has(i));
    if (missing.length > 0) return { complete: false, missing };
    let text = "";
    for (let i = 0; i < count; i += 1)
      text += await fs.readFile(path.join(directory, `${i}-of-${count}`), "utf8");
    await fs.rm(directory, { recursive: true, force: true });
    if (sha256Text(text) !== digest) {
      throw new CapabilityError(
        "unsafe-content",
        "The received capability state does not match the digest the command node named.",
      );
    }
    const bundle = parseBundle(text);
    if (bundle.handoverId !== handoverId || bundle.fromControllerId !== controllerId) {
      throw new CapabilityError("unsafe-content", "The capability state is for another handover.");
    }
    const temporary = `${staged}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, text, "utf8");
    await fs.rename(temporary, staged);
    await fs.writeFile(`${staged}.sha256`, digest, "utf8");
    return { complete: true, missing: [] };
  }

  private bundleFile(handoverId: string): string {
    return path.join(this.root, `${handoverId}.json`);
  }

  private async readStaged(
    handoverId: string,
  ): Promise<{ digest: string; bundle: CapabilityHandoverBundle } | null> {
    const file = this.bundleFile(handoverId);
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === null) return null;
    const recorded = await fs.readFile(`${file}.sha256`, "utf8").catch(() => null);
    const digest = sha256Text(text);
    // A torn write or tampering: drop it and let the retried handover send it again.
    if (recorded !== digest) {
      await fs.rm(file, { force: true });
      await fs.rm(`${file}.sha256`, { force: true });
      return null;
    }
    return { digest, bundle: parseBundle(text) };
  }

  /** Removes what a handover that never completed left staged. */
  private async sweep(current: string): Promise<void> {
    const entries = await fs.readdir(this.root).catch(() => [] as string[]);
    const cutoff = Date.now() - STAGED_TTL_MS;
    for (const name of entries) {
      if (name.startsWith(current)) continue;
      const entry = path.join(this.root, name);
      const stat = await fs.stat(entry).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.rm(entry, { recursive: true, force: true });
    }
  }

  /**
   * Makes the staged state this node's authority. Idempotent: a handover
   * already installed answers with its epoch. Without a staged bundle (an
   * older command node sent none) nothing changes.
   */
  async install(input: {
    controllerId: string;
    handoverId: string;
  }): Promise<{ installed: boolean; epoch?: number }> {
    const handoverId = assertHandoverId(input.handoverId);
    const selfId = await this.deps.selfId();
    const current = await this.deps.storage.capabilities.loadCapabilityState();
    if (current.handover?.role === "received" && current.handover.id === handoverId) {
      this.raiseExecutor(current.epoch, selfId);
      return { installed: true, epoch: current.epoch };
    }
    const staged = await this.readStaged(handoverId);
    if (!staged) return { installed: false };
    const { bundle } = staged;
    if (bundle.fromControllerId !== input.controllerId)
      throw new CapabilityError("conflict", "The capability state is from another command node.");
    for (const digest of bundle.artifactDigests) {
      if (!(await this.deps.artifacts.has(digest))) {
        throw new CapabilityError(
          "source-unavailable",
          "A package artifact did not arrive with the handover; the handover will be retried.",
        );
      }
    }
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    const epoch = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const next = Math.max(bundle.epoch, state.epoch, executor.epoch) + 1;
      for (const collection of TRANSFERRED_COLLECTIONS) {
        (state as unknown as Record<string, unknown>)[collection] =
          bundle.collections[collection] ?? {};
      }
      state.settings = { ...state.settings, ...bundle.settings };
      state.revision = Math.max(state.revision, bundle.revision);
      state.epoch = next;
      state.controllerId = selfId;
      state.handover = {
        id: handoverId,
        role: "received",
        peerId: input.controllerId,
        epoch: next,
        at: this.deps.now(),
      };
      delete state.leafAuthority;
      state.machines[selfId] ??= {
        nodeId: selfId,
        enrolled: state.settings.enrollNewMachines,
        groups: [],
      };
      recordActivity(state, {
        action: "handover-received",
        summary: "This machine is now the command node for capability management.",
        packageIds: [],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: next, changed: true };
    });
    this.raiseExecutor(epoch, selfId);
    await fs.rm(this.bundleFile(handoverId), { force: true });
    await fs.rm(`${this.bundleFile(handoverId)}.sha256`, { force: true });
    await fs.rm(path.join(this.root, handoverId), { recursive: true, force: true });
    return { installed: true, epoch };
  }

  private raiseExecutor(epoch: number, selfId: string): void {
    this.deps.storage.capabilities.mutateCapabilityExecutorState((executor) => {
      if (executor.epoch < epoch || executor.controllerId !== selfId) {
        executor.epoch = Math.max(executor.epoch, epoch);
        executor.controllerId = selfId;
      }
    });
  }
}

function parseBundle(text: string): CapabilityHandoverBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CapabilityError("unsafe-content", "The received capability state is malformed.");
  }
  const bundle = parsed as Partial<CapabilityHandoverBundle> | null;
  if (
    !bundle ||
    typeof bundle !== "object" ||
    bundle.formatVersion !== BUNDLE_FORMAT ||
    typeof bundle.handoverId !== "string" ||
    typeof bundle.fromControllerId !== "string" ||
    typeof bundle.epoch !== "number" ||
    !Number.isInteger(bundle.epoch) ||
    bundle.epoch < 1 ||
    typeof bundle.revision !== "number" ||
    !bundle.settings ||
    typeof bundle.settings !== "object" ||
    !bundle.collections ||
    typeof bundle.collections !== "object" ||
    !Array.isArray(bundle.artifactDigests) ||
    !bundle.artifactDigests.every(
      (digest) => typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest),
    )
  ) {
    throw new CapabilityError("unsafe-content", "The received capability state is malformed.");
  }
  for (const value of Object.values(bundle.collections)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CapabilityError("unsafe-content", "The received capability state is malformed.");
  }
  return bundle as CapabilityHandoverBundle;
}
