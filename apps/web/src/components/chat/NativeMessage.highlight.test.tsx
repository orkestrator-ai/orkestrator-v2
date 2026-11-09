import { afterEach, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { NativeMessage as Message } from "@/lib/chat/native-message-types";
import { ERROR_MESSAGE_PREFIX } from "@/lib/chat/client-only-messages";
import {
  findTranscriptItemElement,
  startConversationTargetGlow,
} from "@/lib/transcript-scroll/conversation-target-highlight";
import { NativeMessage } from "./NativeMessage";

afterEach(cleanup);
const at = "2026-11-09T10:00:00.000Z";
const base: Message = {
  id: "message",
  role: "assistant",
  content: "Hello",
  parts: [{ type: "text", content: "Hello" }],
  createdAt: at,
};
const mail = {
  messageId: "mail",
  kind: "notice" as const,
  sender: "Orkestrator workflow",
  subject: "Build finished",
  warning: "Status notice",
  body: "Build finished",
};
const cases: Array<[string, Partial<Message>, string]> = [
  ["assistant", {}, "message"],
  ["user bubble", { role: "user" }, "message"],
  ["system", { role: "system" }, "system"],
  ["error", { id: `${ERROR_MESSAGE_PREFIX}1` }, "error"],
  ["workflow notice", { id: "peer-mail-1", peerMail: mail }, "mail"],
  [
    "pull request",
    {
      id: "peer-mail-pr",
      peerMail: {
        ...mail,
        subject: "PR #12 updated: Build",
        body: 'Pull request #12 "Build" in acme/app: checks passing.\nURL: https://github.com/acme/app/pull/12',
        notice: {
          resource: { kind: "watched-pull-request", id: "acme/app#12", label: "Build" },
          state: "pr-updated",
          tone: "info",
        },
      },
    },
    "pull-request-update",
  ],
  ["goal turn", { id: "goal-turn-1", goalTurn: { objective: "Build", iteration: 0 } }, "goal-turn"],
  ["goal status", { goalStatus: { kind: "set", tone: "neutral" } }, "goal-status"],
  [
    "suborks",
    {
      suborkGroup: {
        id: "batch",
        createdAt: at,
        status: "settled",
        delivery: "waiting",
        suborks: [],
      },
    },
    "subork-group",
  ],
  [
    "user command",
    {
      parts: [
        {
          type: "user-command",
          content: "pwd",
          userCommand: {
            id: "cmd",
            environmentId: "env",
            tabId: "tab",
            command: "pwd",
            target: "worktree",
            cwd: "/fixture",
            status: "exited",
            exitCode: 0,
            startedAt: at,
            output: "",
            outputTruncated: false,
            context: { state: "pending" },
            revision: 1,
          },
        },
      ],
    },
    "user-command",
  ],
  [
    "permission rule",
    {
      parts: [
        {
          type: "permission-rule",
          content: "Allowed",
          application: {
            ruleId: "rule",
            kind: "command-prefix",
            pattern: "pwd",
            scope: "environment",
            environmentId: "env",
            agent: "codex",
            logicalSessionKey: "session",
            interactionId: "interaction",
            appliedAt: 1,
          },
          ruleExists: true,
        },
      ],
    },
    "permission-rule",
  ],
];

test.each(cases)("%s renderer marks its own box for the glow", (_name, overrides, marker) => {
  const { container } = renderInAppCommandScope(
    <NativeMessage message={{ ...base, ...overrides }} />,
  );
  const target = findTranscriptItemElement(container, container);
  expect(target).not.toBe(container);
  expect(target.getAttribute("data-transcript-item")).toBe(marker);
  // The marker belongs inside the padding row, never on its full-width wrapper.
  expect(target.parentElement).not.toBe(container);
  const stop = startConversationTargetGlow(target, 1);
  expect(container.querySelectorAll("[data-conversation-target-glow]").length).toBe(1);
  expect(target.hasAttribute("data-conversation-target-glow")).toBe(true);
  stop();
});
