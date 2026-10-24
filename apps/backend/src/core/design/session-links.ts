import { randomUUID } from "node:crypto";
import {
  DESIGN_LIMITS,
  type DesignSessionLink,
  type DesignSessionLinkStates,
  type DesignSessionResumeResult,
} from "@orkestrator/protocol/design-operations";
import { DesignError } from "./errors.js";
import { cloneRecord } from "./records.js";
import type { DesignService } from "./service.js";

/**
 * Canvas-to-conversation links. A link stores only the association (tab,
 * native session identity, platform, role, creation time, optional
 * checkpoint), never a transcript, credential or copy of native status.
 */

export type DesignSessionLinkInput = Omit<DesignSessionLink, "id" | "createdAt">;

/**
 * Reads the backend's durable native-session mapping for one link's tab.
 * `null` means the backend has none (tab teardown retires it). Implementations
 * read storage only: no bridge, no liveness route, so idle detachment is never
 * defeated.
 */
export type DesignNativeSessionLookup = (
  link: DesignSessionLink,
) => Promise<{ providerSessionId: string } | null>;

export async function linkSession(
  design: DesignService,
  environmentId: string,
  canvasId: string,
  link: DesignSessionLinkInput,
  replaceId?: string,
): Promise<DesignSessionLink> {
  await design.initialize();
  return design.lane(canvasId, async () => {
    const { record, legacy } = await design.loadFor(canvasId, environmentId);
    const next = cloneRecord(record);
    const existing = next.sessions.find((candidate) => candidate.tabId === link.tabId);
    if (existing) {
      Object.assign(existing, link);
    } else {
      if (replaceId)
        next.sessions = next.sessions.filter((candidate) => candidate.id !== replaceId);
      if (next.sessions.length >= DESIGN_LIMITS.sessionLinksPerCanvas)
        throw new DesignError(
          "capacity",
          "This design already links eight conversations; replace one",
          {
            retry: "review",
          },
        );
      next.sessions.push({ ...link, id: randomUUID().slice(0, 12), createdAt: design.iso() });
    }
    next.statusVersion++;
    await design.commit(next, legacy, {
      revision: next.document.revision,
      kind: "status",
      statusVersion: next.statusVersion,
    });
    return next.sessions.find((candidate) => candidate.tabId === link.tabId)!;
  });
}

export async function unlinkSession(
  design: DesignService,
  environmentId: string,
  canvasId: string,
  linkId: string,
): Promise<void> {
  await design.initialize();
  await design.lane(canvasId, async () => {
    const { record, legacy } = await design.loadFor(canvasId, environmentId, {
      allowDeleted: true,
    });
    if (!record.sessions.some((candidate) => candidate.id === linkId)) return;
    const next = cloneRecord(record);
    next.sessions = next.sessions.filter((candidate) => candidate.id !== linkId);
    next.statusVersion++;
    await design.commit(next, legacy, {
      revision: next.document.revision,
      kind: "status",
      statusVersion: next.statusVersion,
    });
  });
}

/**
 * Report which links' tabs the backend maps to a native session. Read only:
 * a link's session identity is recorded when its tab closes
 * ({@link recordTabSession}), the moment the tab id stops leading to the
 * conversation.
 */
export async function sessionLinkStates(
  design: DesignService,
  environmentId: string,
  canvasId: string,
  lookup: DesignNativeSessionLookup,
): Promise<DesignSessionLinkStates> {
  await design.initialize();
  const { record } = await design.lane(canvasId, () => design.loadFor(canvasId, environmentId));
  const found = await Promise.all(record.sessions.map((link) => lookup(link)));
  return {
    sessions: record.sessions,
    states: record.sessions.map((link, index) => ({
      linkId: link.id,
      session: found[index] ? "retained" : "missing",
    })),
  };
}

/** Reopens a link's conversation under a tab, through the native-agent session APIs. */
export interface DesignSessionResumer {
  /**
   * Resume `link.sessionId` as the native session of `tabId` and return the
   * live provider session now mapped to that tab. Throws when the provider no
   * longer has the conversation; it never starts a replacement.
   */
  resume(link: DesignSessionLink, tabId: string): Promise<string>;
  /** The live provider session already mapped to `tabId`, if any. */
  mapped(link: DesignSessionLink, tabId: string): Promise<string | null>;
}

