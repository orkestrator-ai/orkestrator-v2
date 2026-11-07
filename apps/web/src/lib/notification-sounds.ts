import { normalizeNotificationSoundSettings } from "@orkestrator/protocol/notification-sounds";
import { appCommandScope } from "@/lib/node-scope-slots";
import { configStore } from "@/stores/configStore";

export type NotificationSoundKind =
  "agent-stopped" | "pr-merged" | "coordinator-report" | "agent-question";

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContextConstructor();
  }
  return audioContext;
}

interface Note {
  frequency: number;
  offset: number;
  duration: number;
  volume: number;
}

const CHIMES: Record<NotificationSoundKind, readonly Note[]> = {
  // A short falling two-note cue: work has come to rest.
  "agent-stopped": [
    { frequency: 880, offset: 0, duration: 0.16, volume: 0.12 },
    { frequency: 659.25, offset: 0.12, duration: 0.24, volume: 0.14 },
  ],
  // A distinct rising major triad for the terminal PR milestone.
  "pr-merged": [
    { frequency: 523.25, offset: 0, duration: 0.15, volume: 0.1 },
    { frequency: 659.25, offset: 0.1, duration: 0.17, volume: 0.11 },
    { frequency: 783.99, offset: 0.2, duration: 0.3, volume: 0.13 },
  ],
  // Two even notes a fourth apart: a report has arrived, and the coordinator is on it.
  "coordinator-report": [
    { frequency: 587.33, offset: 0, duration: 0.14, volume: 0.11 },
    { frequency: 783.99, offset: 0.14, duration: 0.2, volume: 0.12 },
  ],
  // Two quick high pings, then a leap up a fifth: a question that wants an
  // answer. Higher, faster and longer than every other cue so it is not
  // mistaken for work coming to rest.
  "agent-question": [
    { frequency: 987.77, offset: 0, duration: 0.09, volume: 0.12 },
    { frequency: 987.77, offset: 0.11, duration: 0.09, volume: 0.12 },
    { frequency: 1479.98, offset: 0.24, duration: 0.32, volume: 0.13 },
  ],
};

const WAVEFORMS: Record<NotificationSoundKind, OscillatorType> = {
  "agent-stopped": "sine",
  "pr-merged": "triangle",
  "coordinator-report": "triangle",
  "agent-question": "square",
};

/**
 * Play a compact synthesized cue. Returning false lets preview controls explain
 * browsers that do not expose or permit Web Audio without turning a background
 * notification into an application error.
 */
export async function playNotificationSound(kind: NotificationSoundKind): Promise<boolean> {
  try {
    const context = getAudioContext();
    if (!context) return false;
    if (context.state === "suspended") {
      // Autoplay policy may leave resume pending indefinitely. Do not delay an
      // OS alert forever or schedule a late cue after its fallback has sounded.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const resumed = await Promise.race([
          context.resume().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 250);
          }),
        ]);
        if (!resumed) return false;
      } finally {
        clearTimeout(timer);
      }
    }
    if (context.state !== "running") return false;

    const start = context.currentTime + 0.01;
    for (const note of CHIMES[kind]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + note.offset;
      const noteEnd = noteStart + note.duration;
      oscillator.type = WAVEFORMS[kind];
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(note.volume, noteStart + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.01);
    }
    return true;
  } catch {
    return false;
  }
}

export function isNotificationSoundEnabled(kind: NotificationSoundKind): boolean {
  // The sounds are this window's: the settings of the node it is connected to.
  const settings = normalizeNotificationSoundSettings(
    appCommandScope().store(configStore).getState().config.global.notificationSounds,
  );
  switch (kind) {
    case "agent-stopped":
      return settings.agentStopped;
    case "pr-merged":
      return settings.prMerged;
    case "coordinator-report":
      return settings.coordinatorReport;
    case "agent-question":
      return settings.agentQuestion;
  }
}

export async function playConfiguredNotificationSound(
  kind: NotificationSoundKind,
): Promise<boolean> {
  return isNotificationSoundEnabled(kind) ? playNotificationSound(kind) : false;
}

/** Resume/create the shared context from a trusted user gesture for web clients. */
export async function primeNotificationSounds(): Promise<boolean> {
  try {
    const context = getAudioContext();
    if (!context) return false;
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch {
    return false;
  }
}

export const __testing = {
  resetAudioContext(): void {
    audioContext = null;
  },
};
