import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { escapedInteractionFailures, type CoordinatorLiveCheck } from "./coordinator-live.js";

/**
 * The live coordinator suite's `identity` scenario (to-do 0024 task 6, retired;
 * see "The `identity` case" in `docs/development/agent-testing.md`).
 *
 * One harness-made environment with three agent tabs on the platform, and no
 * coordinator. It checks the mailbox identity behaviours that depend on each
 * bridge passing the tab's own Agent MCP credential through:
 *
 * - each of two tabs calls `list_mailboxes` and sees itself, and only itself,
 *   as `self`;
 * - with the second tab's inject policy set to `idle`, mail sent to it as the
 *   user starts a turn on its own (the default policy, `off`, would hold it);
 * - the first tab's conversation resumed in the third tab is the same
 *   conversation (same provider session, and it remembers the first turn's
 *   code word) under the third tab's credential, which is what a resume with a
 *   new `agentMcp` looks like to a bridge: Cursor must keep the same SDK agent,
 *   Grok must reload only that session's child.
 *
 * Shared by the Node Playwright spec and the Bun tests, so nothing here may
 * use Bun APIs.
 */

export const IDENTITY_REPORT_MARKER = "COORDINATOR_LIVE_IDENTITY";
export const IDENTITY_IDLE_MARKER = "COORDINATOR_LIVE_IDENTITY_IDLE";
export const IDENTITY_RESUME_MARKER = "COORDINATOR_LIVE_IDENTITY_RESUME";

/** The three tabs, in the order the case uses them. */
export const IDENTITY_TABS = Object.freeze({
  first: "identity-a",
  second: "identity-b",
  resumed: "identity-c",
});

export interface IdentityProbe {
  platform: AgentPlatform;
  /** Random hex; the environment's name, the code words and the idle line carry it. */
  token: string;
}

export function identityEnvironmentName(probe: IdentityProbe): string {
  return `identity-${probe.token}`;
}

/** The word the first tab is asked to remember, and the resumed tab to repeat. */
export function identityCodeWord(probe: IdentityProbe): string {
  return `heron-${probe.token}`;
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's mailbox identity conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";

export function identityTabPrompt(probe: IdentityProbe, tab: string): string {
  return [
    HARNESS_PREAMBLE,
    "Call the Orkestrator list_mailboxes tool exactly once, with no arguments. Call no other tool and send no messages.",
    ...(tab === IDENTITY_TABS.first
      ? [`Remember this code word for later in this conversation: ${identityCodeWord(probe)}.`]
      : []),
    "Then end your turn with exactly one line in this format, and nothing after it:",
    `${IDENTITY_REPORT_MARKER} {"self":"<the tabId of the mailbox list_mailboxes marked self, or an empty string>"}`,
  ].join("\n");
}

/** The body of the mail sent to the second tab as the user. */
export function identityIdleMail(probe: IdentityProbe): string {
  return `Reply with exactly one line, ${IDENTITY_IDLE_MARKER} ${probe.token}, and end your turn. Call no tools and send no messages.`;
}

export function identityResumePrompt(): string {
  return [
    HARNESS_PREAMBLE,
    "Call the Orkestrator list_mailboxes tool exactly once, with no arguments. Call no other tool and send no messages.",
    "Then end your turn with exactly one line in this format, and nothing after it:",
    `${IDENTITY_RESUME_MARKER} {"self":"<the tabId of the mailbox list_mailboxes marked self, or an empty string>","code":"<the code word you were asked to remember earlier in this conversation, or an empty string>"}`,
  ].join("\n");
}

/**
 * The mailboxes one `list_mailboxes` result marks `self`, as
 * `environmentId/tabId`. Unparseable output marks nothing.
 */
export function selfMailboxes(output: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return [];
  }
  const mailboxes =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).mailboxes
      : undefined;
  if (!Array.isArray(mailboxes)) return [];
  return mailboxes.flatMap((mailbox) => {
    if (!mailbox || typeof mailbox !== "object") return [];
    const record = mailbox as Record<string, unknown>;
    return record.self === true &&
      typeof record.environmentId === "string" &&
      typeof record.tabId === "string"
      ? [`${record.environmentId}/${record.tabId}`]
      : [];
  });
}

/** The code word in the last resume line, or why there is none. */
export function parseResumeReport(text: string): { code: string } | { error: string } {
  const raw = [
    ...text.matchAll(new RegExp(`${IDENTITY_RESUME_MARKER}\\s*(\\{[^\\n]*\\})`, "g")),
  ].at(-1)?.[1];
  if (!raw) return { error: `the resumed tab wrote no ${IDENTITY_RESUME_MARKER} line` };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return { code: typeof value.code === "string" ? value.code.trim() : "" };
  } catch {
    return { error: `the ${IDENTITY_RESUME_MARKER} line is not valid JSON` };
  }
}

