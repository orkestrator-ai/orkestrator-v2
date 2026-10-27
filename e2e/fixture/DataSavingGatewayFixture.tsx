import { useEffect } from "react";
import { DataSavingSetting } from "../../apps/web/src/components/settings/DataSavingSetting";
import { useCoordinatedRead } from "../../apps/web/src/hooks/useCoordinatedRead";
import { startDataSavingReadPolicy } from "../../apps/web/src/lib/data-saving";
import { DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS } from "../../apps/web/src/lib/data-saving-policy";
import { notifyReadCoordinatorReconnected } from "../../apps/web/src/lib/read-coordinator";
import { createBrowserGatewayApi } from "../../apps/web/src/lib/native/web-gateway";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "../../apps/web/src/lib/native/events";

const gateway = createBrowserGatewayApi({
  reportBootMetrics: false,
  agentTestSessionActivity: false,
});

export function DataSavingGatewayFixture() {
  useEffect(() => startDataSavingReadPolicy(), []);
  const { state, invalidate } = useCoordinatedRead<{
    revision: number;
    state: string;
    emittedAt: number;
  }>({
    key: { resource: "data-saving-gateway", target: "synthetic-session" },
    demand: {
      intervalMs: 500,
      priority: "critical",
      dataSaving: { intervalMs: DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS },
    },
    read: () => gateway.invoke("baseline_read"),
    trackState: true,
  });
  useEffect(() => {
    const unlisten = gateway.listen("baseline-update", invalidate);
    const reconnect = gateway.listen(
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      notifyReadCoordinatorReconnected,
    );
    return () => {
      unlisten();
      reconnect();
    };
  }, [invalidate]);
  return (
    <main className="p-4">
      <DataSavingSetting />
      <output data-testid="gateway-state">{JSON.stringify(state?.value ?? null)}</output>
    </main>
  );
}
