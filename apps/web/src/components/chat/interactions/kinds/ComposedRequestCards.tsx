import { Mic } from "lucide-react";
import {
  describeAnchorLocation,
  describeContentRef,
  type ContextPacketSpec,
  type DemonstrationSpec,
  type VoiceRequestSpec,
} from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { ContentRefPreview, RefChip, type KindProps } from "../shared";

/**
 * Read-only views of what the person composed and sent themselves: a context
 * packet (feature 15), a spoken request (feature 19) and a demonstration
 * (feature 20). They are committed and delivered in one step from the
 * composer; these cards are the durable record of exactly what was sent.
 */
export function ContextPacketCard({ view, spec }: KindProps<ContextPacketSpec>) {
  const result = view.receipts[0]?.result as { prompt?: string } | undefined;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {result?.prompt ? <p className="whitespace-pre-wrap">{result.prompt}</p> : null}
      <ul className="flex flex-col gap-1" aria-label="References sent">
        {spec.items.filter((i) => i.included).map((item) => (
          <li key={item.itemId} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{item.label}</span>
            <RefChip reference={item.source} />
            {item.location ? <span className="text-muted-foreground">{describeAnchorLocation(item.location)}</span> : null}
            {item.freeze === "latest" ? <span className="text-amber-300">latest version when sent</span> : null}
            {item.userNote ? <span className="text-muted-foreground">— {item.userNote}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VoiceRequestCard({ view, spec }: KindProps<VoiceRequestSpec>) {
  const sent = view.receipts[0]?.result as { text?: string } | undefined;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="flex items-start gap-2">
        <Mic className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>{sent?.text ?? spec.recognized}</span>
      </p>
      {sent?.text && sent.text !== spec.recognized ? <p className="text-xs text-muted-foreground">Recognized as “{spec.recognized}”, edited before sending.</p> : null}
      {spec.targets.map((target, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          Pointing at {describeAnchorLocation(target.location)} of {describeContentRef(target.source)}
        </p>
      ))}
      <p className="text-[11px] text-muted-foreground">
        Speech engine: {spec.engine.name} ({spec.engine.processing === "on-device" ? "on this device" : spec.engine.processing === "remote" ? "processed remotely" : "processing location not reported"}). No audio was kept.
      </p>
    </div>
  );
}

export function DemonstrationCard({ view, spec }: KindProps<DemonstrationSpec>) {
  const sent = view.receipts[0]?.result as { stepIds?: string[]; expectedOutcome?: string } | undefined;
  const kept = new Set(sent?.stepIds ?? spec.steps.map((s) => s.stepId));
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {spec.service.label} ({spec.service.origin}) · {(spec.durationMs / 1000).toFixed(1)} s · {kept.size} of {spec.steps.length} steps sent
        {spec.stopReason !== "user" ? ` · stopped: ${spec.stopReason}` : ""}
      </p>
      {sent?.expectedOutcome ? <p>Expected: {sent.expectedOutcome}</p> : null}
      <ol className="flex flex-col gap-1">
        {spec.steps.map((step, index) => (
          <li key={step.stepId} className={cn("rounded border px-2 py-1 text-xs", kept.has(step.stepId) ? "border-border/60" : "border-dashed border-border/40 opacity-50", step.wrongHere && "border-failure/50")}>
            <span className="text-muted-foreground">{index + 1}. {(step.offsetMs / 1000).toFixed(1)}s</span> <span className="font-medium">{step.action}</span>{" "}
            {step.target ? [step.target.role, step.target.label ?? step.target.text].filter(Boolean).join(" ") : ""}
            {step.route ? <span className="text-muted-foreground"> on {step.route}</span> : null}
            {step.valueOmitted ? <span className="text-muted-foreground"> (value not recorded)</span> : null}
            {step.wrongHere ? <span className="text-failure"> ← wrong here</span> : null}
            {step.userObservation ? <span className="block text-muted-foreground">{step.userObservation}</span> : null}
            {step.captureRefs[0] ? <div className="mt-1 max-w-sm"><ContentRefPreview reference={step.captureRefs[0]} description={`Capture at step ${index + 1}`} compact /></div> : null}
          </li>
        ))}
      </ol>
      {spec.gaps.map((gap, i) => (
        <p key={i} className="text-xs text-amber-300">Gap{gap.afterStepId ? ` after ${gap.afterStepId}` : ""}: {gap.reason}</p>
      ))}
    </div>
  );
}
