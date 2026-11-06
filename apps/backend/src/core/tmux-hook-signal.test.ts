import { describe, expect, test } from "bun:test";
import type { StateSignalCredential } from "./agent-tools.js";
import type { CommandContext } from "./commands-context.js";
import {
  TMUX_HOOK_SIGNAL_RETRY_MS,
  TmuxHookSignalManager,
  type TmuxHookSignalInstaller,
} from "./tmux-hook-signal.js";
import type { ClaudeStateSignalSupport } from "./tmux-poll.js";

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function harness(
  options: {
    support?: ClaudeStateSignalSupport;
    probeRings?: boolean;
    failInstall?: boolean;
    installGate?: () => Promise<void>;
  } = {},
) {
  let now = 1_000_000;
  const issued: Array<{ onSignal: () => void; revoked: boolean; token: string }> = [];
  let supportCalls = 0;
  let installs = 0;
  let publishedToken: string | undefined;
  const context = {
    agentTools: {
      issueTmuxHookSignal: (onSignal: () => void): StateSignalCredential => {
        const entry = { onSignal, revoked: false, token: `token-${issued.length}` };
        issued.push(entry);
        return {
          url: "http://host.docker.internal:1/tmux-hook-signal",
          token: entry.token,
          revoke: () => {
            entry.revoked = true;
          },
        };
      },
    },
  } as unknown as CommandContext;
  /** The agent tools server: a POST with an unrevoked token rings it. */
  const ring = (index = issued.length - 1) => {
    const entry = issued[index];
    if (entry && !entry.revoked) entry.onSignal();
  };
  const installer: TmuxHookSignalInstaller = {
    support: async () => {
      supportCalls += 1;
      return options.support ?? "supported";
    },
    install: async (_containerId, credential) => {
      installs += 1;
      await options.installGate?.();
      publishedToken = credential.token;
      if (options.failInstall) throw new Error("exec failed");
      if (options.probeRings ?? true) ring(issued.findIndex((e) => e.token === credential.token));
    },
  };
  const manager = new TmuxHookSignalManager({ installer, nowMs: () => now });
  return {
    manager,
    context,
    issued,
    ring,
    advance: (ms: number) => {
      now += ms;
    },
    supportCalls: () => supportCalls,
    installs: () => installs,
    publishedToken: () => publishedToken,
  };
}

