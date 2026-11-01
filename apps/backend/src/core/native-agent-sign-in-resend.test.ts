import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import {
  latestExchangeIsLoginRefusal,
  NativeAgentSignInResends,
  signInResendRequestId,
} from "./native-agent-sign-in-resend.js";
import type { DispatchNativeAgentPromptInput } from "./native-agent-service-shared.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import type { PersistedNativeAgentSession } from "./models.js";
import { StorageService } from "./storage.js";

const NOTICE = "Not logged in · Please run /login";
const ENVIRONMENT = "env-1";
const LOGICAL = `env-${ENVIRONMENT}:tab-1`;
const KEY = nativeAgentSessionStorageKey(ENVIRONMENT, "claude", LOGICAL);
const PROVIDER_SESSION = "claude-session";

const refusedRows = [
  { id: "user-1", role: "user", content: "Fix the build" },
  { id: "assistant-1", role: "assistant", content: NOTICE },
];

const INPUT: DispatchNativeAgentPromptInput = {
  environmentId: ENVIRONMENT,
  agent: "claude",
  logicalSessionKey: LOGICAL,
  prompt: "Fix the build",
  requestId: "request-1",
  attachments: [{ type: "image", path: "/workspace/screen.png", filename: "screen.png" }],
  model: "claude-sonnet",
  mode: "build",
};

