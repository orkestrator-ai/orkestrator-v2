import { randomBytes, randomUUID } from "node:crypto";
import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  createTurnWatch,
  isSignInError,
  transcriptAssistantText,
  turnAnswerResolution,
  type CoordinatorLivePlatformSummary,
  type CoordinatorTurnProjection,
} from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  evaluateIdentityScenario,
  IDENTITY_TABS,
  identityEnvironmentName,
  identityIdleMail,
  identityResumePrompt,
  identityTabPrompt,
  type IdentityProbe,
  type IdentityTabEvidence,
} from "./coordinator-live-identity.js";
import { readToolOutputs, removeLaunchedEnvironments } from "./coordinator-live-observer.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type SessionIdentity = { environmentId: string; agent: AgentPlatform; logicalSessionKey: string };
type MailboxPage = {
  messages?: Array<{ id: string; placement?: string; from?: { kind?: string } }>;
};

/**
 * The identity scenario's backend orchestration, shared by the live spec and
 * the credential-free test that scripts the command transport. See
 * `coordinator-live-identity.ts` for what it qualifies.
 */
export async function runIdentityScenario(input: {
  invoke: Invoke;
  projectId: string;
  platform: AgentPlatform;
  summary: CoordinatorLivePlatformSummary;
  skip: (reason: string) => never;
  cleanup: Array<() => Promise<unknown>>;
  token?: string;
  pollIntervalMs?: number;
}) {
  const { invoke, projectId, platform, summary, skip, cleanup } = input;
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const probe: IdentityProbe = { platform, token: input.token ?? randomBytes(6).toString("hex") };
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const escaped: AgentInteractionKind[] = [];

  let environmentId: string | undefined;
  let first: IdentityTabEvidence | undefined;
  let second: IdentityTabEvidence | undefined;
  let idle: (IdentityTabEvidence & { placement?: string; turnStarted: boolean }) | undefined;
  let resumed: IdentityTabEvidence | undefined;
  let firstProviderSessionId: string | undefined;
  let resumedProviderSessionId: string | undefined;
  let finished: string | undefined;

  const tabIdentity = (tab: string): SessionIdentity => ({
    environmentId: environmentId!,
    agent: platform,
    logicalSessionKey: `env-${environmentId}:${tab}`,
  });
  const projection = (identity: SessionIdentity) =>
    invoke<CoordinatorTurnProjection | null>("get_native_agent_projection", {
      ...identity,
      messageLimit: 200,
    });
  const evidence = async (
    identity: SessionIdentity,
    view: CoordinatorTurnProjection,
    rowsBefore: number,
  ): Promise<IdentityTabEvidence> => {
    const rows = view.messages.slice(rowsBefore);
    return {
      listings: await readToolOutputs(invoke, identity, "list_mailboxes", rows),
      text: transcriptAssistantText(rows),
      turnPhase: view.turn.phase,
      ...(view.turn.error ? { turnError: view.turn.error } : {}),
    };
  };
  /**
   * Waits for a turn on a tab that starts after `rowsBefore`: seen working, or
   * a new assistant row, then idle for two reads. A resumed tab already holds
   * replies, so an old reply never settles it. Any approval or question is
   * denied or cancelled and recorded as escaped. `ready` adds a condition.
   */
  const waitForTabTurn = async (
    identity: SessionIdentity,
    rowsBefore: number,
    label: string,
    ready: () => Promise<boolean> = async () => true,
  ): Promise<CoordinatorTurnProjection> => {
    const turn = createTurnWatch();
    const deadline = Date.now() + coordinatorLiveBudgets().step;
    let sawActive = false;
    let idleReads = 0;
    for (;;) {
      const view = await projection(identity);
      const { answers } = turn.observe(view);
      for (const answer of answers) {
        await invoke("resolve_native_agent_interaction", {
          ...identity,
          interactionId: answer.interactionId,
          resolution: turnAnswerResolution(answer),
        }).catch(() => undefined);
      }
      const phase = view?.turn.phase ?? "idle";
      if (phase !== "idle") sawActive = true;
      idleReads = phase === "idle" ? idleReads + 1 : 0;
      const replied = (view?.messages ?? [])
        .slice(rowsBefore)
        .some((message) => message.role === "assistant");
      if (
        view &&
        (phase === "error" || (idleReads >= 2 && (sawActive || replied) && (await ready())))
      ) {
        escaped.push(...turn.escapedInteractions());
        return view;
      }
      if (Date.now() >= deadline) {
        escaped.push(...turn.escapedInteractions());
        throw new Error(`${platform}: timed out waiting for ${label} (phase ${phase})`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
  /** One harness-sent turn on a tab, settled with nothing answered for it. */
  const tabTurn = async (identity: SessionIdentity, prompt: string, label: string) => {
    const rowsBefore = (await projection(identity))?.messages.length ?? 0;
    await invoke("dispatch_native_agent_intent", {
      ...identity,
      prompt,
      requestId: randomUUID(),
      mode: "build",
    });
    const view = await waitForTabTurn(identity, rowsBefore, label);
    return evidence(identity, view, rowsBefore);
  };
  const providerSession = async (identity: SessionIdentity) =>
    (
      await invoke<{ providerSessionId?: string } | null>(
        "get_native_agent_session",
        identity,
      ).catch(() => null)
    )?.providerSessionId;

  try {
    const environment = await invoke<{ id: string }>("create_environment", {
      projectId,
      name: identityEnvironmentName(probe),
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    environmentId = environment.id;
    await invoke("start_environment", { environmentId });
    // Mailboxes come from the pane layout, so each tab is a layout tab.
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId,
    });
    const tabs = Object.values(IDENTITY_TABS);
    await invoke("save_pane_layout", {
      environmentId,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "identity-pane",
        root: {
          kind: "leaf",
          id: "identity-pane",
          activeTabId: IDENTITY_TABS.first,
          tabs: tabs.map((id, index) => ({
            id,
            type: "agent-native",
            displayTitle: `Identity ${index + 1}`,
            nativeAgentData: { environmentId, platform, isLocal: true },
          })),
        },
      },
    });

    // 1. Each of two tabs sees itself, and only itself, as `self`.
    for (const tab of [IDENTITY_TABS.first, IDENTITY_TABS.second]) {
      try {
        await invoke("ensure_native_agent_session", tabIdentity(tab));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSignInError(message)) {
          skip(`no usable ${platform} credential in this profile: ${message.slice(0, 300)}`);
        }
        throw error;
      }
    }
    first = await tabTurn(
      tabIdentity(IDENTITY_TABS.first),
      identityTabPrompt(probe, IDENTITY_TABS.first),
      "the first tab's turn",
    );
    second = await tabTurn(
      tabIdentity(IDENTITY_TABS.second),
      identityTabPrompt(probe, IDENTITY_TABS.second),
      "the second tab's turn",
    );

    // 2. With the second tab on `idle`, mail sent as the user starts a turn.
    // User mail follows the tab's policy alone; under the default `off` it is held.
    const target = tabIdentity(IDENTITY_TABS.second);
    await invoke("mute_agent_mail", {
      environmentId,
      tabId: IDENTITY_TABS.second,
      inject: "idle",
    });
    cleanup.push(() =>
      invoke("mute_agent_mail", { environmentId, tabId: IDENTITY_TABS.second, inject: "inherit" }),
    );
    const rowsBefore = (await projection(target))?.messages.length ?? 0;
    const sent = await invoke<{ id: string }>("send_agent_mail", {
      requestId: randomUUID(),
      toEnvironmentId: environmentId,
      toTabId: IDENTITY_TABS.second,
      body: identityIdleMail(probe),
    });
    let placement: string | undefined;
    const view = await waitForTabTurn(
      target,
      rowsBefore,
      "the idle-policy mail's turn",
      async () => {
        const mailbox = await invoke<MailboxPage>("get_agent_mail_mailbox", {
          environmentId,
          tabId: IDENTITY_TABS.second,
          limit: 200,
        }).catch(() => ({ messages: [] }) as MailboxPage);
        placement = mailbox.messages?.find((message) => message.id === sent.id)?.placement;
        return placement === "injected";
      },
    ).catch((error: unknown) => {
      idle = {
        listings: [],
        text: "",
        turnPhase: "unknown",
        turnStarted: false,
        ...(placement ? { placement } : {}),
      };
      throw error;
    });
    const turnStarted = view.messages.length > rowsBefore;
    idle = {
      ...(await evidence(target, view, rowsBefore)),
      ...(placement ? { placement } : {}),
      turnStarted,
    };

    // 3. The first conversation, resumed in the third tab under its own credential.
    firstProviderSessionId = await providerSession(tabIdentity(IDENTITY_TABS.first));
    if (!firstProviderSessionId) throw new Error("the first tab has no provider session");
    await invoke("resume_native_agent_session", {
      ...tabIdentity(IDENTITY_TABS.resumed),
      providerSessionId: firstProviderSessionId,
    });
    resumed = await tabTurn(
      tabIdentity(IDENTITY_TABS.resumed),
      identityResumePrompt(),
      "the resumed tab's turn",
    );
    resumedProviderSessionId = await providerSession(tabIdentity(IDENTITY_TABS.resumed));
  } catch (error) {
    if (summary.verdict === "skipped") throw error;
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
  if (escaped.length > 0) summary.escapedInteractions = [...escaped];

  const verdict = evaluateIdentityScenario({
    probe,
    ...(environmentId ? { environmentId } : {}),
    ...(first ? { first } : {}),
    ...(second ? { second } : {}),
    ...(idle ? { idle } : {}),
    ...(resumed ? { resumed } : {}),
    ...(firstProviderSessionId ? { firstProviderSessionId } : {}),
    ...(resumedProviderSessionId ? { resumedProviderSessionId } : {}),
    escapedInteractions: escaped,
  });
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...verdict.checks,
  ];
  return { checks, observed: verdict.observed, probe, environmentId };
}
