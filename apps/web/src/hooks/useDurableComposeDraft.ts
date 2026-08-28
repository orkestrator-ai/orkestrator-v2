import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  composeDraftKey,
  createDraftRevisionState,
  discardComposeDraft,
  DraftRevisionConflictError,
  loadComposeDraft,
  persistComposeDraft,
  resolveComposeDraftDiscardConflict,
  resolveComposeDraftSaveConflict,
} from "@/lib/compose-draft-persistence";

interface DurableComposeDraftOptions<T> {
  ownerType: "environment" | "project";
  ownerId: string;
  namespace: string;
  localKey: string;
  initialValue: T;
  isEmpty: (value: T) => boolean;
  isValid: (value: unknown) => value is T;
  enabled?: boolean;
  debounceMs?: number;
}

/**
 * Backend-authoritative durability for user input that is not yet submitted.
 *
 * Input typed while hydration is in flight wins over the stored snapshot.
 * Writes are serialized by compose-draft-persistence, so a late save cannot
 * resurrect a draft after a successful submit deletes it.
 */
export function useDurableComposeDraft<T>({
  ownerType,
  ownerId,
  namespace,
  localKey,
  initialValue,
  isEmpty,
  isValid,
  enabled = true,
  debounceMs = 400,
}: DurableComposeDraftOptions<T>): [
  T,
  Dispatch<SetStateAction<T>>,
  () => Promise<void>,
  () => Promise<void>,
] {
  const key = useMemo(
    () => composeDraftKey(namespace, ownerId, localKey),
    [localKey, namespace, ownerId],
  );
  const revisionState = useMemo(createDraftRevisionState, [key]);
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(value);
  const initialRef = useRef(initialValue);
  const isEmptyRef = useRef(isEmpty);
  const isValidRef = useRef(isValid);
  const editRevisionRef = useRef(0);
  const clearedKeyRef = useRef<string | null>(null);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);

  valueRef.current = value;
  initialRef.current = initialValue;
  isEmptyRef.current = isEmpty;
  isValidRef.current = isValid;

  const persistValue = useCallback(
    (draftKey: string, nextValue: T): Promise<void> =>
      clearedKeyRef.current === draftKey || isEmptyRef.current(nextValue)
        ? discardComposeDraft(draftKey, revisionState)
        : persistComposeDraft(draftKey, ownerType, ownerId, nextValue, revisionState),
    [ownerId, ownerType, revisionState],
  );

  const reportPersistenceError = useCallback(
    (error: unknown, draftKey: string): void => {
      const discarding = clearedKeyRef.current === draftKey || isEmptyRef.current(valueRef.current);
      if (!(error instanceof DraftRevisionConflictError)) {
        console.warn(`[${namespace}] Failed to persist draft:`, error);
        toast.error(discarding ? "Draft could not be cleared" : "Draft could not be saved", {
          id: `compose-draft-persistence:${draftKey}`,
          description: discarding
            ? "The saved recovery draft could not be removed. It may reappear the next time you open this view."
            : "Your input is still here, but it may be lost if you close or reload this view. Copy it somewhere safe or try editing again.",
        });
        return;
      }
      toast.error("Draft changed in another window", {
        id: `compose-draft-conflict:${draftKey}`,
        description: discarding
          ? "A newer saved draft was preserved. Discard it explicitly to finish clearing this input."
          : "Your input is still here. Choose Save mine to replace the other saved draft.",
        action: {
          label: discarding ? "Discard saved draft" : "Save mine",
          onClick: () => {
            const latest = valueRef.current;
            const operation =
              clearedKeyRef.current === draftKey || isEmptyRef.current(latest)
                ? resolveComposeDraftDiscardConflict(draftKey, revisionState)
                : resolveComposeDraftSaveConflict(
                    draftKey,
                    ownerType,
                    ownerId,
                    latest,
                    revisionState,
                  );
            void operation.catch((retryError) => {
              reportPersistenceError(retryError, draftKey);
            });
          },
        },
      });
    },
    [namespace, ownerId, ownerType, revisionState],
  );

  useEffect(() => {
    if (!enabled) {
      setHydratedKey(null);
      return;
    }
    let disposed = false;
    let hydrated = false;
    let loadSucceeded = false;
    const revisionAtRequest = editRevisionRef.current;
    setValue(initialRef.current);
    valueRef.current = initialRef.current;

    void loadComposeDraft<T>(key, revisionState)
      .then((persisted) => {
        loadSucceeded = true;
        if (
          disposed ||
          !persisted ||
          !isValidRef.current(persisted.value) ||
          editRevisionRef.current !== revisionAtRequest
        ) {
          return;
        }
        valueRef.current = persisted.value;
        setValue(persisted.value);
      })
      .catch((error) => {
        console.warn(`[${namespace}] Failed to restore draft:`, error);
      })
      .finally(() => {
        if (!disposed && loadSucceeded) {
          hydrated = true;
          setHydratedKey(key);
        }
      });

    return () => {
      disposed = true;
      setHydratedKey((current) => (current === key ? null : current));
      // A completed hydration or any local edit makes valueRef authoritative.
      // Flush immediately because the ordinary debounce is cancelled by this
      // same unmount/key-change cleanup.
      if (hydrated || editRevisionRef.current !== revisionAtRequest) {
        void persistValue(key, valueRef.current).catch((error) => {
          reportPersistenceError(error, key);
        });
      }
    };
  }, [enabled, key, namespace, persistValue, reportPersistenceError, revisionState]);

  useEffect(() => {
    if (!enabled || hydratedKey !== key) return;
    const timer = setTimeout(() => {
      void persistValue(key, value).catch((error) => {
        reportPersistenceError(error, key);
      });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, enabled, hydratedKey, key, persistValue, reportPersistenceError, value]);

  const setDraftValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const nextValue =
        typeof action === "function" ? (action as (previous: T) => T)(valueRef.current) : action;
      editRevisionRef.current += 1;
      clearedKeyRef.current = null;
      valueRef.current = nextValue;
      setValue(nextValue);
      setHydratedKey(key);
    },
    [key],
  );

  const clear = useCallback(async () => {
    editRevisionRef.current += 1;
    clearedKeyRef.current = key;
    valueRef.current = initialRef.current;
    setValue(initialRef.current);
    try {
      await discardComposeDraft(key, revisionState);
    } catch (error) {
      reportPersistenceError(error, key);
      throw error;
    }
  }, [key, reportPersistenceError, revisionState]);

  // Successful submissions need to remove the durable recovery record without
  // rewriting the live editor. A save can finish after React has accepted a
  // newer edit, so resetting to initialValue here would destroy that input.
  const discardPersisted = useCallback(async () => {
    editRevisionRef.current += 1;
    clearedKeyRef.current = key;
    try {
      await discardComposeDraft(key, revisionState);
    } catch (error) {
      reportPersistenceError(error, key);
      throw error;
    }
  }, [key, reportPersistenceError, revisionState]);

  return [value, setDraftValue, clear, discardPersisted];
}
