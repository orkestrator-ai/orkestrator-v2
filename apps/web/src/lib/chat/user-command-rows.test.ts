import { describe, expect, test } from "bun:test";

import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";

import type { NativeMessage } from "./native-message-types";
import { withUserCommandRows } from "./user-command-rows";

const message = (id: string, createdAt: string): NativeMessage => ({
  id,
  role: "assistant",
  content: id,
  parts: [],
  createdAt,
});
const command = (id: string, startedAt: string) =>
  ({ id, command: id, startedAt }) as unknown as UserCommandRecord;

describe("withUserCommandRows", () => {
  test("places each command after the last row that started before it", () => {
    const rows = withUserCommandRows(
      [message("a", "2026-10-26T13:00:00Z"), message("b", "2026-10-26T13:10:00Z")],
      [command("late", "2026-10-26T13:20:00Z"), command("mid", "2026-10-26T13:05:00Z")],
    );
    expect(rows.map((row) => row.id)).toEqual(["a", "user-command:mid", "b", "user-command:late"]);
    expect(rows[1]!.parts[0]).toMatchObject({ type: "user-command" });
  });

  test("no commands leaves the transcript as it was", () => {
    const messages = [message("a", "2026-10-26T13:00:00Z")];
    expect(withUserCommandRows(messages, [])).toEqual(messages);
  });
});