/** What one tab's turn left for the verdict: tool results and text, never recorded. */
export interface IdentityTabEvidence {
  /** `list_mailboxes` outputs of the tab's turn. */
  listings: string[];
  text: string;
  turnPhase: string;
  turnError?: string;
}

export function evaluateIdentityScenario(input: {
  probe: IdentityProbe;
  environmentId?: string;
  first?: IdentityTabEvidence;
  second?: IdentityTabEvidence;
  /** The second tab's turn the mail started; absent when none started. */
  idle?: IdentityTabEvidence & { placement?: string; turnStarted: boolean };
  resumed?: IdentityTabEvidence;
  firstProviderSessionId?: string;
  resumedProviderSessionId?: string;
  escapedInteractions: readonly AgentInteractionKind[];
}): { checks: CoordinatorLiveCheck[]; observed: Record<string, number> } {
  const { environmentId } = input;
  const sees = (evidence: IdentityTabEvidence | undefined, tab: string): CoordinatorLiveCheck => {
    const name = `self-${tab}`;
    if (!evidence) return { name, passed: false, detail: "the tab's turn did not run" };
    if (evidence.turnPhase === "error") {
      return {
        name,
        passed: false,
        detail: `the turn failed: ${(evidence.turnError ?? "no error text").slice(0, 200)}`,
      };
    }
    if (evidence.listings.length === 0)
      return { name, passed: false, detail: "no list_mailboxes call" };
    const marked = evidence.listings.map(selfMailboxes);
    const wanted = `${environmentId}/${tab}`;
    const right = marked.every((rows) => rows.length === 1 && rows[0] === wanted);
    return right
      ? { name, passed: true }
      : {
          name,
          passed: false,
          detail: `list_mailboxes marked ${marked
            .map((rows) =>
              rows.length === 0
                ? "no mailbox"
                : rows.map((row) => (row === wanted ? "this tab" : "another tab")).join("+"),
            )
            .join(", ")} as self`,
        };
  };
  const idle = input.idle;
  const idleAnswered = idle?.text.includes(`${IDENTITY_IDLE_MARKER} ${input.probe.token}`) === true;
  const resume = input.resumed ? parseResumeReport(input.resumed.text) : undefined;
  const sameSession =
    input.firstProviderSessionId !== undefined &&
    input.firstProviderSessionId === input.resumedProviderSessionId;
  const escaped = escapedInteractionFailures(input.escapedInteractions);
  const checks: CoordinatorLiveCheck[] = [
    sees(input.first, IDENTITY_TABS.first),
    sees(input.second, IDENTITY_TABS.second),
    {
      name: "idle-mail-injected",
      passed: idle?.placement === "injected",
      ...(idle?.placement === "injected"
        ? {}
        : { detail: `the mail's placement is ${idle?.placement ?? "unknown"}` }),
    },
    {
      name: "idle-injection-started-a-turn",
      passed: idle?.turnStarted === true && idleAnswered,
      ...(idle?.turnStarted === true && idleAnswered
        ? {}
        : {
            detail: idle?.turnStarted
              ? `the turn did not write the ${IDENTITY_IDLE_MARKER} line`
              : "no turn started on the tab after the mail",
          }),
    },
    {
      name: "resume-same-conversation",
      passed: sameSession,
      ...(sameSession
        ? {}
        : {
            detail:
              input.resumedProviderSessionId === undefined
                ? "the resumed tab has no provider session"
                : "the resumed tab is on a different provider session",
          }),
    },
    {
      name: "resume-remembers-the-conversation",
      passed:
        resume !== undefined &&
        !("error" in resume) &&
        resume.code === identityCodeWord(input.probe),
      ...(resume === undefined
        ? { detail: "the resumed tab's turn did not run" }
        : "error" in resume
          ? { detail: resume.error }
          : resume.code !== identityCodeWord(input.probe)
            ? { detail: "the resumed tab did not repeat the first turn's code word" }
            : {}),
    },
    sees(input.resumed, IDENTITY_TABS.resumed),
    {
      name: "no-escaped-interactions",
      passed: escaped.length === 0,
      ...(escaped.length > 0 ? { detail: escaped.join("; ") } : {}),
    },
  ];
  return {
    checks,
    observed: {
      listings:
        (input.first?.listings.length ?? 0) +
        (input.second?.listings.length ?? 0) +
        (input.resumed?.listings.length ?? 0),
      idleTurnStarted: idle?.turnStarted ? 1 : 0,
      sameProviderSession: sameSession ? 1 : 0,
    },
  };
}
