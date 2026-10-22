import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import {
  isSignInError,
  type CoordinatorLiveCheck,
  type CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  PeerSignInError,
  createPeerWatch,
  evaluatePeerScenario,
  peerEnvironmentInput,
  peerEnvironmentNames,
  peerExchangeFinished,
  peerOpenerPrompt,
  peerResponderPrompt,
  type PeerProbe,
} from "./coordinator-live-peer.js";
import { removeLaunchedEnvironments } from "./coordinator-live-observer.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Backend orchestration shared by the live spec and credential-free tests. */
export async function runPeerScenario(input: {
  invoke: Invoke;
  projectId: string;
  probe: PeerProbe;
  skip: (reason: string) => never;
  cleanup: Array<() => Promise<unknown>>;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  log?: (line: string) => void;
}) {
  const { invoke, projectId, probe, skip, cleanup } = input;
  const { platform } = probe;
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const enabled = config.global.enabledAgentPlatforms;
  if (Array.isArray(enabled) && !enabled.includes(platform)) {
    skip(`${platform} is not enabled in this profile (start it with --agent-platforms)`);
  }

  // Wake peers is off by default; the scenario is about the route it opens.
  const previous = await invoke<Record<string, unknown>>("get_agent_messaging_settings");
  cleanup.push(() => invoke("update_agent_messaging_settings", { settings: previous }));
  await invoke("update_agent_messaging_settings", { settings: { ...previous, wakePeers: true } });
  await removeLaunchedEnvironments(invoke, projectId, cleanup);

  const names = peerEnvironmentNames(probe);
  const launch = async (name: string, prompt: string) => {
    const environment = await invoke<{ id: string }>(
      "create_environment",
      peerEnvironmentInput({ projectId, name, platform, prompt }),
    );
    await invoke("start_environment", { environmentId: environment.id });
    return environment.id;
  };
  const watch = createPeerWatch({
    invoke,
    platform,
    peers: [],
    pollIntervalMs: input.pollIntervalMs,
    log: input.log,
  });
  let responder: string | undefined;
  let finished: string | undefined;
  let opener: string | undefined;
  try {
    responder = await launch(names.responder, peerResponderPrompt(probe));
    watch.add({ environmentId: responder });
    // The responder's startup turn ends before the first message is sent, so
    // that message has to wake an idle tab.
    let idleReads = 0;
    await watch.until(
      "the responder's startup turn",
      (observation) => {
        idleReads = observation.phases[responder!] === "idle" ? idleReads + 1 : 0;
        const replied = watch
          .projection(responder!)
          ?.messages.some((message) => message.role === "assistant");
        return idleReads >= 2 && replied === true;
      },
      input.startupTimeoutMs ?? coordinatorLiveBudgets().step,
    );
    opener = await launch(names.opener, peerOpenerPrompt(probe, responder));
    watch.add({ environmentId: opener });
    let quietReads = 0;
    await watch.until("the peer exchange to finish", (observation) => {
      quietReads = peerExchangeFinished(observation, watch.projection(opener!)?.messages ?? [])
        ? quietReads + 1
        : 0;
      return quietReads >= 2;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PeerSignInError || isSignInError(message)) {
      skip(`no usable ${platform} credential in this profile (${message.slice(0, 300)})`);
    }
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error);
  }

  const settings = await invoke<Record<string, unknown>>("get_agent_messaging_settings");
  const mail = await watch.mailWithBodies();
  const transcripts: Record<string, CoordinatorTranscriptMessage[]> = {};
  for (const environmentId of [opener, responder]) {
    if (!environmentId) continue;
    transcripts[environmentId] = watch.projection(environmentId)?.messages ?? [];
  }
  const escaped = watch.escaped();
  const checks: CoordinatorLiveCheck[] = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...evaluatePeerScenario({
      probe,
      ...(responder ? { responder: { environmentId: responder } } : {}),
      ...(opener ? { opener: { environmentId: opener } } : {}),
      settings,
      defaults: DEFAULT_AGENT_MESSAGING_SETTINGS,
      mail,
      transcripts,
      escapedInteractions: escaped,
      harnessPrompts: 0,
    }),
  ];
  return { checks, transcripts, escaped, mail, observations: watch.observations };
}
