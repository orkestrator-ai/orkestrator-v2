import { defineScopedService } from "@/lib/node-scope/scoped-service";
import { setReadCoordinatorDataSaving } from "@/lib/read-coordinator";
import { useUIChromeStore } from "@/stores/uiChromeStore";

interface DataSavingSource {
  getState(): { dataSaving: boolean };
  subscribe(listener: (state: { dataSaving: boolean }) => void): () => void;
}

/**
 * Feeds this client's data-saving preference into the window's read policy,
 * now and whenever it changes, so every node's reads follow it. The
 * preference only changes how often this client reads; nothing is sent to
 * the backend.
 */
export function startDataSavingReadPolicy(
  store: DataSavingSource = useUIChromeStore,
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

/**
 * Window-level (plan item 3014): the preference and the policy it feeds are
 * the window's, not a node's. It runs on the command scope only, because that
 * scope lives exactly as long as the window, and starting it on a second
 * scope would be a second writer of one window value.
 */
export const dataSavingReadPolicyService = defineScopedService(
  "data-saving-read-policy",
  (scope) => {
    if (scope.role !== "command") {
      throw new Error("The data-saving read policy is window-level; it runs on the command scope.");
    }
    return { stop: startDataSavingReadPolicy() };
  },
);