async function withResends(
  run: (context: {
    resends: NativeAgentSignInResends;
    storage: StorageService;
    dispatch: ReturnType<typeof mock<(input: DispatchNativeAgentPromptInput) => Promise<void>>>;
    setRows: (rows: unknown[]) => void;
    session: () => Promise<PersistedNativeAgentSession>;
    settle: () => Promise<void>;
  }) => Promise<void>,
  options: { environment?: Record<string, unknown>; hostCredentials?: boolean } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-sign-in-resend-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: ENVIRONMENT,
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...options.environment,
  } as never);
  if (options.hostCredentials === false) {
    const config = await storage.loadConfig();
    await storage.saveConfig({
      ...config,
      global: { ...config.global, useHostClaudeCredentials: false },
    });
  }
  await storage.getOrCreateNativeAgentSession(
    {
      key: KEY,
      environmentId: ENVIRONMENT,
      agent: "claude",
      logicalSessionKey: LOGICAL,
      origin: "interactive-native",
    },
    async () => PROVIDER_SESSION,
  );
  await storage.dispatchNativeAgentPromptOnce(KEY, "request-1", async () => undefined);
  let rows: unknown[] = refusedRows;
  const provider = {
    messages: async () => rows,
  } as unknown as NativeAgentRuntimeProvider;
  const dispatch = mock(async (_input: DispatchNativeAgentPromptInput) => undefined);
  const tracked: Promise<void>[] = [];
  const resends = new NativeAgentSignInResends({
    storage,
    now: () => Date.parse("2026-11-01T00:00:00.000Z"),
    provider: async () => provider,
    observeProvider: async () => provider,
    dispatch,
    trackScan: (task) => tracked.push(task),
  });
  const session = async () => (await storage.getNativeAgentSession(KEY))!;
  try {
    await run({
      resends,
      storage,
      dispatch: dispatch as never,
      setRows: (next) => {
        rows = next;
      },
      session,
      settle: async () => {
        await Promise.all(tracked);
      },
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("latestExchangeIsLoginRefusal", () => {
  test("the notice answering the newest user message", () => {
    expect(latestExchangeIsLoginRefusal(refusedRows)).toBe(true);
  });

  test("text parts count, and punctuation variants match", () => {
    expect(
      latestExchangeIsLoginRefusal([
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          parts: [{ type: "text", content: "Not logged in - please run /login." }],
        },
      ]),
    ).toBe(true);
  });

  test("not when anything follows it, it merely mentions logging in, or there is no prompt", () => {
    expect(latestExchangeIsLoginRefusal([...refusedRows, { role: "user", content: "again" }])).toBe(
      false,
    );
    expect(
      latestExchangeIsLoginRefusal([
        { role: "user", content: "x" },
        { role: "assistant", content: `The tool said: ${NOTICE}` },
      ]),
    ).toBe(false);
    expect(latestExchangeIsLoginRefusal([{ role: "assistant", content: NOTICE }])).toBe(false);
  });
});

describe("holding a refused prompt", () => {
  test("records it durably when the turn ends in the notice", async () => {
    await withResends(async ({ resends, session, settle }) => {
      resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
      resends.noteTurnEnded(await session());
      await settle();

      expect((await session()).signInResend).toMatchObject({
        requestId: "request-1",
        providerSessionId: PROVIDER_SESSION,
        prompt: "Fix the build",
        attachments: INPUT.attachments,
        model: "claude-sonnet",
        mode: "build",
      });
    });
  });

  test("records nothing for a turn Claude answered", async () => {
    await withResends(async ({ resends, setRows, session, settle }) => {
      setRows([refusedRows[0], { id: "a", role: "assistant", content: "Fixed." }]);
      resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
      resends.noteTurnEnded(await session());
      await settle();
      expect((await session()).signInResend).toBeUndefined();
      await expect(
        resends.status({ environmentId: ENVIRONMENT, agent: "claude", logicalSessionKey: LOGICAL }),
      ).resolves.toEqual({ pending: false });
    });
  });

  test("a client asking first still gets the honest answer, and records it", async () => {
    await withResends(async ({ resends, session }) => {
      resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
      await expect(
        resends.status({ environmentId: ENVIRONMENT, agent: "claude", logicalSessionKey: LOGICAL }),
      ).resolves.toEqual({ pending: true });
      expect((await session()).signInResend?.requestId).toBe("request-1");
      await expect(
        resends.status({ environmentId: ENVIRONMENT, agent: "claude", logicalSessionKey: LOGICAL }),
      ).resolves.toEqual({ pending: true });
    });
  });

  test("never holds a command, a non-Claude or non-interactive session, or an image", async () => {
    await withResends(async ({ resends, session, settle }) => {
      const base = await session();
      const notHeld = async (
        target: PersistedNativeAgentSession,
        input: DispatchNativeAgentPromptInput,
        literalPrompt: boolean,
      ) => {
        resends.remember(target, input, input.prompt, { literalPrompt });
        resends.noteTurnEnded(await session());
        await settle();
        expect((await session()).signInResend).toBeUndefined();
      };
      await notHeld(base, INPUT, false);
      await notHeld({ ...base, agent: "codex" }, INPUT, true);
      await notHeld({ ...base, origin: "build-pipeline" }, INPUT, true);
      await notHeld(
        base,
        { ...INPUT, images: [{ filename: "a.png", data: "aGk=", mimeType: "image/png" }] as never },
        true,
      );
      await notHeld(base, { ...INPUT, prompt: "x".repeat(1_000_001) }, true);
      await notHeld(
        base,
        {
          ...INPUT,
          attachments: [
            {
              type: "image",
              path: "/workspace/a.png",
              dataUrl: `data:image/png;base64,${"x".repeat(1_000_001)}`,
            },
          ],
        },
        true,
      );
    });
  });

  test("a container with its own login is not held: this sign-in cannot reach it", async () => {
    await withResends(
      async ({ resends, session, settle }) => {
        resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
        resends.noteTurnEnded(await session());
        await settle();
        expect((await session()).signInResend).toBeUndefined();
      },
      { environment: { environmentType: "container", containerId: "c1" }, hostCredentials: false },
    );
  });

  test("an accepted later dispatch clears the hold in the journal's own write", async () => {
    await withResends(async ({ resends, storage, session, settle }) => {
      resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
      resends.noteTurnEnded(await session());
      await settle();
      await storage.dispatchNativeAgentPromptOnce(KEY, "request-2", async () => undefined);
      const updated = await session();
      expect(updated.signInResend).toBeUndefined();
      expect(updated.dispatchedRequestIds?.at(-1)).toBe("request-2");
    });
  });
});

describe("sending it again after a sign-in", () => {
  async function hold(
    resends: NativeAgentSignInResends,
    session: () => Promise<PersistedNativeAgentSession>,
    settle: () => Promise<void>,
  ) {
    resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
    resends.noteTurnEnded(await session());
    await settle();
  }

  test("dispatches the same prompt once, under an id derived from the refused one", async () => {
    await withResends(async ({ resends, dispatch, session, settle }) => {
      await hold(resends, session, settle);
      await expect(resends.resendHeldPrompts()).resolves.toBe(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]![0]).toMatchObject({
        environmentId: ENVIRONMENT,
        agent: "claude",
        logicalSessionKey: LOGICAL,
        prompt: "Fix the build",
        requestId: signInResendRequestId("request-1"),
        attachments: INPUT.attachments,
        model: "claude-sonnet",
        mode: "build",
      });
      expect((await session()).signInResend).toBeUndefined();

      // A second sign-in finds nothing, so one refusal is sent at most once.
      await expect(resends.resendHeldPrompts()).resolves.toBe(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  test("the identity is stable, so two attempts can never be two turns", () => {
    expect(signInResendRequestId("request-1")).toBe(signInResendRequestId("request-1"));
    expect(signInResendRequestId("request-1")).not.toBe("request-1");
  });

  test("a failed resend is not retried; the user sees the card and resends", async () => {
    await withResends(async ({ resends, dispatch, session, settle }) => {
      await hold(resends, session, settle);
      dispatch.mockRejectedValueOnce(new Error("Response was lost"));
      const warn = console.warn;
      console.warn = () => {};
      try {
        await expect(resends.resendHeldPrompts()).resolves.toBe(0);
      } finally {
        console.warn = warn;
      }
      expect((await session()).signInResend).toBeUndefined();
      await expect(resends.resendHeldPrompts()).resolves.toBe(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  test("drops the hold when the refusal is no longer the session's last word", async () => {
    await withResends(async ({ resends, dispatch, setRows, session, settle }) => {
      await hold(resends, session, settle);
      setRows([...refusedRows, { id: "user-2", role: "user", content: "never mind" }]);
      await expect(resends.resendHeldPrompts()).resolves.toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await session()).signInResend).toBeUndefined();
    });
  });

  test("never sends over a message the user has started since", async () => {
    await withResends(async ({ resends, storage, dispatch, session, settle }) => {
      await hold(resends, session, settle);
      await storage.saveComposeDraft(
        `claude:${ENVIRONMENT}:${encodeURIComponent(LOGICAL)}`,
        "environment",
        ENVIRONMENT,
        { text: "Something else", mentions: [], attachments: [] },
      );
      await expect(resends.resendHeldPrompts()).resolves.toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await session()).signInResend).toBeUndefined();
    });
  });

  test("a stopped environment keeps the hold for a later sign-in", async () => {
    await withResends(async ({ resends, storage, dispatch, session, settle }) => {
      await hold(resends, session, settle);
      await storage.updateEnvironment(ENVIRONMENT, { status: "stopped" });
      await expect(resends.resendHeldPrompts()).resolves.toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await session()).signInResend?.requestId).toBe("request-1");
    });
  });

  test("a refusal whose turn-end edge has not run yet still goes out", async () => {
    await withResends(async ({ resends, dispatch, session }) => {
      resends.remember(await session(), INPUT, "Fix the build", { literalPrompt: true });
      await expect(resends.resendHeldPrompts()).resolves.toBe(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
