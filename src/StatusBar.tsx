import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { columnCountForWidth } from "./masonry";
import { phaseLabel, sourceLabel, sourcePillClass } from "./status";

export interface StatusBarProps {
  apiReady: boolean;
  importing: boolean;
  importPhase?: string;
  importSource?: string;
  importDetail?: string;
  importDone: number;
  importTotal: number;
  importItems: number;
  downloadingCount: number;
  queuedCount: number;
  coverBuildingCount: number;
  coverQueuedCount: number;
  coverLoadingCount: number;
  itemCount: number;
  completedCount: number;
}

function formatProgress(done: number, total: number): string {
  if (total > 0) return `${done}/${total}`;
  if (done > 0) return `${done}`;
  return "";
}

export function StatusBar({
  apiReady,
  importing,
  importPhase,
  importSource,
  importDetail,
  importDone,
  importTotal,
  importItems,
  downloadingCount,
  queuedCount,
  coverBuildingCount,
  coverQueuedCount,
  coverLoadingCount,
  itemCount,
  completedCount,
}: StatusBarProps) {
  let message = "";
  let source = "";
  let progress = "";
  let mode: "connecting" | "importing" | "ready" = "ready";

  if (!apiReady) {
    mode = "connecting";
    message = "连接 API 中…";
  } else if (importing) {
    mode = "importing";
    message = phaseLabel(importPhase, importDetail);
    source = sourceLabel(importSource);
    const prog = formatProgress(importDone, importTotal);
    if (prog) {
      progress = `${prog}${importItems > 0 ? ` · 已显示 ${importItems} 项` : ""}`;
    } else if (importItems > 0) {
      progress = `${importItems} 项`;
    }
  } else {
    const parts: string[] = [];
    if (itemCount > 0) parts.push(`${itemCount} 项`);
    if (completedCount > 0) parts.push(`${completedCount} 已完成`);
    if (downloadingCount > 0) parts.push(`${downloadingCount} 项下载中`);
    if (queuedCount > 0) parts.push(`${queuedCount} 项排队`);
    if (coverBuildingCount > 0) parts.push(`${coverBuildingCount} 个封面构建中`);
    if (coverQueuedCount > 0) parts.push(`${coverQueuedCount} 个封面队列`);
    if (coverLoadingCount > 0) parts.push(`${coverLoadingCount} 个封面请求中`);
    progress = parts.join(" · ");
  }

  const pillClass = sourcePillClass(importSource);
  const showPill = Boolean(source) && mode === "importing";

  return (
    <div
      className={[
        "stats",
        mode !== "ready" ? "stats--active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-live="polite"
    >
      {mode === "connecting" && <span className="status-bar-spinner" />}
      {message && <span className="stats-message">{message}</span>}
      {showPill && (
        <span className={["status-pill", pillClass].join(" ")}>{source}</span>
      )}
      {progress && <span className="stats-progress">{progress}</span>}
    </div>
  );
}

const SKELETON_MIN_COL = 280;
const SKELETON_GAP = 16;
/** Varied cover-like ratios to mimic real masonry tile heights. */
const SKELETON_ASPECTS = [
  4 / 3,
  3 / 4,
  1,
  9 / 16,
  16 / 9,
  5 / 4,
  2 / 3,
  4 / 5,
  3 / 2,
  1.1,
  0.85,
  1.35,
] as const;

function useSkeletonColumns(minColumnWidth: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number) => {
      setColumns(columnCountForWidth(width, minColumnWidth, gap));
    };
    update(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      update(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [gap, minColumnWidth]);

  return { ref, columns };
}

export function AppSkeleton() {
  const { ref, columns } = useSkeletonColumns(SKELETON_MIN_COL, SKELETON_GAP);
  const tilesPerCol = Math.max(3, Math.ceil(12 / columns));
  const buckets = Array.from({ length: columns }, (_, col) =>
    Array.from({ length: tilesPerCol }, (_, row) => {
      const index = row * columns + col;
      return SKELETON_ASPECTS[index % SKELETON_ASPECTS.length];
    }),
  );

  return (
    <div className="app-skeleton content-split" aria-hidden="true">
      <section className="section media-section app-skeleton-media">
        <div className="app-skeleton-bar app-skeleton-bar--title" />
        <div
          ref={ref}
          className="masonry-flow app-skeleton-masonry"
          style={{ "--masonry-gap": `${SKELETON_GAP}px` } as CSSProperties}
        >
          <div className="masonry-columns">
            {buckets.map((aspects, colIndex) => (
              <div key={colIndex} className="masonry-col">
                {aspects.map((aspect, rowIndex) => (
                  <div
                    key={rowIndex}
                    className="app-skeleton-tile"
                    style={{ aspectRatio: `1 / ${aspect}` }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
      <aside className="message-panel app-skeleton-panel">
        <div className="message-panel-header">
          <div className="app-skeleton-bar app-skeleton-bar--panel-title" />
          <div className="app-skeleton-bar app-skeleton-bar--panel-count" />
        </div>
        <div className="app-skeleton-panel-list">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="app-skeleton-msg">
              <div className="app-skeleton-bar app-skeleton-bar--msg-meta" />
              <div className="app-skeleton-bar app-skeleton-bar--msg-line" />
              <div className="app-skeleton-bar app-skeleton-bar--msg-line-short" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
