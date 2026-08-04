import { describe, expect, test } from "bun:test";
import {
  buildTmuxPromptWithAttachments,
  createClaudeTmuxStateKey,
  escapePathForTerminalInput,
  parseClaudeTmuxStateKey,
  parseTmuxPromptAttachments,
} from "./tmux-prompt.js";

describe("escapePathForTerminalInput", () => {
  test("escapes every character the pane would otherwise interpret", () => {
    expect(escapePathForTerminalInput("/tmp/my shots/a(1).png"))
      .toBe("/tmp/my\\ shots/a\\(1\\).png");
    expect(escapePathForTerminalInput("/tmp/$HOME/`x`;rm"))
      .toBe("/tmp/\\$HOME/\\`x\\`\\;rm");
  });

  test("leaves an ordinary path untouched", () => {
    expect(escapePathForTerminalInput("/workspace/img.png")).toBe("/workspace/img.png");
  });
});

describe("buildTmuxPromptWithAttachments", () => {
  test("returns the text unchanged when there is nothing attached", () => {
    expect(buildTmuxPromptWithAttachments("hello", [])).toBe("hello");
  });

  test("escapes host paths but leaves container paths alone", () => {
    const attachments = [{ name: "shot.png", path: "/tmp/my shots/shot.png" }];
    expect(buildTmuxPromptWithAttachments("look", attachments))
      .toContain("/tmp/my\\ shots/shot.png");
    // Inside a container the path is typed as-is: the escape exists for the
    // host shell, and applying it there would name a file that does not exist.
    expect(buildTmuxPromptWithAttachments("look", attachments, "container-1"))
      .toContain("/tmp/my shots/shot.png");
  });

  test("stands alone when the user attached an image with no text", () => {
    const prompt = buildTmuxPromptWithAttachments("", [
      { name: "a.png", path: "/w/a.png" },
    ]);
    expect(prompt.startsWith("Attached images")).toBe(true);
    expect(prompt).toContain("- a.png: /w/a.png");
  });
});

describe("parseTmuxPromptAttachments", () => {
  test("keeps well-formed entries and drops everything else", () => {
    expect(parseTmuxPromptAttachments([
      { name: "a.png", path: "/w/a.png" },
      { name: "", path: "/w/b.png" },
      { name: "c.png", path: "  " },
      { name: 1, path: "/w/d.png" },
      null,
      "nope",
    ])).toEqual([{ name: "a.png", path: "/w/a.png" }]);
  });

  test("treats a missing or non-array field as no attachments", () => {
    expect(parseTmuxPromptAttachments(undefined)).toEqual([]);
    expect(parseTmuxPromptAttachments({ length: 1 })).toEqual([]);
  });
});

describe("claude-tmux state keys", () => {
  test("round-trips an environment and tab", () => {
    const key = createClaudeTmuxStateKey("env-1", "tab-1");
    expect(parseClaudeTmuxStateKey(key)).toEqual({
      environmentId: "env-1",
      tabId: "tab-1",
    });
  });

  test("keeps a tab id containing colons intact", () => {
    expect(parseClaudeTmuxStateKey("env:env-1:tab:build:2")).toEqual({
      environmentId: "env-1",
      tabId: "build:2",
    });
  });

  test("rejects anything that is not a tmux state key", () => {
    expect(parseClaudeTmuxStateKey("env-1:tab-1")).toBeNull();
    expect(parseClaudeTmuxStateKey("env:env-1:tab:")).toBeNull();
    expect(parseClaudeTmuxStateKey("")).toBeNull();
  });
});
