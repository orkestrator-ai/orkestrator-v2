import { describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { ClientGrantService } from "./client-grants.js";

const CONTROLLER = "bk_controller" as BackendId;
const OTHER_CONTROLLER = "bk_other" as BackendId;

function service() {
  const clock = { now: 1_000_000 };
  const grants = new ClientGrantService(() => clock.now);
  const issue = (controllerId = CONTROLLER) =>
    grants.issue({ controllerId, label: "test", ttlMs: 60_000 });
  return { clock, grants, issue };
}

describe("ClientGrantService revocation listeners", () => {
  test("each way of removing a grant tells its listeners once", () => {
    const removals: Array<[string, (context: ReturnType<typeof service>, id: string) => void]> = [
      ["revoke", ({ grants }, id) => expect(grants.revoke(id)).toBe(true)],
      ["revoke as its controller", ({ grants }, id) => grants.revoke(id, CONTROLLER)],
      ["revokeController", ({ grants }) => expect(grants.revokeController(CONTROLLER)).toBe(1)],
      ["revokeAll", ({ grants }) => grants.revokeAll()],
      [
        "expiry found by authenticate",
        ({ clock, grants }, id) => {
          clock.now += 60_000;
          expect(grants.authenticate(`okg_${id}.secret`)).toBeNull();
        },
      ],
      [
        "expiry found by prune",
        (context) => {
          context.clock.now += 60_000;
          context.issue(OTHER_CONTROLLER);
        },
      ],
    ];
    for (const [name, remove] of removals) {
      const context = service();
      const { grant, token } = context.issue();
      const listener = mock(() => undefined);
      context.grants.onRevoke(token, listener);
      remove(context, grant.grantId);
      expect(listener, name).toHaveBeenCalledTimes(1);
      expect(context.grants.authenticate(token), name).toBeNull();
      context.grants.revokeAll();
      expect(listener, name).toHaveBeenCalledTimes(1);
    }
  });

  test("only the grant being removed is told", () => {
    const { grants, issue } = service();
    const kept = issue(OTHER_CONTROLLER);
    const removed = issue();
    const keptListener = mock(() => undefined);
    const removedListener = mock(() => undefined);
    grants.onRevoke(kept.token, keptListener);
    grants.onRevoke(removed.token, removedListener);

    expect(grants.revoke(removed.grant.grantId, OTHER_CONTROLLER)).toBe(false);
    expect(removedListener).not.toHaveBeenCalled();
    expect(grants.revokeController(CONTROLLER)).toBe(1);
    expect(removedListener).toHaveBeenCalledTimes(1);
    expect(keptListener).not.toHaveBeenCalled();
    expect(grants.authenticate(kept.token)?.grantId).toBe(kept.grant.grantId);
  });

  test("renewal keeps a grant and its listeners", () => {
    const { clock, grants, issue } = service();
    const { grant, token } = issue();
    const listener = mock(() => undefined);
    grants.onRevoke(token, listener);
    clock.now += 30_000;
    expect(
      grants.renew({ grantId: grant.grantId, controllerId: CONTROLLER, ttlMs: 60_000 })?.expiresAt,
    ).toBe(clock.now + 60_000);
    clock.now += 45_000;
    expect(grants.authenticate(token)?.grantId).toBe(grant.grantId);
    expect(listener).not.toHaveBeenCalled();
    grants.revoke(grant.grantId);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("an unsubscribed listener is not told", () => {
    const { grants, issue } = service();
    const { grant, token } = issue();
    const gone = mock(() => undefined);
    const kept = mock(() => undefined);
    const unsubscribe = grants.onRevoke(token, gone)!;
    grants.onRevoke(token, kept);
    unsubscribe();
    unsubscribe();
    grants.revoke(grant.grantId);
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    // Harmless after the record has gone.
    unsubscribe();
  });

  test("only a token that proves a grant held here can subscribe", () => {
    const { grants, issue } = service();
    const { grant, token } = issue();
    const listener = mock(() => undefined);
    expect(grants.onRevoke("not-a-grant", listener)).toBeNull();
    expect(grants.onRevoke(`okg_${grant.grantId}.wrong-secret`, listener)).toBeNull();
    expect(grants.onRevoke(`${token}x`, listener)).toBeNull();
    grants.revoke(grant.grantId);
    expect(grants.onRevoke(token, listener)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  test("a grant past its deadline but not yet removed can subscribe and hears the removal", () => {
    const { clock, grants, issue } = service();
    const { token } = issue();
    clock.now += 60_000;
    const listener = mock(() => undefined);
    expect(grants.onRevoke(token, listener)).not.toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(grants.authenticate(token)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a throwing listener strands neither the other listeners nor the other grants", () => {
    const { grants, issue } = service();
    const first = issue();
    const second = issue();
    const after = mock(() => undefined);
    const otherGrant = mock(() => undefined);
    grants.onRevoke(first.token, () => {
      throw new Error("listener failed");
    });
    grants.onRevoke(first.token, after);
    grants.onRevoke(second.token, otherGrant);

    grants.revokeAll();
    expect(after).toHaveBeenCalledTimes(1);
    expect(otherGrant).toHaveBeenCalledTimes(1);
    expect(grants.authenticate(first.token)).toBeNull();
    expect(grants.authenticate(second.token)).toBeNull();
  });

  test("a listener sees every grant of a revocation already gone", () => {
    const { grants, issue } = service();
    const first = issue();
    const second = issue();
    const seen: Array<unknown> = [];
    grants.onRevoke(first.token, () => seen.push(grants.authenticate(second.token)));
    grants.revokeController(CONTROLLER);
    expect(seen).toEqual([null]);
  });
});