describe("tmux hook doorbell", () => {
  test("trusts a container only after its probe ring, and wakes every tab in it", async () => {
    const h = harness();
    const wakes: string[] = [];
    const first = h.manager.attach("c1", h.context, () => wakes.push("first"));
    const second = h.manager.attach("c1", h.context, () => wakes.push("second"));
    await flush();
    // One arming per container, however many tabs.
    expect(h.installs()).toBe(1);
    expect(first.confirmed()).toBe(true);
    expect(second.confirmed()).toBe(true);
    expect(first.rings()).toBe(1);
    wakes.length = 0;

    h.ring();
    expect(wakes).toEqual(["first", "second"]);
    expect(first.rings()).toBe(2);
    expect(h.manager.status()).toMatchObject({ containers: 1, rings: 2, fallback: 0 });
    expect(h.manager.status().states.confirmed).toBe(1);

    // The last tab out revokes the credential: a late ring costs nothing.
    first.release();
    expect(h.issued[0]!.revoked).toBe(false);
    second.release();
    expect(h.issued[0]!.revoked).toBe(true);
    expect(h.manager.status().containers).toBe(0);
  });

  test("a probe that never rings leaves the tab on the per-tick poll", async () => {
    const h = harness({ probeRings: false });
    const doorbell = h.manager.attach("c1", h.context, () => undefined);
    await flush();
    expect(doorbell.confirmed()).toBe(false);
    expect(h.manager.status().states.armed).toBe(1);
  });

  test("a probe silent for a whole retry window reports unconfirmed until a ring", async () => {
    const h = harness({ probeRings: false });
    const doorbell = h.manager.attach("c1", h.context, () => undefined);
    await flush();
    h.advance(TMUX_HOOK_SIGNAL_RETRY_MS - 1);
    expect(h.manager.status().states).toMatchObject({ armed: 1, unconfirmed: 0 });
    h.advance(1);
    expect(h.manager.status()).toMatchObject({
      containers: 1,
      states: { armed: 0, unconfirmed: 1 },
      fallback: 1,
      rings: 0,
    });
    // The re-arm on the window keeps the stretch's first armed time.
    expect(doorbell.confirmed()).toBe(false);
    await flush();
    expect(h.installs()).toBe(2);
    expect(h.manager.status().states.unconfirmed).toBe(1);

    h.ring();
    expect(doorbell.confirmed()).toBe(true);
    expect(h.manager.status().states).toMatchObject({ unconfirmed: 0, confirmed: 1 });
    // A demotion starts a new stretch.
    doorbell.missed();
    h.advance(TMUX_HOOK_SIGNAL_RETRY_MS);
    expect(doorbell.confirmed()).toBe(false);
    await flush();
    expect(h.manager.status().states).toMatchObject({ armed: 1, unconfirmed: 0 });
    doorbell.release();
  });

  test("an image without the capability is asked once and never armed", async () => {
    const h = harness({ support: "unsupported" });
    const doorbell = h.manager.attach("c1", h.context, () => undefined);
    await flush();
    h.advance(TMUX_HOOK_SIGNAL_RETRY_MS * 2);
    expect(doorbell.confirmed()).toBe(false);
    await flush();
    expect(h.supportCalls()).toBe(1);
    expect(h.issued).toHaveLength(0);
    expect(h.manager.status().states.unsupported).toBe(1);
  });

  test("a missed hook demotes and revokes until the retry window, then re-arms", async () => {
    const h = harness();
    const doorbell = h.manager.attach("c1", h.context, () => undefined);
    await flush();
    expect(doorbell.confirmed()).toBe(true);
    doorbell.missed();
    expect(doorbell.confirmed()).toBe(false);
    expect(h.issued[0]!.revoked).toBe(true);
    expect(h.manager.status().demotions).toEqual({ "missed-change": 1 });
    await flush();
    expect(h.installs()).toBe(1);

    h.advance(TMUX_HOOK_SIGNAL_RETRY_MS);
    expect(doorbell.confirmed()).toBe(false);
    await flush();
    expect(h.installs()).toBe(2);
    expect(doorbell.confirmed()).toBe(true);
  });

  test("a failed install demotes without throwing", async () => {
    const h = harness({ failInstall: true });
    const doorbell = h.manager.attach("c1", h.context, () => undefined);
    await flush();
    expect(doorbell.confirmed()).toBe(false);
    expect(h.issued[0]!.revoked).toBe(true);
    expect(h.manager.status().demotions).toEqual({ "arm-failed": 1 });
  });

  test("a stopped container is forgotten by full or short id", async () => {
    const h = harness();
    const id = "a".repeat(64);
    const doorbell = h.manager.attach(id.slice(0, 12), h.context, () => undefined);
    await flush();
    expect(doorbell.confirmed()).toBe(true);
    h.manager.forgetMatching(id);
    expect(doorbell.confirmed()).toBe(false);
    expect(h.issued[0]!.revoked).toBe(true);
    // Releasing after the container was forgotten is harmless.
    doorbell.release();
  });

  test("serializes replacement config publication after a retired writer", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let writes = 0;
    const h = harness({ installGate: () => (++writes === 1 ? gate : Promise.resolve()) });
    const first = h.manager.attach("c1", h.context, () => undefined);
    await flush();
    expect(h.installs()).toBe(1);
    first.release();
    let wakes = 0;
    const next = h.manager.attach("c1", h.context, () => {
      wakes += 1;
    });
    await flush();
    expect(h.installs()).toBe(1);
    finish();
    await flush();
    expect(h.installs()).toBe(2);
    expect(next.confirmed()).toBe(true);
    expect(h.publishedToken()).toBe(h.issued[1]!.token);
    expect(h.issued[0]!.revoked).toBe(true);
    h.ring();
    expect(wakes).toBe(2);
    next.release();
  });

  test("surviving subscription rejoins after lifecycle invalidation", async () => {
    const h = harness();
    let wakes = 0;
    const tab = h.manager.attach("c1", h.context, () => {
      wakes += 1;
    });
    await flush();
    expect(tab.confirmed()).toBe(true);
    h.manager.forgetMatching("c1");
    expect(tab.confirmed()).toBe(false);
    await flush();
    expect(tab.confirmed()).toBe(true);
    expect(tab.rings()).toBe(2);
    h.ring();
    expect(wakes).toBe(3);
    tab.release();
    expect(h.manager.status().containers).toBe(0);
  });

  test("without an installer or a doorbell route nothing is armed", async () => {
    const plain = new TmuxHookSignalManager();
    expect(plain.attach("c1", {} as CommandContext, () => undefined).confirmed()).toBe(false);
    const h = harness();
    const noRoute = h.manager.attach("c2", {} as CommandContext, () => undefined);
    await flush();
    expect(noRoute.confirmed()).toBe(false);
    expect(h.supportCalls()).toBe(0);
  });
});
