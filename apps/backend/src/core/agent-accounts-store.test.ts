import { describe, expect, test } from "bun:test";
import { parseAgentAccountStore } from "./agent-accounts-store.js";

describe("parseAgentAccountStore", () => {
  test("drops malformed and duplicate rows and falls back from a missing active id", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const parsed = parseAgentAccountStore({
      accounts: [
        { id, platform: "claude", label: "Work", createdAt: "2026-09-28T00:00:00Z" },
        { id, platform: "codex", label: "Duplicate", createdAt: "2026-09-28T00:00:00Z" },
        { id: "../escape", platform: "claude", label: "Unsafe", createdAt: "today" },
        {
          id: "66666666-7777-4888-9999-aaaaaaaaaaaa",
          platform: "codex",
          label: "",
          createdAt: "today",
        },
      ],
      active: { claude: "99999999-9999-4999-8999-999999999999", codex: id },
    });
    expect(parsed.accounts).toEqual([
      { id, platform: "claude", label: "Work", createdAt: "2026-09-28T00:00:00Z" },
    ]);
    expect(parsed.active).toEqual({});
  });
});
