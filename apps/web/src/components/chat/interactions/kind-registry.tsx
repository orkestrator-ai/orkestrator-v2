import type { ComponentType } from "react";
import type { RichInteractionKind } from "@orkestrator/protocol/rich-interactions";
import type { KindProps } from "./shared";
import { AlternativesCard } from "./kinds/AlternativesCard";
import { ChartSelectionCard } from "./kinds/ChartSelectionCard";
import { ChoiceCard } from "./kinds/ChoiceCard";
import { CodeReviewCard } from "./kinds/CodeReviewCard";
import { CollectionCard } from "./kinds/CollectionCard";
import {
  ContextPacketCard,
  DemonstrationCard,
  VoiceRequestCard,
} from "./kinds/ComposedRequestCards";
import { CriteriaCard } from "./kinds/CriteriaCard";
import { DiagnosticsCard } from "./kinds/DiagnosticsCard";
import { DiagramCard } from "./kinds/DiagramCard";
import { DocumentCard } from "./kinds/DocumentCard";
import { EvidenceCard } from "./kinds/EvidenceCard";
import { FeedbackCard } from "./kinds/FeedbackCard";
import { FormCard } from "./kinds/FormCard";
import { PlanCard } from "./kinds/PlanCard";
import { ResultReviewCard } from "./kinds/ResultReviewCard";
import { WidgetResultCard } from "./kinds/WidgetResultCard";
import { WorkflowActionsCard } from "./kinds/WorkflowActionsCard";

/**
 * The bounded registry of trusted interaction components: one renderer per
 * registered kind. There is no general component language: a kind this
 * client does not know shows its plain-text fallback instead.
 */
export const KIND_RENDERERS: Record<RichInteractionKind, ComponentType<KindProps<never>>> = {
  choice: ChoiceCard,
  form: FormCard,
  plan: PlanCard,
  collection: CollectionCard,
  "code-review": CodeReviewCard,
  feedback: FeedbackCard,
  "result-review": ResultReviewCard,
  document: DocumentCard,
  diagnostics: DiagnosticsCard,
  "chart-selection": ChartSelectionCard,
  diagram: DiagramCard,
  "widget-result": WidgetResultCard,
  evidence: EvidenceCard,
  "context-packet": ContextPacketCard,
  criteria: CriteriaCard,
  alternatives: AlternativesCard,
  "workflow-actions": WorkflowActionsCard,
  "voice-request": VoiceRequestCard,
  demonstration: DemonstrationCard,
} as Record<RichInteractionKind, ComponentType<KindProps<never>>>;
