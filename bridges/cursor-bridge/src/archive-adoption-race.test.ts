import { afterEach, expect, mock, test } from "bun:test";
import { Agent } from "@cursor/sdk";
import {
  resumeSession,
  setResumableAgentArchived,
  useCursorAgentForTests,
} from "./agent-session.js";
import { useCursorModelsForTests } from "./models.js";
import { sessions } from "./state.js";

const restores: Array<() => void> = [];
afterEach(() => {
  sessions.clear();
  for (const restore of restores.splice(0).reverse()) restore();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<typeof Agent>) {
  // History and models are offline; no SDK callback can reach a real account.
  restores.push(useCursorModelsForTests({ list: async () => [] } as never));
  restores.push(
    useCursorAgentForTests({
      ...Agent,
      listRuns: async () => ({ items: [] }),
      ...overrides,
    } as typeof Agent),
  );
}

test("archive and restore refuse an adoption paused during history hydration", async () => {
  const hydration = gate();
  const started = gate();
  const archive = mock(async () => undefined);
  fixture({
    archive,
    unarchive: archive,
    listRuns: async () => {
      started.resolve();
      await hydration.promise;
      return { items: [] };
    },
  });
  const adopting = resumeSession("agent-adopting", undefined);
  try {
    await started.promise;
    expect(sessions.size).toBe(0);
    expect(await setResumableAgentArchived("agent-adopting", true)).toBe("in-use");
    expect(await setResumableAgentArchived("agent-adopting", false)).toBe("in-use");
    expect(archive).not.toHaveBeenCalled();
  } finally {
    hydration.resolve();
    await adopting;
  }
  expect(await setResumableAgentArchived("agent-adopting", true)).toBe("in-use");
});

test.each([true, false])(
  "adoption refuses an in-flight archive mutation (%s)",
  async (archived) => {
    const mutation = gate();
    const archive = mock(async () => {
      await mutation.promise;
    });
    fixture({ archive, unarchive: archive });
    const archiving = setResumableAgentArchived("agent-mutating", archived);
    try {
      await expect(resumeSession("agent-mutating", undefined)).rejects.toThrow(
        "being archived or restored",
      );
      expect(sessions.size).toBe(0);
      expect(await setResumableAgentArchived("agent-mutating", !archived)).toBe("in-use");
      expect(archive).toHaveBeenCalledTimes(1);
    } finally {
      mutation.resolve();
      await archiving;
    }
    // The reservation is released once the SDK settles.
    expect((await resumeSession("agent-mutating", undefined)).agentId).toBe("agent-mutating");
  },
);

test("failed archive releases its reservation", async () => {
  fixture({
    archive: async () => {
      throw new Error("fixture refusal");
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect(await setResumableAgentArchived("agent-refused", true)).toBe("failed");
    expect((await resumeSession("agent-refused", undefined)).agentId).toBe("agent-refused");
  } finally {
    console.warn = warn;
  }
});
