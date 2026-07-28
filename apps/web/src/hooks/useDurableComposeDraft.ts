import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  composeDraftKey,
  discardComposeDraft,
  loadComposeDraft,
  persistComposeDraft,
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
] {
  const key = useMemo(
    () => composeDraftKey(namespace, ownerId, localKey),
    [localKey, namespace, ownerId],
  );
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

  const persistValue = useCallback((
    draftKey: string,
    nextValue: T,
  ): Promise<void> => (
    clearedKeyRef.current === draftKey || isEmptyRef.current(nextValue)
      ? discardComposeDraft(draftKey)
      : persistComposeDraft(draftKey, ownerType, ownerId, nextValue)
  ), [ownerId, ownerType]);

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

    void loadComposeDraft<T>(key)
      .then((persisted) => {
        loadSucceeded = true;
        if (
          disposed
          || !persisted
          || !isValidRef.current(persisted.value)
          || editRevisionRef.current !== revisionAtRequest
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
      setHydratedKey((current) => current === key ? null : current);
      // A completed hydration or any local edit makes valueRef authoritative.
      // Flush immediately because the ordinary debounce is cancelled by this
      // same unmount/key-change cleanup.
      if (hydrated || editRevisionRef.current !== revisionAtRequest) {
        void persistValue(key, valueRef.current).catch((error) => {
          console.warn(`[${namespace}] Failed to persist draft during cleanup:`, error);
        });
      }
    };
  }, [enabled, key, namespace, persistValue]);

  useEffect(() => {
    if (!enabled || hydratedKey !== key) return;
    const timer = setTimeout(() => {
      void persistValue(key, value).catch((error) => {
        console.warn(`[${namespace}] Failed to persist draft:`, error);
      });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, enabled, hydratedKey, key, namespace, persistValue, value]);

  const setDraftValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const nextValue = typeof action === "function"
      ? (action as (previous: T) => T)(valueRef.current)
      : action;
    editRevisionRef.current += 1;
    clearedKeyRef.current = null;
    valueRef.current = nextValue;
    setValue(nextValue);
    setHydratedKey(key);
  }, [key]);

  const clear = useCallback(async () => {
    editRevisionRef.current += 1;
    clearedKeyRef.current = key;
    valueRef.current = initialRef.current;
    setValue(initialRef.current);
    await discardComposeDraft(key);
  }, [key]);

  return [value, setDraftValue, clear];
}
