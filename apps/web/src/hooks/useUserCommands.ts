import { useEffect, useRef, useState } from "react";

import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { listHumanPrompts, listUserCommands } from "@/lib/backend";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";

const EMPTY_COMMANDS: UserCommandRecord[] = [];
const EMPTY_PROMPTS: HumanPromptEntry[] = [];

/**
 * A tab's user `!` commands, read from the backend that owns them.
 *
 * The backend announces `user-command` (id `env-<environment>:<tab>`) when one
 * starts, prints or exits; this re-reads then, and on any resync, so a hidden
 * or remounted tab always shows the authoritative list. Out-of-order reads are
 * dropped.
 */
export function useUserCommands(
  environmentId: string | undefined,
  tabId: string | undefined,
): { commands: UserCommandRecord[]; refresh: () => void } {
  const [state, setState] = useState<{ key: string; commands: UserCommandRecord[] } | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const key = environmentId && tabId ? `env-${environmentId}:${tabId}` : null;

  useEffect(() => {
    if (!key || !environmentId || !tabId) return;
    let disposed = false;
    let sequence = 0;
    const reread = () => {
      const request = ++sequence;
      void listUserCommands(environmentId, tabId)
        .then((list) => {
          if (!disposed && request === sequence) setState({ key, commands: list.commands });
        })
        .catch(() => undefined);
    };
    refreshRef.current = reread;
    const reconnect = new AbortController();
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, reread, { signal: reconnect.signal }).catch(
      () => undefined,
    );
    reread();
    const offSafety = onViewSafetyCheck(reread);
    const offChange = onResourceChanged("user-command", (change) => {
      if (change.id === key) reread();
    });
    // Ephemeral resources are absent from the durable manifest.
    const offResync = onResourceResync(reread);
    return () => {
      disposed = true;
      reconnect.abort();
      offSafety();
      refreshRef.current = () => undefined;
      offChange();
      offResync();
    };
  }, [environmentId, key, tabId]);

  const commands = state && state.key === key ? state.commands : EMPTY_COMMANDS;
  const running = commands.some((command) => command.status === "running");
  // A safety net under the hints while something runs: a missed hint would
  // otherwise freeze a live card until the next resync.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => refreshRef.current(), 3_000);
    return () => clearInterval(timer);
  }, [running]);

  return { commands, refresh: () => refreshRef.current() };
}

/**
 * Prompts waiting on the user in these environments (a tab's own, or a
 * coordinator's workers), re-read on each `human-prompt` hint for one of them.
 */
export function useHumanPrompts(environmentIds: readonly string[]): HumanPromptEntry[] {
  const [state, setState] = useState<{ key: string; prompts: HumanPromptEntry[] } | null>(null);
  const key = Array.from(new Set(environmentIds)).sort().join("\u0000");

  useEffect(() => {
    if (!key) return;
    const ids = key.split("\u0000");
    const wanted = new Set(ids);
    let disposed = false;
    let sequence = 0;
    const reread = () => {
      const request = ++sequence;
      void listHumanPrompts(ids)
        .then((list) => {
          if (!disposed && request === sequence) setState({ key, prompts: list.prompts });
        })
        .catch(() => undefined);
    };
    const reconnect = new AbortController();
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, reread, { signal: reconnect.signal }).catch(
      () => undefined,
    );
    reread();
    const offSafety = onViewSafetyCheck(reread);
    const offChange = onResourceChanged("human-prompt", (change) => {
      if (wanted.has(change.id)) reread();
    });
    // Ephemeral resources are absent from the durable manifest.
    const offResync = onResourceResync(reread);
    return () => {
      disposed = true;
      reconnect.abort();
      offSafety();
      offChange();
      offResync();
    };
  }, [key]);

  return state && state.key === key ? state.prompts : EMPTY_PROMPTS;
}
