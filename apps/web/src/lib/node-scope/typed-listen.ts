/**
 * The typed `NodeClient.listen(def, handler)` (plan item 7011) over a
 * client's untyped `listenRaw`, shared by every client implementation.
 *
 * A payload that does not decode against the definition's schema is dropped
 * and logged with the event name only (a family member by its prefix), never
 * the payload or the schema issue text, which may quote a value.
 */
import {
  listenEvent,
  type AnyEventDef,
  type PayloadOf,
} from "@orkestrator/protocol/contract/event";
import { createLogger } from "@orkestrator/protocol/logger";
import type { NodeClient, Unlisten } from "@orkestrator/protocol/node-client";

const log = createLogger("contract");

type RawListen = (event: string, handler: (payload: unknown) => void) => Unlisten;

function onInvalid(def: AnyEventDef): () => void {
  return () =>
    log.warn("listen.payload-invalid", {
      event: def.family ? `${def.family.prefix}*` : def.name,
    });
}

/** `listen` for a client whose untyped subscription is `listenRaw`. */
export function typedListen(listenRaw: RawListen): NodeClient["listen"] {
  const source = { listenRaw };
  return <E extends AnyEventDef>(def: E, handler: (payload: PayloadOf<E>) => void): Unlisten =>
    listenEvent(source, def, handler, { onInvalid: onInvalid(def) });
}

/**
 * `typedListen`'s delivery as a raw handler, for a subscription that is not a
 * client's `listenRaw` (the app command scope's `@/lib/native/events` `listen`,
 * which suites mock): `def`'s payloads that decode reach `handler` as sent,
 * any other is dropped and logged by name.
 */
export function typedHandler<E extends AnyEventDef>(
  def: E,
  handler: (payload: PayloadOf<E>) => void,
): (raw: unknown) => void {
  let deliver: (raw: unknown) => void = () => {};
  listenEvent(
    {
      listenRaw: (_event, raw) => {
        deliver = raw;
        return () => {};
      },
    },
    def,
    handler,
    { onInvalid: onInvalid(def) },
  );
  return deliver;
}
