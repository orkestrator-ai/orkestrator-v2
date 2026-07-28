import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getComposeDraft } from "@/lib/backend";
import {
  composeDraftKey,
  discardComposeDraft,
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
  const hydratedKeyRef = useRef<string | null>(null);

  valueRef.current = value;
  initialRef.current = initialValue;

  useEffect(() => {
    if (!enabled) {
      hydratedKeyRef.current = null;
      return;
    }
    let disposed = false;
    const valueAtRequest = valueRef.current;
    setValue(initialRef.current);
    valueRef.current = initialRef.current;

    void getComposeDraft<T>(key)
      .then((persisted) => {
        if (
          disposed
          || !persisted
          || !isValid(persisted.value)
          || valueRef.current !== initialRef.current
          || valueAtRequest !== initialRef.current
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
        if (!disposed) hydratedKeyRef.current = key;
      });

    return () => {
      disposed = true;
      if (hydratedKeyRef.current === key) hydratedKeyRef.current = null;
    };
  }, [enabled, isValid, key, namespace]);

  useEffect(() => {
    if (!enabled || hydratedKeyRef.current !== key) return;
    const timer = setTimeout(() => {
      const operation = isEmpty(value)
        ? discardComposeDraft(key)
        : persistComposeDraft(key, ownerType, ownerId, value);
      void operation.catch((error) => {
        console.warn(`[${namespace}] Failed to persist draft:`, error);
      });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, enabled, isEmpty, key, namespace, ownerId, ownerType, value]);

  const clear = useCallback(async () => {
    valueRef.current = initialRef.current;
    setValue(initialRef.current);
    await discardComposeDraft(key);
  }, [key]);

  return [value, setValue, clear];
}
