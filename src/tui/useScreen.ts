import { useEffect, useState } from "react";

/**
 * Terminal dimensions, tracked across resizes.
 *
 * Ink's useStdout reports the size at mount and does not update, so a resized
 * window would leave the ledger drawing to the old width — which in a layout
 * built entirely from padded columns means visible shearing.
 */

export interface Screen {
  readonly columns: number;
  readonly rows: number;
  /** Content width: the ledger indents by two and keeps a right margin. */
  readonly width: number;
}

const MIN_WIDTH = 76;
const MAX_WIDTH = 110;
const MIN_ROWS = 12;

export function measure(stdout: NodeJS.WriteStream | undefined): Screen {
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  return {
    columns,
    rows: Math.max(MIN_ROWS, rows),
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns - 2)),
  };
}

export function useScreen(stdout: NodeJS.WriteStream | undefined): Screen {
  const [screen, setScreen] = useState<Screen>(() => measure(stdout));

  useEffect(() => {
    if (stdout === undefined) return;
    const onResize = (): void => setScreen(measure(stdout));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return screen;
}
