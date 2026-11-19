/**
 * The command node's transport to the machines it controls: the three
 * executor commands over each node link, with the single-writer epoch on
 * every call. Artifacts travel in bounded chunks and are verified by the
 * receiving machine before anything is installed.
 */
import type {
  AnyCommandDef,
  EncodedArgsOf,
  EncodedResultOf,
} from "@orkestrator/protocol/contract/command";
import {
  applyCapabilityNodePlanCommand,
  getCapabilityNodeObservationCommand,
  stageCapabilityNodeArtifactCommand,
} from "@orkestrator/protocol/contract/domains/capabilities";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";

import { assertDistributableArtifact } from "./source-inspection.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import type { NodePlanResult, NodePlanTarget } from "./executor.js";
import {
  NodeOfflineError,
  classifyTransportError,
  type CapabilityNodeTransport,
} from "./reconciler.js";
import { CapabilityError } from "./security.js";

export interface CapabilityLink {
  readonly connected: boolean;
  invokeCommand<C extends AnyCommandDef>(
    def: C,
    args: EncodedArgsOf<C>,
  ): Promise<EncodedResultOf<C>>;
}

export function remoteTransport(input: {
  selfId(): Promise<string>;
  link(nodeId: string): CapabilityLink | null;
  artifacts: CapabilityArtifactStore;
}): CapabilityNodeTransport {
  const connectedLink = (nodeId: string): CapabilityLink => {
    const link = input.link(nodeId);
    if (!link?.connected) throw new NodeOfflineError();
    return link;
  };
  return {
    async observe(nodeId, epoch) {
      const link = connectedLink(nodeId);
      const controllerId = await input.selfId();
      try {
        const inventory = (await link.invokeCommand(getCapabilityNodeObservationCommand, {
          controllerId,
          epoch,
        })) as unknown as CapabilityInventory;
        return { ...inventory, nodeId };
      } catch (error) {
        const classified = classifyTransportError(error, getCapabilityNodeObservationCommand.name);
        // An observation is a read: an unanswered one means "not reachable now".
        if (classified instanceof CapabilityError) throw classified;
        if (classified.name === "OutcomeUnknownError") throw new NodeOfflineError();
        throw classified;
      }
    },
    async stage(nodeId, epoch, digest) {
      const link = connectedLink(nodeId);
      const controllerId = await input.selfId();
      const files = await input.artifacts.get(digest);
      assertDistributableArtifact(files);
      const chunks = CapabilityArtifactStore.bundleChunks(files);
      for (let index = 0; index < chunks.length; index += 1) {
        try {
          const answer = (await link.invokeCommand(stageCapabilityNodeArtifactCommand, {
            controllerId,
            epoch,
            digest,
            index,
            count: chunks.length,
            data: chunks[index]!,
          })) as { complete?: unknown };
          // The machine already holds the digest: nothing more to send.
          if (answer?.complete === true) return;
        } catch (error) {
          throw classifyTransportError(error, stageCapabilityNodeArtifactCommand.name);
        }
      }
      throw new CapabilityError(
        "source-unavailable",
        "The machine did not confirm the package files.",
      );
    },
    async apply(nodeId, epoch, operationId, targets) {
      const link = connectedLink(nodeId);
      const controllerId = await input.selfId();
      try {
        const answer = (await link.invokeCommand(applyCapabilityNodePlanCommand, {
          controllerId,
          epoch,
          operationId,
          targets: targets as unknown as never,
        })) as { results?: unknown };
        if (!Array.isArray(answer?.results)) throw new Error("malformed answer");
        return answer.results as NodePlanResult[];
      } catch (error) {
        throw classifyTransportError(error, applyCapabilityNodePlanCommand.name);
      }
    },
  };
}

/** Routes each call to this machine's own transport or to the remote one. */
export function routedTransport(input: {
  selfId(): Promise<string>;
  local: CapabilityNodeTransport;
  remote: CapabilityNodeTransport;
}): CapabilityNodeTransport {
  const pick = async (nodeId: string) =>
    (await input.selfId()) === nodeId ? input.local : input.remote;
  return {
    observe: async (nodeId, epoch) => (await pick(nodeId)).observe(nodeId, epoch),
    stage: async (nodeId, epoch, digest) => (await pick(nodeId)).stage(nodeId, epoch, digest),
    apply: async (nodeId, epoch, operationId, targets: NodePlanTarget[]) =>
      (await pick(nodeId)).apply(nodeId, epoch, operationId, targets),
  };
}
