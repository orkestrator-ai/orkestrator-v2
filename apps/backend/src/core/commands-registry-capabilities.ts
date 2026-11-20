/**
 * Agent Capabilities commands (docs/architecture/agent-capabilities-management.md).
 * Each is registered with its `capabilities` definition; every argument is
 * `optionalKey(Unknown)` and `CapabilityService` checks each one. None takes a
 * filesystem path or a command to run.
 *
 * Failures are answered as plain errors whose message is the user-facing
 * reason and whose `code` is the `CapabilityError` code, logged once with a
 * correlation reference and never with arguments or content.
 */
import { randomBytes } from "node:crypto";

import {
  adoptExternalCapabilityCommand,
  answerCapabilityNodeLaunchCommand,
  answerCapabilityNodeRequestCommand,
  applyCapabilityChangeCommand,
  applyCapabilityNodePlanCommand,
  applyCapabilityNodeEnvironmentPlanCommand,
  getCapabilityNodeEnvironmentObservationCommand,
  getCapabilityNodeContainerDeliveryCommand,
  approveCapabilityUpdateCommand,
  assignCapabilitySetupCommand,
  getCapabilityAssignmentCommand,
  authorCapabilityPackageCommand,
  cancelCapabilityOperationCommand,
  deleteCapabilitySetupCommand,
  exportCapabilityNodeItemCommand,
  exportCapabilitySetupCommand,
  getCapabilityInventoryCommand,
  getCapabilityNodeObservationCommand,
  getCapabilityOperationCommand,
  getCapabilityPackageCommand,
  getCapabilitySessionViewCommand,
  getCapabilityTargetSupportCommand,
  getEffectiveAgentResourcesCommand,
  importCapabilitySetupCommand,
  inspectCapabilitySourceCommand,
  listCapabilityActivityCommand,
  listCapabilityDriftCommand,
  listCapabilityMachinesCommand,
  listCapabilityOperationsCommand,
  listCapabilityPackagesCommand,
  listCapabilitySetupsCommand,
  listCapabilityUpdatesCommand,
  manageCapabilityExceptionCommand,
  mergeCapabilityDriftCommand,
  previewCapabilityChangeCommand,
  previewCapabilityImportCommand,
  previewCapabilityUpdateCommand,
  readCapabilityFileCommand,
  refreshCapabilityUpdatesCommand,
  resolveCapabilityDriftCommand,
  rollbackCapabilityPackageCommand,
  setCapabilityMachineEnrollmentCommand,
  setCapabilityPackageStateCommand,
  setCapabilityPluginEnabledCommand,
  setCapabilitySetupCommand,
  setCapabilityUpdatePolicyCommand,
  stageCapabilityNodeArtifactCommand,
  stageCapabilityNodeHandoverCommand,
  verifyAgentCapabilityCommand,
  getCapabilityEnvironmentDeliveryCommand,
  listCapabilityRegistriesCommand,
  setCapabilityRegistryCommand,
  setCapabilityManifestPolicyCommand,
  listCapabilityRegistryPackagesCommand,
  getCapabilityAdminPolicyCommand,
  setCapabilityAdminPolicyCommand,
} from "@orkestrator/protocol/contract/domains/capabilities";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { setCapabilityPluginEnabled } from "./capabilities/index.js";
import { CapabilityError } from "./capabilities/security.js";
import type { CapabilityService } from "./capabilities/service.js";
import type { CommandContext } from "./commands-context.js";
import { wrapRegistrar } from "./commands-registry-contracts.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

const log = createLogger("capabilities");

function capabilities(context: CommandContext): CapabilityService {
  if (!context.capabilities) {
    throw Object.assign(new Error("Capability management is not available on this backend."), {
      code: "unavailable",
    });
  }
  return context.capabilities;
}

function environmentAuthority(
  context: CommandContext,
): NonNullable<CommandContext["capabilityEnvironments"]> {
  if (!context.capabilityEnvironments) {
    throw Object.assign(new Error("Capability management is not available on this backend."), {
      code: "unavailable",
    });
  }
  return context.capabilityEnvironments;
}

