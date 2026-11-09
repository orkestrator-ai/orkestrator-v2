/**
 * OpenCode 2.x session state beyond prompts (build plan phase 5): the
 * Plan/Build agents, fork, the resume list, titles, archive and the to-do
 * count. Each helper reads or writes one route and normalizes field by field.
 *
 * Facts from 2.2.6, checked live:
 *
 * - `GET /api/agent` lists every agent; the user picks among `mode:
 *   "primary"` and not `hidden` (`build`, `plan`). `POST
 *   /api/session/:id/agent` answers 204 even for an unknown agent, so a
 *   selection is checked against that list first.
 * - `POST /api/session/:id/fork { before? }` copies the history before a
 *   message (`before`) or all of it (no body), and answers the new Session.
 * - `GET /api/session` lists sessions newest first, filtered by `directory`,
 *   `parentID=null` and `archived`; `PATCH /api/session/:id` takes `title`
 *   and `archived`. 2.x also names sessions itself (its `title` agent).
 * - The to-do tool is `todowrite` with input `{ todos: [{ content, status }] }`
 *   (`OPENCODE_FLAGS` includes `todo`), the shape the shared to-do card reads.
 */
import type {
  NativeAgentComposerState,
  NativeAgentForkOutcome,
  NativeAgentResumeEntry,
} from "@orkestrator/protocol/native-agent";
import { PromptRejectedError, ProviderUnavailableError } from "../agent-provider-contract.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import { openCode2ModelId, openCode2ReasoningId } from "./models.js";
import type { OpenCode2Message } from "./types.js";

/** A resume-list id names its line, so a resume after a restart still finds 2.x. */
export const OPENCODE2_RESUME_PREFIX = "opencode2:";
export const OPENCODE2_RESUME_LIST_LIMIT = 200;
const AGENT_TTL_MS = 30_000;
const MAX_PROFILES = 128;
const MAX_TITLE_LENGTH = 500;
const MAX_ID_LENGTH = 256;

type Profiles = NonNullable<NativeAgentComposerState["executionProfiles"]>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
}

