import { setReadCoordinatorDataSaving } from "@/lib/read-coordinator";
import { useUIStore } from "@/stores/uiStore";

interface DataSavingSource {
  getState(): { dataSaving: boolean };
  subscribe(listener: (state: { dataSaving: boolean }) => void): () => void;
}

/**
 * Feeds this client's data-saving preference into the shared read
 * coordinator, now and whenever it changes. The preference only changes how
 * often this client reads; nothing is sent to the backend.
 */
export function startDataSavingReadPolicy(
  store: DataSavingSource = useUIStore,
  apply: (enabled: boolean) => void = setReadCoordinatorDataSaving,
): () => void {
  let current = store.getState().dataSaving;
  apply(current);
  return store.subscribe((state) => {
    if (state.dataSaving === current) return;
    current = state.dataSaving;
    apply(current);
  });
}
