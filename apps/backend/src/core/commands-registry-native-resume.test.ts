import { expect, mock, test } from "bun:test";
import { createCommandRegistry, type CommandContext } from "./commands.js";

const identity = { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1" };

test.each([true, false, undefined, null, "true", 1])(
  "native list command forwards includeArchived only for true (%j)",
  async (includeArchived) => {
    const result = [{ sessionId: "kept", archived: true }];
    const listProjectionResumableSessions = mock(async () => result);
    const context = {
      nativeAgents: { listProjectionResumableSessions },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("list_native_agent_resumable_sessions")!;
    expect(await command({ ...identity, includeArchived }, context)).toEqual(result);
    expect(listProjectionResumableSessions).toHaveBeenCalledWith({
      ...identity,
      ...(includeArchived === true ? { includeArchived: true } : {}),
    });
  },
);
