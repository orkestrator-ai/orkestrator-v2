import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Square } from "lucide-react";
import { describeAnchorLocation, describeContentRef, type RichAnchor } from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { richInteractionErrorMessage } from "@/lib/backend/rich-interactions";
import { newIdempotencyKey } from "@/lib/chat/rich-interactions";
import { cn } from "@/lib/utils";
import { textareaClass } from "../shared";

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionConstructor = new () => RecognitionLike;

/** The client's speech engine, or null when this client cannot recognize speech. */
export function speechRecognitionEngine(): { name: string; create: () => RecognitionLike } | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition;
  return candidate ? { name: "web-speech", create: () => new candidate() } : null;
}

const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "Microphone permission was refused. You can type your request instead.",
  "service-not-allowed": "Speech recognition is not allowed on this client. You can type your request instead.",
  network: "This client's speech recognition service is unreachable. You can type your request instead.",
  "no-speech": "No speech was heard. Hold the button and try again.",
  "audio-capture": "No microphone was found.",
};

/**
 * Feature 19: point and talk. The targets are frozen when recording starts,
 * so changing the selection mid-sentence never changes what "this" means.
 * The recognized words are an editable draft; nothing is sent until Send,
 * and no audio is kept (the browser engine streams it; this component never
 * stores it). Where the client has no speech engine the same targeted
 * request can be typed.
 */
export function PointAndTalk({ environmentId, logicalSessionKey, targets, onSent }: { environmentId: string; logicalSessionKey: string; targets: RichAnchor[]; onSent?: () => void }) {
  const backend = useScopeBackend();
  const engine = useRef(speechRecognitionEngine());
  const recognition = useRef<RecognitionLike | null>(null);
  const [recording, setRecording] = useState(false);
  const [frozen, setFrozen] = useState<RichAnchor[] | null>(null);
  const [recognized, setRecognized] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendKey = useRef<string | null>(null);

  useEffect(() => () => recognition.current?.abort(), []);

  const start = () => {
    setError(null);
    const speech = engine.current;
    if (!speech || recording) return;
    setFrozen(targets);
    const instance = speech.create();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = navigator.language || "en-US";
    let finalText = "";
    instance.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        if (result.isFinal) finalText += result[0]!.transcript;
        else interim += result[0]!.transcript;
      }
      const combined = `${finalText}${interim}`.trim();
      setRecognized(combined);
      setText(combined);
    };
    instance.onerror = (event) => setError(ERROR_TEXT[event.error] ?? "Speech recognition stopped unexpectedly. You can type instead.");
    instance.onend = () => {
      setRecording(false);
      recognition.current = null;
    };
    recognition.current = instance;
    try {
      instance.start();
      setRecording(true);
    } catch {
      setError("Speech recognition could not start.");
    }
  };
  const stop = () => recognition.current?.stop();
  const cancel = () => {
    recognition.current?.abort();
    setRecognized("");
    setText("");
    setFrozen(null);
  };
  const send = async () => {
    const pointed = frozen ?? targets;
    setSending(true);
    setError(null);
    sendKey.current ??= newIdempotencyKey();
    try {
      await backend.composeRichInteraction({
        environmentId,
        tabId: logicalSessionKey.slice(logicalSessionKey.indexOf(":") + 1),
        kind: "voice-request",
        title: text.trim().slice(0, 80) || "Spoken request",
        spec: { targets: pointed, recognized: recognized || text.trim(), engine: { name: engine.current?.name ?? "typed", processing: "unknown" } },
        actionId: "send",
        idempotencyKey: sendKey.current,
        result: { text: text.trim() },
      });
      sendKey.current = null;
      cancel();
      onSent?.();
    } catch (cause) {
      setError(`${richInteractionErrorMessage(cause)} It is safe to retry.`);
    } finally {
      setSending(false);
    }
  };

  const pointed = frozen ?? targets;
  return (
    <div className="flex flex-col gap-2" aria-label="Point and talk">
      <div className="rounded border border-border/60 px-2 py-1.5 text-xs">
        <p className="font-medium">{frozen ? "Pointing at (frozen when you started)" : "Pointing at"}</p>
        {pointed.length === 0 ? (
          <p className="text-muted-foreground">Nothing selected. Add items to the context tray to point at them, or just speak.</p>
        ) : (
          <ul className="list-disc pl-4">
            {pointed.map((target, i) => (
              <li key={i}>
                {describeAnchorLocation(target.location)} of {describeContentRef(target.source)}
              </li>
            ))}
          </ul>
        )}
        {frozen && JSON.stringify(frozen) !== JSON.stringify(targets) ? (
          <button type="button" className="mt-1 text-primary focus-hairline" onClick={() => setFrozen(targets)}>
            Use the current selection instead
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {engine.current ? (
          <Button
            size="sm"
            variant={recording ? "destructive" : "outline"}
            aria-pressed={recording}
            onPointerDown={(e) => {
              e.preventDefault();
              start();
            }}
            onPointerUp={stop}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                if (recording) stop();
                else start();
              }
            }}
          >
            {recording ? <Square className="size-3.5" aria-hidden /> : <Mic className="size-3.5" aria-hidden />}
            {recording ? "Recording… release to stop" : "Hold to talk"}
          </Button>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MicOff className="size-3.5" aria-hidden />
            Speech input is not available on this client; type your request.
          </span>
        )}
        {recording ? <span className="size-2 animate-pulse rounded-full bg-red-500" aria-label="Microphone is recording" role="img" /> : null}
      </div>
      <textarea className={cn(textareaClass, "text-sm")} rows={2} aria-label="Request text" placeholder="Recognized words appear here; edit before sending." value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={cancel} disabled={sending}>
          Discard
        </Button>
        <Button size="sm" disabled={!text.trim() || sending || recording} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
      {error ? <p className="text-xs text-failure" role="alert">{error}</p> : null}
    </div>
  );
}
