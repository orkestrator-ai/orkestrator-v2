import { describe, expect, test } from "bun:test";
import { coordinatorRuntimeId, type CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import type { NativeComposeDraft } from "@/stores/nativeComposeStore";
import { createSessionKey } from "@/lib/utils";
import { unusedCoordinatorConversationIds } from "./coordinator-unused-conversations";

const conversation = (
  id: string,
  extra: Partial<CoordinatorWorkspace["conversations"][number]> = {},
): CoordinatorWorkspace["conversations"][number] => ({
  id,
  tabId: `tab-${id}`,
  logicalSessionKey: `key-${id}`,
  title: id,
  createdAt: new Date(0).toISOString(),
  mailboxIncarnationId: `mailbox-${id}`,
  role: "side",
  sideOrdinal: 1,
  ...extra,
});

const workspace = (conversations: CoordinatorWorkspace["conversations"]): CoordinatorWorkspace => ({
  version: 1,
  id: "coordinator-1",
  projectId: "project-1",
  executionPolicy: "coordinator-read-only",
  lifecycleState: "ready",
  conversations,
  selectedConversationId: null,
  repositoryContextRevision: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const draft = (update: Partial<NativeComposeDraft>): NativeComposeDraft => ({
  text: "",
  mentions: [],
  attachments: [],
  annotations: [],
  fastMode: false,
  mode: "build",
  ...update,
});

const key = (id: string) =>
  createSessionKey(coordinatorRuntimeId("coordinator-1", id), `tab-${id}`);

describe("unusedCoordinatorConversationIds", () => {
  test("offers only open, unassigned side agents with nothing in their composer", () => {
    const drafts = new Map<string, NativeComposeDraft>([
      [key("whitespace"), draft({ text: "   ", platform: "codex" })],
      [key("typed"), draft({ text: "Plan the migration" })],
      [key("attached"), draft({ attachments: [{} as NativeComposeDraft["attachments"][number]] })],
      [key("sending"), draft({ submissionPending: true })],
    ]);
    const ids = unusedCoordinatorConversationIds(
      workspace([
        conversation("main", { role: "main", sideOrdinal: undefined }),
        conversation("never-mounted"),
        conversation("whitespace"),
        conversation("typed"),
        conversation("attached"),
        conversation("sending"),
        conversation("assigned", { agent: "claude" }),
        conversation("closed", { closedAt: new Date(0).toISOString() }),
        conversation("launching"),
      ]),
      drafts,
      "launching",
    );
    expect(ids).toEqual(["never-mounted", "whitespace"]);
  });
});
