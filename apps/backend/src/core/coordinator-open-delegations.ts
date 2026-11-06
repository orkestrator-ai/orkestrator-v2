import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import type { CoordinatorsStorage } from "./storage-coordinators.js";

/** One open delegation as it stands now, or undefined once it has closed. */
export type OpenDelegationLookup = (
  id: string,
) => Promise<CoordinatorWorkflowAssociation | undefined>;

type Coordinators = Pick<
  CoordinatorsStorage,
  "readOpenCoordinatorDelegations" | "coordinatorStoreRevision" | "listOpenCoordinatorDelegations"
>;

/**
 * The open delegations as one read, and a way to re-check one of them under
 * its worker's admission lock. The re-check matters (a turn end, a stop or a
 * follow-up may have changed it since the read) but reads the store again
 * only when its revision has moved, so a sweep that changes nothing reads it
 * once rather than once per delegation, and one that closes some reads it
 * again only after each change.
 */
export async function readOpenDelegations(
  coordinators: Coordinators,
): Promise<{ list: CoordinatorWorkflowAssociation[]; current: OpenDelegationLookup }> {
  let read = await coordinators.readOpenCoordinatorDelegations();
  let byId = new Map(read.open.map((association) => [association.id, association]));
  return {
    list: read.open,
    current: async (id) => {
      if (read.revision === null || coordinators.coordinatorStoreRevision() !== read.revision) {
        read = await coordinators.readOpenCoordinatorDelegations();
        byId = new Map(read.open.map((association) => [association.id, association]));
      }
      return byId.get(id);
    },
  };
}

/** The open delegation with this id, read now: for a caller outside the sweep. */
export function currentOpenDelegation(coordinators: Coordinators): OpenDelegationLookup {
  return async (id) =>
    (await coordinators.listOpenCoordinatorDelegations()).find((item) => item.id === id);
}
