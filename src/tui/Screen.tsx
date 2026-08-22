import { Box, Text } from "ink";
import type { Theme } from "./theme.ts";

/**
 * The frame every screen sits in.
 *
 * Fills the terminal in both dimensions: content at the top, a flexible spacer,
 * and the footer pinned to the bottom edge. Without this a short screen bunches
 * into the top-left corner of a large window with its keys floating mid-screen.
 *
 * Rules are drawn to the measured width rather than a fixed 76, so they reach
 * the edge of whatever window they are in.
 */

export interface ScreenProps {
  readonly title: string;
  readonly width: number;
  readonly height?: number;
  readonly theme: Theme;
  /** Pinned to the bottom edge. */
  readonly footer?: React.ReactNode;
  readonly children: React.ReactNode;
}

export function Screen({
  title,
  width,
  height,
  theme,
  footer,
  children,
}: ScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column" height={height} width={width + 2}>
      <Text color={theme.ink}>{"  " + title}</Text>
      <Text> </Text>
      <Box flexDirection="column">{children}</Box>
      {/* Absorbs the leftover rows so the footer stays on the bottom line. */}
      <Box flexGrow={1} />
      {footer === undefined ? null : <Box flexDirection="column">{footer}</Box>}
    </Box>
  );
}

/** A horizontal rule at the screen's measured width. */
export function Rule({
  width,
  theme,
  char = "─",
}: {
  readonly width: number;
  readonly theme: Theme;
  readonly char?: string;
}): React.ReactElement {
  return <Text color={theme.rule}>{"  " + char.repeat(width)}</Text>;
}
