import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  FAMILY_DONE_MARKER,
  asyncBusyPrompt,
  asyncQueuedPrompt,
  type DelegationProbe,
  type DelegationMailMessage,
} from "./coordinator-live-delegation.js";
import { transcriptAssistantText } from "./coordinator-live.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  type createDelegationWatch,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";

type Watch = ReturnType<typeof createDelegationWatch>;

/** Gate/queue ordering shared by the live case and credential-free orchestration tests. */
export async function deliverAsyncReport(input: {
  coordinator: DelegationCoordinator;
  watch: Watch;
  probe: DelegationProbe;
  fromReporter: (message: DelegationMailMessage) => boolean;
}): Promise<boolean> {
  const { coordinator, watch, probe, fromReporter } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  // 3. Busy coordinator, queued prompt, pending report. The reporter sends
  // its report first and parks again, so once the finish gate opens it has
  // only to end its turn while the busy turn runs.
  await writeFile(probe.gatePath, "open\n", { mode: 0o600 });
  await watch.until("the reporter's held report", (observation) => {
    const reports = observation.mail.filter(fromReporter);
    return reports.length >= 2 && reports.every((message) => message.placement === "inject-held");
  });
  const rowsBefore = watch.projection()?.messages.length ?? 0;
  await invoke("dispatch_native_agent_intent", {
    ...identity,
    prompt: asyncBusyPrompt(probe, projectId),
    requestId: randomUUID(),
    mode: "build",
  });
  await watch.until(
    "the busy turn to start",
    (observation) =>
      observation.coordinatorPhase !== "idle" ||
      (watch.projection()?.messages.length ?? 0) > rowsBefore,
  );
  await invoke("enqueue_prompt_queue_message", {
    queueKey: `${platform}\0${identity.logicalSessionKey}`,
    environmentId: identity.environmentId,
    message: { id: randomUUID(), text: asyncQueuedPrompt(probe), mode: "build" },
  });

  await writeFile(probe.finishGatePath, "open\n", { mode: 0o600 });

  // 4. The report: held until the reporter's turn ends, then one carrier.
  let settledReads = 0;
  await watch.until("the reporter's report to be delivered", (observation) => {
    const reports = observation.mail.filter(fromReporter);
    const delivered =
      reports.length >= 2 && reports.every((message) => message.placement === "injected");
    settledReads =
      delivered && observation.coordinatorPhase === "idle" && observation.queueLength === 0
        ? settledReads + 1
        : 0;
    return settledReads >= 2;
  });

  return true;
}

export async function finishFamilyExchange(
  watch: Watch,
  probe: DelegationProbe,
  secondWorkerName: string,
): Promise<void> {
  // The second worker is parked on its gate inside its first turn. Its
  // report waits until the coordinator's follow-up is seen held for it
  // there, so the follow-up is the busy case rather than an early prompt.
  const two = () => watch.workers.find((id) => watch.workerName(id) === secondWorkerName);
  await watch
    .until("the follow-up to reach the busy second worker", (observation) => {
      const id = two();
      const phase = id ? observation.workerPhases?.[id] : undefined;
      return (
        id !== undefined &&
        phase !== undefined &&
        phase !== "idle" &&
        observation.mail.some(
          (message) =>
            message.toEnvironmentId === id &&
            message.from.kind === "coordinator" &&
            message.placement !== "injected",
        )
      );
    })
    .finally(() => writeFile(probe.gatePath, "open\n", { mode: 0o600 }));
  let quietReads = 0;
  await watch.until(
    "the family exchange to finish",
    (observation) => {
      const done = transcriptAssistantText(watch.projection()?.messages ?? []).includes(
        FAMILY_DONE_MARKER,
      );
      const busyWorkers = watch.workers.some((id) => {
        const phase = watch.workerPhase(id);
        return phase !== "idle" && phase !== "unknown";
      });
      const pending = observation.mail.some(
        (message) => message.placement === "pending-inject" || message.placement === "inject-held",
      );
      quietReads =
        done && observation.coordinatorPhase === "idle" && !busyWorkers && !pending
          ? quietReads + 1
          : 0;
      return quietReads >= 2;
    },
    coordinatorLiveBudgets().family,
  );
}
