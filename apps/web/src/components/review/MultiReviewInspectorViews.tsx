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
  if (!report) return transcript;
  return (
    <div ref={measureRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {sideBySide ? (
        <InspectorSideBySide transcript={transcript} report={report} />
      ) : (
        <InspectorTabbedViews
          transcript={transcript}
          report={report}
          tab={tab}
          onTabChange={onTabChange}
        />
      )}
    </div>
  );
}

/**
 * Width of the inspector body at which the transcript and the report sit side
 * by side: each column then gets about 32rem, enough for both to stay readable.
 */
export const INSPECTOR_SPLIT_MIN_WIDTH_PX = 1024;

/**
 * Transcript and report as two columns of the inspector's remaining height,
 * each scrolling on its own. The zero-length basis keeps a long report
 * scrolling in its column rather than growing the inspector, as the
 * transcript tail does.
 */
function InspectorSideBySide({ transcript, report }: { transcript: ReactNode; report: ReactNode }) {
  const reportRef = useRef<HTMLElement>(null);
  useScrollOffsetAcrossHide(reportRef);
  return (
    <div
      data-testid="multi-review-inspector-side-by-side"
      className="flex h-0 min-h-[28rem] min-w-0 flex-[1_1_0px] gap-4"
    >
      <section aria-label="Transcript" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {transcript}
      </section>
      <section
        ref={reportRef}
        aria-label="Report"
        tabIndex={0}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-lg focus-hairline"
      >
        {report}
      </section>
    </div>
  );
}

function InspectorTabbedViews({
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
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as InspectorBodyTab)}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
    >
      <TabsList aria-label="Inspector views" className="h-7 rounded-md p-0.5">
        <TabsTrigger className="h-6 px-2 text-xs" value="transcript">
          Transcript
        </TabsTrigger>
        <TabsTrigger className="h-6 px-2 text-xs" value="report">
          Report
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="transcript"
        forceMount
        className="flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden"
      >
        {transcript}
      </TabsContent>
      <TabsContent value="report" className="min-w-0">
        {report}
      </TabsContent>
    </Tabs>
  );
}
