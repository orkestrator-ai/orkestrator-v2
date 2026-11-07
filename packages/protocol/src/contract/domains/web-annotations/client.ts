/**
 * The `web-annotations` domain client (plan item 7004; §11.2 "Client
 * adapters"). The renderer's one funnel (`webAnnotationCommand` in
 * `apps/web/src/lib/web-annotations/client.ts`) calls every command through
 * `run(command, args)`, keyed by the command name.
 *
 * - **Version 1** sends the envelope (`expectedResultRevision` on
 *   `web_annotation_resolve`, `textOnly` and `retargetOf` on
 *   `web_annotation_request_prepare` are critical) and decodes each result
 *   with the command's schema.
 * - **Version 0**, for a pre-contract backend, is today's call: the same
 *   command by name, no envelope, and the result as the backend sent it (an
 *   older backend's older result shapes are never refused). Support is gated
 *   as before, by `web_annotations_capabilities` and its contract version,
 *   which the renderer reads per environment because it also carries runtime
 *   state (storage health, rollout mode) that a per-generation cache would
 *   hold stale.
 *
 * Every build that advertises the domain speaks web annotation contract
 * version 1 (`WEB_ANNOTATION_CONTRACT_VERSION`), so on version 1 the
 * capability answer gates only runtime state, not support.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `web-annotations` domain.
 *
 * Browser-safe.
 */
import type {
  WebAnnotationCommandArgs,
  WebAnnotationCommandResults,
} from "../../../web-annotations.js";
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { ArgsOf } from "../../command.js";
import {
  WEB_ANNOTATIONS_COMMAND_BY_NAME,
  type WebAnnotationsCommandDef,
  type WebAnnotationsCommandName,
} from "./commands.js";
import { webAnnotationsDomain } from "./domain.js";

export interface WebAnnotationsApi {
  /** The adapter version this API was built for (0: a pre-contract backend). */
  readonly version: number;
  /** Runs one web annotation command with its arguments. */
  run<N extends WebAnnotationsCommandName>(
    command: N,
    args: WebAnnotationCommandArgs[N],
  ): Promise<WebAnnotationCommandResults[N]>;
}

function definition(command: WebAnnotationsCommandName): WebAnnotationsCommandDef {
  const def = WEB_ANNOTATIONS_COMMAND_BY_NAME[command];
  if (!def) throw new Error(`Unknown web annotation command: ${String(command)}`);
  return def;
}

/** Version 1: the typed call with the envelope; results are decoded. */
function currentApi(call: CommandCall): WebAnnotationsApi {
  return {
    version: 1,
    run: (command, args) => {
      const def = definition(command);
      return call(def, args as unknown as ArgsOf<typeof def>) as Promise<
        WebAnnotationCommandResults[typeof command]
      >;
    },
  };
}

/** Version 0: today's untyped call by name, without an envelope or decoding. */
function legacyApi(_call: CommandCall, context: DomainAdapterContext): WebAnnotationsApi {
  return {
    version: 0,
    run: (command, args) =>
      context.invoke(
        definition(command).name,
        args as Readonly<Record<string, unknown>>,
      ) as Promise<WebAnnotationCommandResults[typeof command]>,
  };
}

export const webAnnotationsClient = domainClient(webAnnotationsDomain, {
  1: currentApi,
  0: legacyApi,
});