function resumeFailure(error: unknown): DesignError {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  return /not found|missing/i.test(message)
    ? new DesignError("not-found", `The agent no longer has this conversation: ${message}`, {
        retry: "never",
      })
    : new DesignError("disconnected", `Could not reopen the conversation: ${message}`, {
        retry: "after-delay",
      });
}

/**
 * Reopen a link's conversation in the tab it is being resumed in, and move
 * the link there.
 *
 * Serialized by the canvas lane and guarded by a compare-and-set on the tab
 * the caller saw. Every client derives the resume tab id from the same link
 * state, so two clients pressing Resume together send the same `tabId`: the
 * first resumes the session and moves the link, the second waits for it and
 * gets the same association and live session back without resuming again. A
 * link that moved anywhere else is a conflict. The link moves only after the
 * provider reopened the session, so a lost conversation is reported here, not
 * as a broken tab or an empty replacement.
 */
export async function resumeSessionLink(
  design: DesignService,
  environmentId: string,
  canvasId: string,
  input: { linkId: string; expectedTabId: string; tabId: string },
  resumer: DesignSessionResumer,
): Promise<DesignSessionResumeResult> {
  await design.initialize();
  return design.lane(canvasId, async () => {
    const { record, legacy } = await design.loadFor(canvasId, environmentId);
    const current = record.sessions.find((candidate) => candidate.id === input.linkId);
    if (!current)
      throw new DesignError("not-found", "This conversation is no longer linked to the design");
    const stale = () =>
      new DesignError(
        "conflict",
        "This conversation was reopened elsewhere; refresh and try again",
        {
          retry: "after-refresh",
        },
      );
    if (current.tabId === input.tabId) {
      const mapped = await resumer.mapped(current, input.tabId);
      if (!mapped) throw stale();
      return { link: current, providerSessionId: mapped };
    }
    if (current.tabId !== input.expectedTabId) throw stale();
    if (!current.sessionId)
      throw new DesignError("invalid-input", "This conversation has no session to resume", {
        retry: "never",
      });
    let providerSessionId: string;
    try {
      providerSessionId = await resumer.resume(current, input.tabId);
    } catch (error) {
      throw resumeFailure(error);
    }
    const next = cloneRecord(record);
    const link = next.sessions.find((candidate) => candidate.id === input.linkId)!;
    link.tabId = input.tabId;
    next.statusVersion++;
    await design.commit(next, legacy, {
      revision: next.document.revision,
      kind: "status",
      statusVersion: next.statusVersion,
    });
    return { link, providerSessionId };
  });
}

/**
 * Record a closing tab's native session on every link that points at it.
 *
 * Called by tab teardown just before it retires the tab's native-session
 * mapping: closing a tab keeps the conversation but not that mapping, so this
 * is the last moment the link's temporary tab reference can be turned into a
 * durable session identity. Best effort per canvas; returns how many links
 * changed.
 */
export async function recordTabSession(
  design: DesignService,
  input: { environmentId: string; tabId: string; platform: string; providerSessionId: string },
): Promise<number> {
  await design.initialize();
  let recorded = 0;
  for (const summary of Array.from(design.library.entries.values())) {
    if (summary.environmentId !== input.environmentId || summary.state !== "live") continue;
    await design
      .lane(summary.id, async () => {
        const { record, legacy } = await design.loadFor(summary.id, input.environmentId);
        const index = record.sessions.findIndex(
          (link) => link.tabId === input.tabId && link.platform === input.platform,
        );
        if (index < 0 || record.sessions[index]!.sessionId === input.providerSessionId) return;
        const next = cloneRecord(record);
        next.sessions[index]!.sessionId = input.providerSessionId;
        next.statusVersion++;
        await design.commit(next, legacy, {
          revision: next.document.revision,
          kind: "status",
          statusVersion: next.statusVersion,
        });
        recorded++;
      })
      .catch((error: unknown) => {
        // One unreadable canvas must not keep the others, or the close, waiting.
        console.warn(
          "[backend] Could not record a closing conversation on a design link:",
          (error as { failure?: { code?: string } })?.failure?.code ?? "error",
        );
      });
  }
  return recorded;
}
