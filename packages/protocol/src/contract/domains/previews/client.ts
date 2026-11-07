/**
 * The `previews` domain client (plan item 7004; §11.2 "Client adapters").
 *
 * Previews were never gated by version, only by whether the backend has the
 * preview commands at all (`get_preview_capabilities` answering
 * `unknown-command`, `isUnknownPreviewCommandError`), and they keep their own
 * response-level versioning: `protocolVersion`, per-surface availability and
 * the backend epoch in `get_preview_capabilities`, the registry revision in
 * every snapshot. So both adapters offer the same calls:
 *
 * - **Version 1** sends the envelope (the critical `operationId`,
 *   `expectedRevision` and `serviceId` keys) and decodes each result with its
 *   command's schema. A node that advertises the domain has every command.
 * - **Version 0**, for a pre-contract node, is today's call: the command by
 *   name without an envelope, its answer not decoded, so an older backend's
 *   shapes are taken as they always were and the callers' own checks
 *   (`isUnknownPreviewCommandError`, the store's capability validation) keep
 *   working.
 *
 * `get_preview_capabilities` stays registered and is still read on every
 * version: it reports runtime state (the access kill switch, which surfaces
 * are listening), not support.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `previews` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  createPreviewAttachmentCommand,
  createPreviewHandoffUrlCommand,
  getPreviewCapabilitiesCommand,
  getPreviewDiagnosticsCommand,
  getPreviewPublicOriginCommand,
  getPreviewServicesCommand,
  getPreviewSettingsCommand,
  probePreviewServiceCommand,
  recordPreviewClientMetricsCommand,
  registerPreviewServiceCommand,
  releasePreviewAttachmentCommand,
  removePreviewServiceCommand,
  renewPreviewAttachmentCommand,
  resolvePreviewTargetCommand,
  revokePreviewAccessCommand,
  updatePreviewServiceCommand,
  updatePreviewSettingsCommand,
} from "./commands.js";
import { previewsDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

/** One method per `previews` command; the arguments are the command's wire arguments. */
export interface PreviewsApi {
  capabilities: Call<typeof getPreviewCapabilitiesCommand>;
  services: Call<typeof getPreviewServicesCommand>;
  register: Call<typeof registerPreviewServiceCommand>;
  update: Call<typeof updatePreviewServiceCommand>;
  remove: Call<typeof removePreviewServiceCommand>;
  resolveTarget: Call<typeof resolvePreviewTargetCommand>;
  probe: Call<typeof probePreviewServiceCommand>;
  createAttachment: Call<typeof createPreviewAttachmentCommand>;
  renewAttachment: Call<typeof renewPreviewAttachmentCommand>;
  releaseAttachment: Call<typeof releasePreviewAttachmentCommand>;
  createHandoffUrl: Call<typeof createPreviewHandoffUrlCommand>;
  publicOrigin: Call<typeof getPreviewPublicOriginCommand>;
  revokeAccess: Call<typeof revokePreviewAccessCommand>;
  diagnostics: Call<typeof getPreviewDiagnosticsCommand>;
  recordClientMetrics: Call<typeof recordPreviewClientMetricsCommand>;
  settings: Call<typeof getPreviewSettingsCommand>;
  updateSettings: Call<typeof updatePreviewSettingsCommand>;
}

type Send = <C extends AnyCommandDef>(def: C, args: ArgsOf<C>) => Promise<ResultOf<C>>;

function previewsApi(send: Send): PreviewsApi {
  return {
    capabilities: (args) => send(getPreviewCapabilitiesCommand, args),
    services: (args) => send(getPreviewServicesCommand, args),
    register: (args) => send(registerPreviewServiceCommand, args),
    update: (args) => send(updatePreviewServiceCommand, args),
    remove: (args) => send(removePreviewServiceCommand, args),
    resolveTarget: (args) => send(resolvePreviewTargetCommand, args),
    probe: (args) => send(probePreviewServiceCommand, args),
    createAttachment: (args) => send(createPreviewAttachmentCommand, args),
    renewAttachment: (args) => send(renewPreviewAttachmentCommand, args),
    releaseAttachment: (args) => send(releasePreviewAttachmentCommand, args),
    createHandoffUrl: (args) => send(createPreviewHandoffUrlCommand, args),
    publicOrigin: (args) => send(getPreviewPublicOriginCommand, args),
    revokeAccess: (args) => send(revokePreviewAccessCommand, args),
    diagnostics: (args) => send(getPreviewDiagnosticsCommand, args),
    recordClientMetrics: (args) => send(recordPreviewClientMetricsCommand, args),
    settings: (args) => send(getPreviewSettingsCommand, args),
    updateSettings: (args) => send(updatePreviewSettingsCommand, args),
  };
}

/** Version 1: typed calls with the envelope, results decoded. */
export function previewsApiV1(call: CommandCall): PreviewsApi {
  return previewsApi(call);
}

/** Version 0: today's untyped call, without an envelope or decoding (see the module comment). */
export function previewsApiLegacy(_call: CommandCall, context: DomainAdapterContext): PreviewsApi {
  return previewsApi(
    <C extends AnyCommandDef>(def: C, args: ArgsOf<C>) =>
      context.invoke(def.name, args as Readonly<Record<string, unknown>>) as Promise<ResultOf<C>>,
  );
}

export const previewsClient = domainClient(previewsDomain, {
  1: previewsApiV1,
  0: previewsApiLegacy,
});
