import { Box, Text } from "ink";
import type { Theme } from "./theme.ts";

/**
 * The forklift: syncy's mark, top left. Side profile, facing left.
 *
 *     ▄┃█▄     a crate on the forks, the full-height mast, the cab, the low tail
 *     ━┻◍◍     the forks, and two wheels
 *
 * Two rows and four columns, after four earlier attempts. The first had no
 * forks, which is the one feature that makes a forklift legible. The second
 * had forks but so much body detail that nothing resolved. The third was
 * legible but larger than a mark needs to be. The fourth drew the whole back
 * at full mast height, which made the thing read as one solid bar — a forklift
 * is recognisable because it steps down behind the mast, so the tail is a
 * half-height block sitting below the top of the cab.
 *
 * The motion is a load being lifted. The wheels rock and the crate climbs the
 * mast in the same cycle: on the forks, halfway up, at the top, and back down
 * — four frames, so a full lift takes just under a second at the 220 ms tick.
 * Wheels and crate move together because a lift that moved while the wheels
 * stood still would read as two marks rather than one machine.
 *
 * It only moves while a check or a sync is running, which means motion on this
 * screen says work is happening and standing still says it is not. That is
 * what earns it a place in an interface that otherwise refuses decoration.
 */

/** The wheels rock left, right, left, right — one spoke turning under load. */
const WHEELS = ["◍◍", "◉◍", "◍◉", "◉◍"] as const;

/** The crate's height on the mast: on the forks, halfway, at the top, halfway. */
const LIFT = ["▄", "█", "▀", "█"] as const;

export interface ForkliftProps {
  readonly theme: Theme;
  /** Advances the cycle. Ignored when `moving` is false. */
  readonly frame: number;
  readonly moving: boolean;
}

export function forkliftRows(frame: number, moving: boolean): readonly string[] {
  // Square-on wheels and the crate down on the forks at rest; both only move
  // while something is running, and frame 0 is that resting pose.
  const phase = moving ? frame % WHEELS.length : 0;
  return [`${LIFT[phase]!}┃█▄`, `━┻${WHEELS[phase]!}`];
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
