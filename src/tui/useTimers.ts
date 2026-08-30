import { useCallback, useEffect, useRef } from "react";

/**
 * Timers that do not outlive the interface.
 *
 * Every message on screen clears itself on a timer — three seconds for a
 * refused key, eight for the one naming a destination a run had to skip, which
 * is the message that has to be read. Nothing calls `process.exit` when the
 * interface unmounts, so the process ends only once the event loop drains, and
 * a pending timer of that length held it open for the rest of its delay after
 * the alternate screen had already been handed back: the terminal looked
 * restored and the shell prompt did not return. Measured at 2483 ms for the
 * ordinary case of quitting straight after a check.
 *
 * `Job` had always cleared its own notice timer on unmount. This is that,
 * where every screen can reach it.
 */
export interface Timers {
  /** `setTimeout` that forgets itself when it fires, and is dropped on unmount. */
  readonly later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Drops one before it fires — for a message being replaced by a newer one. */
  readonly cancel: (id: ReturnType<typeof setTimeout>) => void;
}

export function useTimers(): Timers {
  const pending = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = setTimeout(() => {
      pending.current.delete(id);
      fn();
    }, ms);
    pending.current.add(id);
    return id;
  }, []);

  const cancel = useCallback((id: ReturnType<typeof setTimeout>): void => {
    clearTimeout(id);
    pending.current.delete(id);
  }, []);

  useEffect(() => {
    const live = pending.current;
    return () => {
      for (const id of live) clearTimeout(id);
      live.clear();
    };
  }, []);

  return { later, cancel };
}
