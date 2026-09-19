import { normalizeNotificationSoundSettings } from "@orkestrator/protocol/notification-sounds";
import { useConfigStore } from "@/stores/configStore";

export type NotificationSoundKind = "agent-stopped" | "pr-merged";

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
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return false;

    const start = context.currentTime + 0.01;
    for (const note of CHIMES[kind]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + note.offset;
      const noteEnd = noteStart + note.duration;
      oscillator.type = kind === "agent-stopped" ? "sine" : "triangle";
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
  const settings = normalizeNotificationSoundSettings(
    useConfigStore.getState().config.global.notificationSounds,
  );
  return kind === "agent-stopped" ? settings.agentStopped : settings.prMerged;
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
