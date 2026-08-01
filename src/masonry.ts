import type { Item } from "./types";

export function columnCountForWidth(
  width: number,
  minColumnWidth: number,
  gap: number,
): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
}

function pickShortestColumn(heights: number[]): number {
  let best = 0;
  for (let i = 1; i < heights.length; i += 1) {
    if (heights[i]! < heights[best]!) best = i;
  }
  return best;
}

/**
 * Pack items into columns by running height (shortest-column).
 * When `previousAssignment` is provided, known item ids keep their column so
 * load-more only fills the shortest columns instead of reshuffling the grid.
 */
export function packIntoColumns(
  items: Item[],
  columnCount: number,
  estimateHeight: (item: Item) => number,
  gap: number,
  previousAssignment?: ReadonlyMap<string, number> | null,
): { buckets: Item[][]; assignment: Map<string, number> } {
  const cols = Math.max(1, columnCount);
  const buckets: Item[][] = Array.from({ length: cols }, () => []);
  const heights = new Array<number>(cols).fill(0);
  const assignment = new Map<string, number>();
  const reuse = previousAssignment != null && previousAssignment.size > 0;

  for (const item of items) {
    let col = reuse ? previousAssignment.get(item.id) : undefined;
    if (col == null || col < 0 || col >= cols) {
      col = pickShortestColumn(heights);
    }

    if (buckets[col]!.length > 0) heights[col]! += gap;
    heights[col]! += Math.max(1, estimateHeight(item));
    buckets[col]!.push(item);
    assignment.set(item.id, col);
  }

  return { buckets, assignment };
}
