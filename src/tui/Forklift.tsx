import { Box, Text } from "ink";
import type { Theme } from "./theme.ts";

/**
 * The forklift: syncy's mark, top left. Side profile, facing left.
 *
 *     ▓┃▄▄     a crate on the forks, the full-height mast, the low back
 *     ━┻◍◍     the forks, and two wheels
 *
 * Two rows and four columns, after four earlier attempts. The first had no
 * forks, which is the one feature that makes a forklift legible. The second
 * had forks but so much body detail that nothing resolved. The third was
 * legible but larger than a mark needs to be. The fourth drew the back at full
 * mast height, which made the whole thing read as one solid bar — a forklift is
 * recognisable because its mast is tall and everything behind it is low, so the
 * back is drawn with half-height blocks that sit below the mast's top.
 *
 * At this size there is no mast for the crate to climb, so the motion is the
 * wheels. It only turns while a check or a sync is running, which means motion
 * on this screen says work is happening and standing still says it is not.
 * That is what earns it a place in an interface that otherwise refuses
 * decoration.
 */

const WHEELS = ["◍◍", "◉◍", "◍◉"] as const;

export interface ForkliftProps {
  readonly theme: Theme;
  /** Advances the cycle. Ignored when `moving` is false. */
  readonly frame: number;
  readonly moving: boolean;
}

export function forkliftRows(frame: number, moving: boolean): readonly string[] {
  // Square-on wheels at rest; they only turn while something is running.
  const wheels = moving ? WHEELS[frame % WHEELS.length]! : WHEELS[0];
  return ["▓┃▄▄", `━┻${wheels}`];
}

export function Forklift({ theme, frame, moving }: ForkliftProps): React.ReactElement {
  const rows = forkliftRows(frame, moving);
  // Amber while working, so the colour says what the motion says — and still
  // reads if the motion is not noticeable.
  const colour = moving ? theme.unverified : theme.dim;
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => (
        <Text key={i} color={colour}>
          {" " + r}
        </Text>
      ))}
    </Box>
  );
}
