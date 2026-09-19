import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useConfigStore } from "@/stores/configStore";
import {
  __testing,
  isNotificationSoundEnabled,
  playConfiguredNotificationSound,
  playNotificationSound,
  primeNotificationSounds,
} from "./notification-sounds";

const originalConfig = structuredClone(useConfigStore.getState().config);
const audioContextDescriptor = Object.getOwnPropertyDescriptor(window, "AudioContext");
const webkitAudioContextDescriptor = Object.getOwnPropertyDescriptor(window, "webkitAudioContext");

class FakeOscillator {
  type: OscillatorType = "sine";
  frequency = { setValueAtTime: mock((_value: number, _time: number) => undefined) };
  connect = mock((_destination: unknown) => undefined);
  start = mock((_time: number) => undefined);
  stop = mock((_time: number) => undefined);
}

class FakeGain {
  gain = {
    setValueAtTime: mock((_value: number, _time: number) => undefined),
    exponentialRampToValueAtTime: mock((_value: number, _time: number) => undefined),
  };
  connect = mock((_destination: unknown) => undefined);
}

function installAudioContext(
  options: {
    state?: AudioContextState;
    resumeState?: AudioContextState;
    resumeError?: Error;
  } = {},
) {
  const contexts: FakeAudioContext[] = [];

  class FakeAudioContext {
    state = options.state ?? "running";
    currentTime = 4;
    destination = {};
    resumeCalls = 0;
    oscillators: FakeOscillator[] = [];
    gains: FakeGain[] = [];

    constructor() {
      contexts.push(this);
    }

    async resume(): Promise<void> {
      this.resumeCalls += 1;
      if (options.resumeError) throw options.resumeError;
      this.state = options.resumeState ?? "running";
    }

    createOscillator(): OscillatorNode {
      const oscillator = new FakeOscillator();
      this.oscillators.push(oscillator);
      return oscillator as unknown as OscillatorNode;
    }

    createGain(): GainNode {
      const gain = new FakeGain();
      this.gains.push(gain);
      return gain as unknown as GainNode;
    }
  }

  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(window, "webkitAudioContext", {
    configurable: true,
    value: undefined,
  });
  return contexts;
}

function restoreWindowProperty(
  name: "AudioContext" | "webkitAudioContext",
  descriptor?: PropertyDescriptor,
) {
  if (descriptor) Object.defineProperty(window, name, descriptor);
  else delete (window as unknown as Record<string, unknown>)[name];
}

beforeEach(() => {
  __testing.resetAudioContext();
  useConfigStore.setState({ config: structuredClone(originalConfig) });
});

afterEach(() => {
  __testing.resetAudioContext();
  useConfigStore.setState({ config: structuredClone(originalConfig) });
  restoreWindowProperty("AudioContext", audioContextDescriptor);
  restoreWindowProperty("webkitAudioContext", webkitAudioContextDescriptor);
});

describe("notification sounds", () => {
  test("reports unsupported browsers without throwing", async () => {
    Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: undefined });

    expect(await primeNotificationSounds()).toBe(false);
    expect(await playNotificationSound("agent-stopped")).toBe(false);
  });

  test("resumes a suspended context and schedules the agent-stopped waveform", async () => {
    const contexts = installAudioContext({ state: "suspended" });

    expect(await playNotificationSound("agent-stopped")).toBe(true);
    const context = contexts[0]!;
    expect(context.resumeCalls).toBe(1);
    expect(context.oscillators).toHaveLength(2);
    expect(context.gains).toHaveLength(2);
    expect(context.oscillators.map((oscillator) => oscillator.type)).toEqual(["sine", "sine"]);
    expect(context.oscillators[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(880, 4.01);
    expect(context.oscillators[0]?.start).toHaveBeenCalledWith(4.01);
    expect(context.oscillators[0]?.stop).toHaveBeenCalledWith(4.18);
    expect(context.gains[0]?.gain.exponentialRampToValueAtTime).toHaveBeenCalledTimes(2);
  });

  test("primes a suspended shared context from a user gesture", async () => {
    const contexts = installAudioContext({ state: "suspended" });

    expect(await primeNotificationSounds()).toBe(true);
    expect(contexts[0]?.resumeCalls).toBe(1);
  });

  test("contains playback permission failures", async () => {
    const contexts = installAudioContext({
      state: "suspended",
      resumeError: new Error("permission denied"),
    });

    expect(await primeNotificationSounds()).toBe(false);
    expect(await playNotificationSound("pr-merged")).toBe(false);
    expect(contexts[0]?.resumeCalls).toBe(2);
  });

  test("suppresses configured cues when their preference is disabled", async () => {
    const contexts = installAudioContext();
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: { agentStopped: false, prMerged: true },
    });

    expect(isNotificationSoundEnabled("agent-stopped")).toBe(false);
    expect(isNotificationSoundEnabled("pr-merged")).toBe(true);
    expect(await playConfiguredNotificationSound("agent-stopped")).toBe(false);
    expect(contexts).toHaveLength(0);

    expect(await playConfiguredNotificationSound("pr-merged")).toBe(true);
    expect(contexts[0]?.oscillators).toHaveLength(3);
    expect(contexts[0]?.oscillators.every((oscillator) => oscillator.type === "triangle")).toBe(
      true,
    );
  });
});