function isoTime(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function path(sessionId: string, suffix = ""): string {
  return `/api/session/${encodeURIComponent(sessionId)}${suffix}`;
}

/** The agents a person may pick for a turn: primary and not hidden. */
export function openCode2ExecutionProfiles(agents: unknown): Profiles {
  return (Array.isArray(agents) ? agents : []).slice(0, MAX_PROFILES).flatMap((candidate) => {
    const agent = record(candidate);
    const id = boundedId(agent?.id);
    if (!agent || !id || agent.hidden === true || agent.mode !== "primary") return [];
    const model = openCode2ModelId(record(agent.model));
    return [
      {
        id,
        label: typeof agent.name === "string" && agent.name.trim() ? agent.name.slice(0, 200) : id,
        ...(typeof agent.description === "string"
          ? { description: agent.description.slice(0, 1_000) }
          : {}),
        ...(model ? { modelId: model } : {}),
      },
    ];
  });
}

/** The agent list, cached briefly; the composer reads it on every snapshot. */
export class OpenCode2AgentCache {
  private cached: { at: number; profiles: Profiles } | undefined;
  private flight: Promise<Profiles> | undefined;

  constructor(
    private readonly client: Pick<OpenCode2Client, "api">,
    private readonly now: () => number = Date.now,
  ) {}

  read(): Promise<Profiles> {
    if (this.cached && this.now() - this.cached.at < AGENT_TTL_MS) {
      return Promise.resolve(this.cached.profiles);
    }
    this.flight ??= this.client
      .api<unknown>("GET", "/api/agent", "OpenCode agent list", {})
      .then((agents) => {
        if (!Array.isArray(agents)) throw new Error("OpenCode agent list is malformed");
        const profiles = openCode2ExecutionProfiles(agents);
        this.cached = { at: this.now(), profiles };
        return profiles;
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }

  clear(): void {
    this.cached = undefined;
  }
}

/**
 * Switch the session's agent. An agent the list does not offer is refused
 * before the request: 2.x would accept it silently. An unreadable list does
 * not block the switch.
 */
export async function selectOpenCode2Agent(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
  agent: string,
  profiles: Profiles | undefined,
): Promise<void> {
  if (profiles && !profiles.some((profile) => profile.id === agent)) {
    throw new PromptRejectedError(`OpenCode 2 has no "${agent.slice(0, 64)}" agent to switch to`);
  }
  try {
    await client.api("POST", path(sessionId, "/agent"), "OpenCode agent switch", {
      body: { agent },
    });
  } catch (error) {
    if (error instanceof OpenCode2RequestError) {
      throw new PromptRejectedError(`OpenCode refused the agent: ${error.message}`);
    }
    // Nothing was dispatched yet: unavailable, not ambiguous.
    throw new ProviderUnavailableError("OpenCode 2.x agent switch failed", { cause: error });
  }
}

/** What a snapshot reports about the session itself. */
export interface OpenCode2SessionDetails {
  modelId?: string;
  reasoningId?: string;
  agent?: string;
  title?: string;
  archived?: boolean;
}

export function openCode2SessionDetails(session: unknown): OpenCode2SessionDetails {
  const value = record(session);
  const model = record(value?.model);
  const modelId = openCode2ModelId(model);
  const title =
    typeof value?.title === "string" ? value.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const agent = boundedId(value?.agent);
  return {
    ...(modelId ? { modelId, reasoningId: openCode2ReasoningId(model) } : {}),
    ...(agent ? { agent } : {}),
    ...(title ? { title } : {}),
    ...(record(value?.time)?.archived !== undefined ? { archived: true } : {}),
  };
}

/** Resume-list rows from `GET /api/session`; ids carry {@link OPENCODE2_RESUME_PREFIX}. */
export function openCode2ResumeEntries(sessions: unknown): NativeAgentResumeEntry[] {
  return (Array.isArray(sessions) ? sessions : [])
    .slice(0, OPENCODE2_RESUME_LIST_LIMIT)
    .flatMap((candidate) => {
      const session = record(candidate);
      const id = boundedId(session?.id);
      if (!session || !id?.startsWith("ses")) return [];
      const time = record(session.time);
      const createdAt = isoTime(time?.created);
      const updatedAt = isoTime(time?.updated);
      const title =
        typeof session.title === "string" ? session.title.slice(0, MAX_TITLE_LENGTH) : "";
      const parentId = boundedId(session.parentID) ?? boundedId(record(session.fork)?.sessionID);
      return [
        {
          sessionId: `${OPENCODE2_RESUME_PREFIX}${id}`,
          ...(title ? { title } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          ...(parentId ? { parentId: `${OPENCODE2_RESUME_PREFIX}${parentId}` } : {}),
          ...(time?.archived !== undefined ? { archived: true } : {}),
        },
      ];
    });
}

/** The 2.x session id behind a resume-list id, or undefined for a 1.x one. */
export function openCode2ResumeSessionId(resumableId: string): string | undefined {
  if (!resumableId.startsWith(OPENCODE2_RESUME_PREFIX)) return undefined;
  const id = resumableId.slice(OPENCODE2_RESUME_PREFIX.length);
  return id.startsWith("ses") && id.length <= MAX_ID_LENGTH ? id : undefined;
}

export async function listOpenCode2ResumableSessions(
  client: Pick<OpenCode2Client, "api" | "directory">,
  options: { includeArchived?: boolean } = {},
): Promise<NativeAgentResumeEntry[]> {
  const sessions = await client.api<unknown>("GET", "/api/session", "OpenCode session list", {
    query: {
      limit: String(OPENCODE2_RESUME_LIST_LIMIT),
      order: "desc",
      parentID: "null",
      directory: client.directory,
      ...(options.includeArchived ? {} : { archived: "false" }),
    },
    maxBytes: 4 * 1024 * 1024,
  });
  return openCode2ResumeEntries(sessions);
}

export async function forkOpenCode2Session(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
  messageId: string | undefined,
): Promise<NativeAgentForkOutcome> {
  if (messageId !== undefined && !messageId.startsWith("msg_")) {
    throw new PromptRejectedError("OpenCode 2 forks from one of its own messages");
  }
  let forked: unknown;
  try {
    forked = await client.api("POST", path(sessionId, "/fork"), "OpenCode session fork", {
      body: messageId ? { before: messageId } : {},
    });
  } catch (error) {
    if (error instanceof OpenCode2RequestError) {
      throw new PromptRejectedError(`OpenCode refused the fork: ${error.message}`);
    }
    throw new ProviderUnavailableError("OpenCode 2.x session fork failed", { cause: error });
  }
  const id = boundedId(record(forked)?.id);
  if (!id?.startsWith("ses"))
    throw new ProviderUnavailableError("OpenCode returned a malformed fork");
  const details = openCode2SessionDetails(forked);
  return {
    sessionId: id,
    ...(details.title ? { title: details.title } : {}),
    ...(details.modelId
      ? { controls: { modelId: details.modelId, reasoningId: details.reasoningId } }
      : {}),
  };
}

export async function updateOpenCode2Session(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
  patch: { title?: string; archived?: boolean },
): Promise<void> {
  await client.api("PATCH", path(sessionId), "OpenCode session update", {
    body: {
      ...(patch.title !== undefined ? { title: patch.title.slice(0, MAX_TITLE_LENGTH) } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    },
  });
}

/**
 * The size of the session's current to-do list: the newest `todowrite`
 * call's list, as the 1.x `session.todo` count is. Undefined when the read
 * holds no call.
 */
export function openCode2TodoCount(rows: readonly OpenCode2Message[]): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] as { type?: string; content?: unknown };
    if (row.type !== "assistant" || !Array.isArray(row.content)) continue;
    for (let part = row.content.length - 1; part >= 0; part -= 1) {
      const content = record(row.content[part]);
      if (content?.type !== "tool" || content.name !== "todowrite") continue;
      const todos = record(record(content.state)?.input)?.todos;
      if (Array.isArray(todos)) return todos.length;
    }
  }
  return undefined;
}
