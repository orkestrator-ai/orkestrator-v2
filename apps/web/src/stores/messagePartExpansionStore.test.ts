import { afterEach, describe, expect, test } from "bun:test";
import {
  retainExpansionKey,
  useMessagePartExpansionStore,
} from "./messagePartExpansionStore";

function keys(): ReadonlySet<string> {
  return useMessagePartExpansionStore.getState().expandedKeys;
}

function setExpanded(key: string, expanded: boolean) {
  useMessagePartExpansionStore.getState().setExpanded(key, expanded);
}

/**
 * Mounted-key retention is module state rather than store state, so it
 * survives `reset()`. Track every retain so a test cannot leak an on-screen
 * key into the next one and quietly change its eviction outcome.
 */
const releases: Array<() => void> = [];

function retain(key: string): () => void {
  const release = retainExpansionKey(key);
  releases.push(release);
  return release;
}

describe("messagePartExpansionStore", () => {
  afterEach(() => {
    while (releases.length > 0) releases.pop()?.();
    useMessagePartExpansionStore.getState().reset();
  });

  test("starts empty and records expanded keys", () => {
    expect(keys().size).toBe(0);

    setExpanded("msg-1-part-0", true);

    expect(keys().has("msg-1-part-0")).toBe(true);
  });

  test("collapsing removes the key rather than storing false", () => {
    setExpanded("msg-1-part-0", true);
    setExpanded("msg-1-part-0", false);

    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().size).toBe(0);
  });

  test("keeps keys independent so one part does not toggle another", () => {
    setExpanded("msg-1-part-0", true);
    setExpanded("msg-1-part-1", true);
    setExpanded("msg-1-part-0", false);

    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().has("msg-1-part-1")).toBe(true);
  });

  test("a no-op write keeps the same set instance so subscribers do not re-render", () => {
    setExpanded("msg-1-part-0", true);
    const before = keys();

    setExpanded("msg-1-part-0", true);
    expect(keys()).toBe(before);

    setExpanded("msg-1-part-9", false);
    expect(keys()).toBe(before);
  });

  test("a real write replaces the set instead of mutating it", () => {
    setExpanded("msg-1-part-0", true);
    const before = keys();

    setExpanded("msg-1-part-1", true);

    expect(keys()).not.toBe(before);
    expect(before.has("msg-1-part-1")).toBe(false);
  });

  test("evicts the oldest keys once the cap is exceeded", () => {
    for (let index = 0; index < 505; index++) {
      setExpanded(`msg-1-part-${index}`, true);
    }

    expect(keys().size).toBe(500);
    // The first five expansions were dropped, the newest are retained.
    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().has("msg-1-part-4")).toBe(false);
    expect(keys().has("msg-1-part-5")).toBe(true);
    expect(keys().has("msg-1-part-504")).toBe(true);
  });

  test("applies the shared cap when agent and non-agent disclosures coexist", () => {
    for (let index = 0; index < 250; index++) {
      setExpanded(`msg-${index}-part-0/thinking`, true);
    }
    for (let index = 0; index < 251; index++) {
      setExpanded(
        `native-agent:${JSON.stringify(["environment-1", `msg-${index}`])}:subagent:id:agent-${index}`,
        true,
      );
    }

    expect(keys().size).toBe(500);
    expect(keys().has("msg-0-part-0/thinking")).toBe(false);
    expect(keys().has("msg-1-part-0/thinking")).toBe(true);
    expect(
      keys().has(
        `native-agent:${JSON.stringify(["environment-1", "msg-250"])}:subagent:id:agent-250`,
      ),
    ).toBe(true);
  });

  test("evicts an older off-screen key rather than the on-screen one", () => {
    setExpanded("msg-1-part-0", true);
    retain("msg-1-part-0");
    for (let index = 1; index < 500; index++) {
      setExpanded(`msg-1-part-${index}`, true);
    }

    // The set is exactly full, so this expansion forces one eviction. The
    // oldest key is the mounted one; the oldest off-screen key must go first.
    setExpanded("msg-1-part-500", true);

    expect(keys().size).toBe(500);
    expect(keys().has("msg-1-part-0")).toBe(true);
    expect(keys().has("msg-1-part-1")).toBe(false);
    expect(keys().has("msg-1-part-500")).toBe(true);
  });

  test("stops protecting a key once its row unmounts", () => {
    setExpanded("msg-1-part-0", true);
    const release = retain("msg-1-part-0");
    for (let index = 1; index < 500; index++) {
      setExpanded(`msg-1-part-${index}`, true);
    }

    release();
    setExpanded("msg-1-part-500", true);

    expect(keys().size).toBe(500);
    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().has("msg-1-part-1")).toBe(true);
  });

  test("keeps a key protected until every holder of it releases", () => {
    setExpanded("msg-1-part-0", true);
    const firstRelease = retain("msg-1-part-0");
    retain("msg-1-part-0");
    for (let index = 1; index < 500; index++) {
      setExpanded(`msg-1-part-${index}`, true);
    }

    // One of two mounted rows for this key went away; the other still shows it.
    firstRelease();
    setExpanded("msg-1-part-500", true);

    expect(keys().has("msg-1-part-0")).toBe(true);
    expect(keys().has("msg-1-part-1")).toBe(false);
  });

  test("a released holder cannot be released twice into an under-count", () => {
    setExpanded("msg-1-part-0", true);
    const firstRelease = retain("msg-1-part-0");
    retain("msg-1-part-0");
    for (let index = 1; index < 500; index++) {
      setExpanded(`msg-1-part-${index}`, true);
    }

    // A double cleanup must not cancel out the holder that is still mounted.
    firstRelease();
    firstRelease();
    setExpanded("msg-1-part-500", true);

    expect(keys().has("msg-1-part-0")).toBe(true);
  });

  test("falls back to oldest-first when every remembered key is on screen", () => {
    for (let index = 0; index < 500; index++) {
      setExpanded(`msg-1-part-${index}`, true);
      retain(`msg-1-part-${index}`);
    }

    setExpanded("msg-1-part-500", true);
    retain("msg-1-part-500");

    // Nothing is evictable by preference, so the cap still wins and the least
    // recently expanded key is the one that goes.
    expect(keys().size).toBe(500);
    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().has("msg-1-part-1")).toBe(true);
    expect(keys().has("msg-1-part-500")).toBe(true);
  });

  test("never evicts the key being expanded, even when everything is on screen", () => {
    for (let index = 0; index < 500; index++) {
      setExpanded(`msg-1-part-${index}`, true);
      retain(`msg-1-part-${index}`);
    }

    retain("msg-1-part-500");
    setExpanded("msg-1-part-500", true);

    expect(keys().size).toBe(500);
    expect(keys().has("msg-1-part-500")).toBe(true);
  });

  test("evicts across the overflow when several keys arrive over the cap", () => {
    setExpanded("mounted-oldest", true);
    retain("mounted-oldest");
    for (let index = 0; index < 499; index++) {
      setExpanded(`off-screen-${index}`, true);
    }

    for (let index = 0; index < 5; index++) {
      setExpanded(`late-${index}`, true);
    }

    expect(keys().size).toBe(500);
    expect(keys().has("mounted-oldest")).toBe(true);
    // Five off-screen keys were dropped, oldest first.
    expect(keys().has("off-screen-4")).toBe(false);
    expect(keys().has("off-screen-5")).toBe(true);
    expect(keys().has("late-4")).toBe(true);
  });

  test("reset clears every remembered key", () => {
    setExpanded("msg-1-part-0", true);
    setExpanded("msg-2-part-0", true);

    useMessagePartExpansionStore.getState().reset();

    expect(keys().size).toBe(0);
  });
});
