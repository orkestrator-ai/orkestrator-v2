import { useRef, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useScrollOffsetAcrossHide } from "@/hooks/useScrollOffsetAcrossHide";
import { useWidthAtLeast } from "@/hooks/useWidthAtLeast";

export type InspectorBodyTab = "transcript" | "report";

/**
 * The inspector's lower section: the node's transcript, and the report it
 * filed once there is one. Side by side when the inspector is wide enough for
 * both to be read at once; otherwise tabs, with the transcript kept mounted
 * behind the report so returning to it keeps its scroll position and follow
 * state.
 */
export function InspectorTranscriptTabs({
  transcript,
  report,
  tab,
  onTabChange,
}: {
  transcript: ReactNode;
  report: ReactNode;
  tab: InspectorBodyTab;
  onTabChange: (tab: InspectorBodyTab) => void;
}) {
  const [measureRef, sideBySide] = useWidthAtLeast<HTMLDivElement>(INSPECTOR_SPLIT_MIN_WIDTH_PX);
  const reportRef = useRef<HTMLDivElement>(null);
  useScrollOffsetAcrossHide(reportRef);
  return (
    // Reflow must not let browser scroll anchoring move a reader's saved offset.
    <div
      ref={measureRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col [&_[role=log]]:[overflow-anchor:none]"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as InspectorBodyTab)}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      >
        <TabsList
          aria-label="Inspector views"
          hidden={sideBySide || !report}
          className={sideBySide || !report ? "hidden" : "h-7 rounded-md p-0.5"}
        >
          <TabsTrigger className="h-6 px-2 text-xs" value="transcript">
            Transcript
          </TabsTrigger>
          <TabsTrigger className="h-6 px-2 text-xs" value="report">
            Report
          </TabsTrigger>
        </TabsList>
        <div
          data-testid={sideBySide && report ? "multi-review-inspector-side-by-side" : undefined}
          className={
            sideBySide && report
              ? "flex h-0 min-h-[28rem] min-w-0 flex-[1_1_0px] gap-4"
              : report
                ? "flex h-0 min-h-[28rem] min-w-0 flex-[1_1_0px] flex-col"
                : "flex min-h-0 min-w-0 flex-1 flex-col"
          }
        >
          <TabsContent
            value="transcript"
            forceMount
            role={sideBySide ? "region" : "tabpanel"}
            aria-label="Transcript"
            hidden={!sideBySide && Boolean(report) && tab !== "transcript"}
            className={`flex min-h-0 min-w-0 flex-col ${!sideBySide && report ? "data-[state=inactive]:hidden" : ""}`}
          >
            {transcript}
          </TabsContent>
          <TabsContent
            ref={reportRef}
            value="report"
            forceMount
            role={sideBySide ? "region" : "tabpanel"}
            aria-label="Report"
            hidden={!report || (!sideBySide && tab !== "report")}
            tabIndex={0}
            className={
              !report
                ? "hidden"
                : sideBySide
                  ? "min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-lg focus-hairline"
                  : "min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-lg focus-hairline data-[state=inactive]:hidden"
            }
          >
            {report}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

/**
 * Width of the inspector body at which the transcript and the report sit side
 * by side: each column then gets about 32rem, enough for both to stay readable.
 */
export const INSPECTOR_SPLIT_MIN_WIDTH_PX = 1024;
