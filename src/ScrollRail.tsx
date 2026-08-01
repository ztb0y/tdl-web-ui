import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildRailLayout,
  RAIL_HEIGHT_RATIO,
  RAIL_LINE_GAP,
  railBatchIndexAtPosition,
  railHeightPx,
  scrollToItem,
  type RailSectionLayout,
  type ScrollBatch,
} from "./scrollNavigation";
import type { Item } from "./types";

const SECTION_META = [
  { id: "section-media", label: "媒体" },
] as const;

const RAIL_SHIFT_MS = 900;
const RAIL_SHIFT_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

type ScrollRailProps = {
  collapsed?: boolean;
  items: Item[];
};

type FlatRailLine = {
  key: string;
  globalIndex: number;
  kind: "batch";
  label: string;
  active: boolean;
  onClick: () => void;
};

function readViewportHeight() {
  if (typeof window === "undefined") return 800;
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

function useViewportHeight() {
  const [height, setHeight] = useState(readViewportHeight);

  useEffect(() => {
    const update = () => {
      const next = readViewportHeight();
      setHeight((prev) => (prev === next ? prev : next));
    };

    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);

    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);

  return height;
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function findBatchForItem(
  sections: RailSectionLayout[],
  itemId: string,
): { sectionId: string; batchIndex: number; batch: ScrollBatch } | null {
  for (const section of sections) {
    for (let i = 0; i < section.batches.length; i += 1) {
      const batch = section.batches[i];
      if (!batch) continue;
      if (batch.items.some((item) => item.id === itemId)) {
        return { sectionId: section.id, batchIndex: i, batch };
      }
    }
  }
  return null;
}

function resolveActiveFromViewport(sections: RailSectionLayout[]): {
  sectionId: string;
  batchIndex: number;
  batch: ScrollBatch;
} | null {
  const viewportHeight = readViewportHeight();
  const anchor = viewportHeight * 0.42;
  let selected:
    | {
        section: RailSectionLayout;
        rect: DOMRect;
      }
    | undefined;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const section of sections) {
    const el = document.getElementById(section.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const dist =
      anchor < rect.top
        ? rect.top - anchor
        : anchor > rect.bottom
          ? anchor - rect.bottom
          : 0;
    if (dist < bestDist) {
      bestDist = dist;
      selected = { section, rect };
    }
  }
  if (!selected) return null;

  const { section, rect } = selected;
  const batchIndex = railBatchIndexAtPosition(
    anchor - rect.top,
    rect.height,
    section.batches.length,
  );
  if (batchIndex == null) return null;
  const batch = section.batches[batchIndex];
  if (!batch) return null;
  return { sectionId: section.id, batchIndex, batch };
}

/** Invert the whole track so the old active point stays put, then ease to rest. */
function playSeamlessTrackShift(track: HTMLElement, dy: number) {
  if (prefersReducedMotion() || Math.abs(dy) < 0.5) return;

  for (const animation of track.getAnimations()) {
    animation.cancel();
  }

  track.animate(
    [
      { transform: `translateY(${dy}px)` },
      { transform: "translateY(0px)" },
    ],
    {
      duration: RAIL_SHIFT_MS,
      easing: RAIL_SHIFT_EASE,
      fill: "none",
    },
  );
}

export function ScrollRail({ collapsed = false, items }: ScrollRailProps) {
  const viewportHeight = useViewportHeight();
  const trackRef = useRef<HTMLDivElement>(null);

  const sections = useMemo<RailSectionLayout[]>(
    () =>
      buildRailLayout(viewportHeight, [
        { id: SECTION_META[0].id, label: SECTION_META[0].label, items },
      ]),
    [viewportHeight, items],
  );

  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const activePositionRef = useRef<{
    sectionId: string;
    batchIndex: number | null;
  }>({ sectionId: SECTION_META[0].id, batchIndex: null });
  const contentAnchorRef = useRef<string | null>(null);
  const itemCountRef = useRef(items.length);
  const lastScrollYRef = useRef(
    typeof window === "undefined" ? 0 : window.scrollY,
  );
  const activeBatchIdRef = useRef<string | null>(null);
  activeBatchIdRef.current = activeBatchId;

  const flatLines = useMemo(() => {
    const lines: FlatRailLine[] = [];
    let globalIndex = 0;

    for (const section of sections) {
      section.batches.forEach((batch) => {
        lines.push({
          key: batch.id,
          globalIndex,
          kind: "batch",
          label: batch.label || `${batch.items.length} 项`,
          active: activeBatchId === batch.id,
          onClick: () => scrollToItem(batch.startItemId),
        });
        globalIndex += 1;
      });
    }

    return lines;
  }, [sections, activeBatchId]);

  const rememberActive = (
    sectionId: string,
    batchIndex: number,
    batch: ScrollBatch,
  ) => {
    activePositionRef.current = { sectionId, batchIndex };
    const mid = batch.items[Math.floor(batch.items.length / 2)];
    contentAnchorRef.current = mid?.id ?? batch.startItemId;
    setActiveBatchId((prev) => (prev === batch.id ? prev : batch.id));
  };

  // Load-more: remap anchor, then FLIP the entire track upward as one piece.
  useLayoutEffect(() => {
    const prevCount = itemCountRef.current;
    const nextCount = items.length;
    itemCountRef.current = nextCount;

    if (nextCount <= prevCount || prevCount === 0) return;

    const track = trackRef.current;
    if (!track) return;

    const prevId = activeBatchIdRef.current;
    const prevBtn = prevId
      ? track.querySelector<HTMLElement>(
          `[data-rail-key="${CSS.escape(prevId)}"]`,
        )
      : null;
    const prevTop = prevBtn?.getBoundingClientRect().top;

    const anchorId = contentAnchorRef.current;
    const located = anchorId ? findBatchForItem(sections, anchorId) : null;
    const mapped = located ?? resolveActiveFromViewport(sections);
    if (!mapped) return;

    rememberActive(mapped.sectionId, mapped.batchIndex, mapped.batch);

    const nextBtn = track.querySelector<HTMLElement>(
      `[data-rail-key="${CSS.escape(mapped.batch.id)}"]`,
    );
    const nextTop = nextBtn?.getBoundingClientRect().top;
    if (prevTop == null || nextTop == null) return;

    let dy = prevTop - nextTop;
    if (Math.abs(dy) < 0.5) {
      // Same tick slot after redistribute — still ease the axis by growth ratio.
      dy = Math.max(
        12,
        ((nextCount - prevCount) / nextCount) * track.clientHeight * 0.4,
      );
    }

    // Keep the old viewport point glued, then ease the whole axis up into place.
    playSeamlessTrackShift(track, dy);
  }, [items.length, sections]);

  useEffect(() => {
    let raf = 0;

    function updateActiveLine() {
      raf = 0;
      const resolved = resolveActiveFromViewport(sections);
      if (!resolved) return;

      let { batchIndex } = resolved;
      const scrollY = window.scrollY;
      const scrollDelta = scrollY - lastScrollYRef.current;
      if (Math.abs(scrollDelta) >= 1) lastScrollYRef.current = scrollY;

      const previous = activePositionRef.current;
      const section = sections.find((s) => s.id === resolved.sectionId);
      if (
        previous.sectionId === resolved.sectionId &&
        previous.batchIndex != null &&
        section
      ) {
        const previousIndex = Math.min(
          previous.batchIndex,
          Math.max(0, section.batches.length - 1),
        );
        if (scrollDelta >= 1) {
          batchIndex = Math.max(previousIndex, batchIndex);
        } else if (scrollDelta <= -1) {
          batchIndex = Math.min(previousIndex, batchIndex);
        } else {
          batchIndex = previousIndex;
        }
      }

      const batch = section?.batches[batchIndex];
      if (!batch) return;
      rememberActive(resolved.sectionId, batchIndex, batch);
    }

    function scheduleActiveLineUpdate() {
      if (raf) return;
      raf = window.requestAnimationFrame(updateActiveLine);
    }

    scheduleActiveLineUpdate();
    window.addEventListener("scroll", scheduleActiveLineUpdate, {
      passive: true,
    });
    window.addEventListener("resize", scheduleActiveLineUpdate);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", scheduleActiveLineUpdate);
      window.removeEventListener("resize", scheduleActiveLineUpdate);
    };
  }, [sections]);

  const railStyle = {
    height: `${railHeightPx(viewportHeight)}px`,
    ["--scroll-rail-line-gap" as string]: `${RAIL_LINE_GAP}px`,
    ["--scroll-rail-height-ratio" as string]: String(RAIL_HEIGHT_RATIO),
  };

  return (
    <nav
      className={[
        "scroll-rail",
        collapsed ? "scroll-rail--collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="媒体批次导航"
      style={railStyle}
    >
      <div className="scroll-rail-track" ref={trackRef}>
        {flatLines.map((line) => (
          <button
            key={line.key}
            type="button"
            className="scroll-rail-line-btn"
            data-rail-key={line.key}
            data-kind={line.kind}
            data-active={line.active ? "true" : undefined}
            onClick={line.onClick}
            aria-label={`跳转到${line.label}`}
            aria-current={line.active ? "true" : undefined}
            data-label={line.label}
          >
            <span className="scroll-rail-line" aria-hidden="true" />
            <span className="scroll-rail-label">{line.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
