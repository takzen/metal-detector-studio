// Stable per-harmonic colors (by harmonic order).
export const HARMONIC_COLORS = [
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#a855f7", // purple
  "#14b8a6", // teal
];

export const colorFor = (index: number): string =>
  HARMONIC_COLORS[index % HARMONIC_COLORS.length];
