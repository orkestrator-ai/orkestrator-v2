import { describe, expect, test } from "bun:test";
import { extractPersistedMessageContent, extractPersistedMessageText } from "./rollout.js";
import { wrapPromptForConversationMode } from "../prompts/slash-commands.js";
import { appendAttachmentTags } from "../messages/attachment-tags.js";
import {
  COORDINATOR_CONTEXT_CLOSE_TAG,
  COORDINATOR_CONTEXT_OPEN_TAG,
} from "@orkestrator/protocol/coordinator";

const content = (...texts: string[]) => texts.map((text) => ({ type: "input_text", text }));

describe("a persisted user message shows the prompt as typed", () => {
  test("the plan-mode preamble the bridge wrote is stripped", () => {
    expect(
      extractPersistedMessageText(
        content(wrapPromptForConversationMode("Plan it", "plan")),
        "user",
      ),
    ).toBe("Plan it");
    // The coordinator block sits inside the preamble, as the bridge sends it.
    const coordinator = `${COORDINATOR_CONTEXT_OPEN_TAG}\nproject: p\n${COORDINATOR_CONTEXT_CLOSE_TAG}\n\nAsk`;
    expect(
      extractPersistedMessageText(
        content(wrapPromptForConversationMode(coordinator, "plan")),
        "user",
      ),
    ).toBe("Ask");
  });

  test("a reminder the user typed survives, in plan mode and out of it", () => {
    const own = "<system-reminder>Keep mine</system-reminder>\n\nPlan it";
    expect(extractPersistedMessageText(content(own), "user")).toBe(own);
    expect(
      extractPersistedMessageText(content(wrapPromptForConversationMode(own, "plan")), "user"),
    ).toBe(own);
    // Only the exact wording: a reworded copy is the user's text.
    const reworded = wrapPromptForConversationMode("Plan it", "plan").replace(
      "planning-only",
      "planning only",
    );
    expect(extractPersistedMessageText(content(reworded), "user")).toBe(reworded);
  });

  test("an attachment-only plan-mode prompt keeps its attachment and no text", () => {
    const sent = appendAttachmentTags(wrapPromptForConversationMode("", "plan"), [
      { path: "/tmp/ws/shot.png", filename: "shot.png" },
    ]);
    const persisted = extractPersistedMessageContent(content(sent), "user");
    expect(persisted?.text).toBe("");
    expect(persisted?.attachments).toHaveLength(1);
  });

  test("a typed answer replaces the sent text and keeps the attachments", () => {
    const sent = appendAttachmentTags("$tidy the header", [
      { path: "/tmp/ws/shot.png", filename: "shot.png" },
    ]);
    const asked: string[] = [];
    const persisted = extractPersistedMessageContent(content(sent), "user", {
      typedPrompt: (sentText) => {
        asked.push(sentText);
        return "/skill:tidy the header";
      },
    });
    // The resolver is given the whole joined text, attachment tags included.
    expect(asked).toEqual([sent.trim()]);
    expect(persisted?.text).toBe("/skill:tidy the header");
    expect(persisted?.attachments).toHaveLength(1);
  });

  test("without a typed answer the sent text renders, as for a thread from another client", () => {
    expect(
      extractPersistedMessageContent(content("$tidy from the CLI"), "user", {
        typedPrompt: () => undefined,
      })?.text,
    ).toBe("$tidy from the CLI");
  });

  test("Codex's own blocks are still dropped before any typed answer is asked", () => {
    let asked = false;
    expect(
      extractPersistedMessageContent(content("<skill>\n<name>tidy</name>\n</skill>"), "user", {
        typedPrompt: () => {
          asked = true;
          return "typed";
        },
      }),
    ).toBeNull();
    expect(asked).toBe(false);
  });

  test("assistant messages never ask for a typed answer", () => {
    expect(
      extractPersistedMessageContent([{ type: "output_text", text: "Reply" }], "assistant", {
        typedPrompt: () => "typed",
      })?.text,
    ).toBe("Reply");
  });
});