/** A user-facing error: the reason the service gave, and its code; anything else is generic. */
function toCommandError(command: string, error: unknown): Error {
  const ref = `cap_${randomBytes(4).toString("hex")}`;
  if (error instanceof CapabilityError) {
    log.info("command.refused", { command, code: error.code, ref });
    return Object.assign(new Error(error.message), { code: error.code, correlationId: ref });
  }
  log.warn("command.failed", { command, ref, error: formatLogError(error, { message: false }) });
  return Object.assign(
    new Error(
      `The capability operation failed (reference ${ref}). See Activity or the backend log.`,
    ),
    { code: "internal", correlationId: ref },
  );
}

function capabilityRegistrar(register: CommandRegistrar): CommandRegistrar {
  return wrapRegistrar(register, (name, handler) => async (args, context, invocation) => {
    try {
      return await handler(args, context, invocation);
    } catch (error) {
      throw toCommandError(name, error);
    }
  });
}

/** The user the call is made for, when the transport names one; never a token. */
function actor(context: CommandContext): string | undefined {
  return context.runtimeFlavor === "agent-test" ? "agent-test" : undefined;
}

export function registerCapabilityCommands(register: CommandRegistrar): void {
  const r = capabilityRegistrar(register);
  // Reads.
  r(listCapabilityPackagesCommand, (args, context) => capabilities(context).listPackages(args));
  r(getCapabilityPackageCommand, (args, context) => capabilities(context).getPackage(args));
  r(readCapabilityFileCommand, (args, context) => capabilities(context).readFile(args));
  r(listCapabilitySetupsCommand, (_args, context) => capabilities(context).listSetups());
  r(getCapabilityInventoryCommand, (args, context) => capabilities(context).getInventory(args));
  r(getCapabilityTargetSupportCommand, (args, context) =>
    capabilities(context).getTargetSupport(args),
  );
  r(getEffectiveAgentResourcesCommand, (args, context) =>
    capabilities(context).getEffectiveResources(args),
  );
  r(getCapabilitySessionViewCommand, (args, context) => capabilities(context).getSessionView(args));
  r(listCapabilityMachinesCommand, (_args, context) => capabilities(context).listMachines());
  r(listCapabilityDriftCommand, (args, context) => capabilities(context).listDrift(args));
  r(listCapabilityActivityCommand, (args, context) => capabilities(context).listActivity(args));
  r(listCapabilityOperationsCommand, (args, context) => capabilities(context).listOperations(args));
  r(getCapabilityOperationCommand, (args, context) => capabilities(context).getOperation(args));
  r(listCapabilityUpdatesCommand, (_args, context) => capabilities(context).listUpdates());
  // Adding and applying.
  r(inspectCapabilitySourceCommand, (args, context) => capabilities(context).inspectSource(args));
  r(authorCapabilityPackageCommand, (args, context) => capabilities(context).authorPackage(args));
  r(previewCapabilityChangeCommand, (args, context) =>
    capabilities(context).previewChange(args, actor(context)),
  );
  r(applyCapabilityChangeCommand, (args, context) =>
    capabilities(context).applyChange(args, actor(context)),
  );
  r(cancelCapabilityOperationCommand, (args, context) =>
    capabilities(context).cancelOperation(args),
  );
  // Setups, exceptions, machines.
  r(setCapabilitySetupCommand, (args, context) =>
    capabilities(context).setSetup(args, actor(context)),
  );
  r(deleteCapabilitySetupCommand, (args, context) =>
    capabilities(context).deleteSetup(args, actor(context)),
  );
  r(assignCapabilitySetupCommand, (args, context) => {
    if (typeof args.expectedRevision !== "number" || !Number.isSafeInteger(args.expectedRevision)) {
      throw new CapabilityError("invalid-request", "Reload the assignment before editing it.");
    }
    return capabilities(context).assignSetup(args, actor(context));
  });
  r(getCapabilityAssignmentCommand, (args, context) => capabilities(context).getAssignment(args));
  r(manageCapabilityExceptionCommand, (args, context) =>
    capabilities(context).manageException(args, actor(context)),
  );
  r(setCapabilityMachineEnrollmentCommand, (args, context) =>
    capabilities(context).setMachineEnrollment(args, actor(context)),
  );
  r(setCapabilityPackageStateCommand, (args, context) =>
    capabilities(context).setPackageState(args, actor(context)),
  );
  r(setCapabilityPluginEnabledCommand, (args, context) =>
    setCapabilityPluginEnabled(context, args),
  );
  r(adoptExternalCapabilityCommand, (args, context) => capabilities(context).adoptExternal(args));
  r(resolveCapabilityDriftCommand, (args, context) =>
    capabilities(context).resolveDrift(args, actor(context)),
  );
  r(mergeCapabilityDriftCommand, (args, context) =>
    capabilities(context).mergeDrift(args, actor(context)),
  );
  // Updates and rollback.
  r(refreshCapabilityUpdatesCommand, (args, context) => capabilities(context).refreshUpdates(args));
  r(previewCapabilityUpdateCommand, (args, context) =>
    capabilities(context).previewUpdate(args, actor(context)),
  );
  r(approveCapabilityUpdateCommand, (args, context) =>
    capabilities(context).approveUpdate(args, actor(context)),
  );
  r(setCapabilityUpdatePolicyCommand, (args, context) =>
    capabilities(context).setUpdatePolicy(args, actor(context)),
  );
  r(rollbackCapabilityPackageCommand, (args, context) =>
    capabilities(context).rollbackPackage(args, actor(context)),
  );
  // Import, export, verification.
  r(exportCapabilitySetupCommand, (args, context) => capabilities(context).exportSetup(args));
  r(previewCapabilityImportCommand, (args, context) => capabilities(context).previewImport(args));
  r(importCapabilitySetupCommand, (args, context) =>
    capabilities(context).importSetup(args, actor(context)),
  );
  r(verifyAgentCapabilityCommand, (args, context) => capabilities(context).verify(args));
  // The command node answers for every machine's environments; a leaf asks its command node.
  r(getCapabilityEnvironmentDeliveryCommand, (args, context) =>
    context.capabilityEnvironments
      ? context.capabilityEnvironments.getEnvironmentDelivery(args)
      : capabilities(context).getEnvironmentDelivery(args),
  );
  // Package registries and the signed-manifest policy.
  r(listCapabilityRegistriesCommand, (_args, context) => capabilities(context).registries.list());
  r(setCapabilityRegistryCommand, (args, context) =>
    capabilities(context).registries.set(args, actor(context)),
  );
  r(setCapabilityManifestPolicyCommand, (args, context) =>
    capabilities(context).registries.setManifestPolicy(args, actor(context)),
  );
  r(listCapabilityRegistryPackagesCommand, (args, context) =>
    capabilities(context).registries.listPackages(args),
  );
  // Administrator policy: forbidden sources and components.
  r(getCapabilityAdminPolicyCommand, (_args, context) => capabilities(context).adminPolicy.get());
  r(setCapabilityAdminPolicyCommand, (args, context) =>
    capabilities(context).adminPolicy.set(args, actor(context)),
  );
  // The executor this machine runs for its command node.
  r(getCapabilityNodeObservationCommand, (args, context) =>
    capabilities(context).executorObserve(args),
  );
  r(stageCapabilityNodeArtifactCommand, (args, context) =>
    capabilities(context).executorStage(args),
  );
  r(applyCapabilityNodePlanCommand, (args, context) => capabilities(context).executorApply(args));
  r(getCapabilityNodeEnvironmentObservationCommand, (args, context) =>
    capabilities(context).executorObserveEnvironments(args),
  );
  r(applyCapabilityNodeEnvironmentPlanCommand, (args, context) =>
    capabilities(context).executorApplyEnvironmentPlan(args),
  );
  r(exportCapabilityNodeItemCommand, (args, context) =>
    capabilities(context).executorExportItem(args),
  );
  // Command-node handover: the old command node sends its state and artifacts here.
  r(stageCapabilityNodeHandoverCommand, (args, context) =>
    capabilities(context).executorStageHandover(args),
  );
  // The command node's answer to this leaf's launch request.
  r(answerCapabilityNodeLaunchCommand, (args, context) =>
    capabilities(context).executorLaunchAnswer(args),
  );
  // The command node's answer to this leaf's container or environment-card request,
  // and this leaf's container records for the command node's environment cards.
  r(answerCapabilityNodeRequestCommand, (args, context) =>
    environmentAuthority(context).receiveAnswer(args),
  );
  r(getCapabilityNodeContainerDeliveryCommand, (args, context) =>
    environmentAuthority(context).containerDeliveryForController(args),
  );
}
