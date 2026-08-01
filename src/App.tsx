import {
  useVirtualizer,
  useWindowVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Bookmark,
  ChevronDown,
  CloudDownload,
  FileText,
  X,
} from "lucide-react";
import {
  cacheItem,
  displayName,
  downloadItems,
  fetchChats,
  fetchItems,
  formatDuration,
  formatMessageDate,
  formatSize,
  importJSON,
  loadMoreChat,
  coverURL,
  mediaURL,
  pauseItem,
  pauseAllItems,
  progressPct,
  selectChat,
  statusLabel,
  subscribeEvents,
  updateCoverState,
} from "./api";
import { packIntoColumns } from "./masonry";
import { registerScrollTarget } from "./scrollNavigation";
import { MediaPreview } from "./MediaPreview";
import { ScrollRail } from "./ScrollRail";
import { AppSkeleton, StatusBar } from "./StatusBar";
import { AuthGate } from "./AuthGate";
import type {
  ChatInfo,
  Item,
  ItemsPayload,
  ProgressPayload,
  RangeType,
} from "./types";

type PlayerState =
  | { kind: "video"; item: Item }
  | { kind: "image"; item: Item }
  | null;
type PreviewTransitionMode = "zoom" | "film-fade";

const masonrySizeCache = new Map<string, number>();
/** Last measured tile box plus decoded cover ratio keep virtual top estimates stable across remounts. */
const masonryBoxCache = new Map<
  string,
  { width: number; height: number }
>();
const coverAspectCache = new Map<string, number>();
const VIRTUAL_BUFFER_SCREENS = 2;
const VIDEO_QUEUE_DISPLAY_LIMIT = 50;
const CARD_OVERLAY_SLIDE_MS = 220;
const DEFAULT_COVER_ASPECT = 4 / 3;
const viewportBufferSubs = new Set<() => void>();
let viewportBufferPx =
  typeof window !== "undefined"
    ? Math.round(window.innerHeight * VIRTUAL_BUFFER_SCREENS)
    : 1200;

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    viewportBufferPx = Math.round(window.innerHeight * VIRTUAL_BUFFER_SCREENS);
    viewportBufferSubs.forEach((fn) => fn());
  });
}

/** Shared viewport-height buffer (used by virtual overscan + cover lazy-load). */
function useViewportBufferPx() {
  const [px, setPx] = useState(viewportBufferPx);

  useEffect(() => {
    const sub = () => setPx(viewportBufferPx);
    viewportBufferSubs.add(sub);
    return () => {
      viewportBufferSubs.delete(sub);
    };
  }, []);

  return px;
}

function useLazyRootMargin() {
  const bufferPx = useViewportBufferPx();
  return `${bufferPx}px 0px`;
}

/** Overscan enough items to cover N viewport heights above/below the window. */
function useVirtualOverscan(estimateSize: number, gap: number) {
  const bufferPx = useViewportBufferPx();
  const calc = useCallback(() => {
    const row = Math.max(estimateSize + gap, 1);
    return Math.max(4, Math.ceil(bufferPx / row));
  }, [bufferPx, estimateSize, gap]);

  const [overscan, setOverscan] = useState(calc);

  useEffect(() => {
    setOverscan(calc());
  }, [calc]);

  return overscan;
}

function useScrollMargin(
  ref: RefObject<HTMLElement | null>,
  layoutKey0?: unknown,
  layoutKey1?: unknown,
  layoutKey2?: unknown,
) {
  const [scrollMargin, setScrollMargin] = useState(0);
  const scrollMarginRef = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = el.getBoundingClientRect().top + window.scrollY;
      if (Math.abs(next - scrollMarginRef.current) < 0.5) return;
      scrollMarginRef.current = next;
      setScrollMargin(next);
    };
    update();
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (document.body) ro.observe(document.body);
    const id = window.requestAnimationFrame(update);
    return () => {
      window.removeEventListener("resize", update);
      ro.disconnect();
      window.cancelAnimationFrame(id);
    };
  }, [ref, layoutKey0, layoutKey1, layoutKey2]);

  return scrollMargin;
}

function useColumnCount(minColumnWidth: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number) => {
      setWidth(width);
      setColumns(
        Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))),
      );
    };
    update(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      update(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [gap, minColumnWidth]);

  const columnWidth = useMemo(() => {
    if (width <= 0) return 0;
    return Math.max(1, (width - gap * (columns - 1)) / columns);
  }, [columns, gap, width]);

  return { ref, columns, columnWidth };
}

function cacheCoverAspect(id: string | undefined, img: HTMLImageElement) {
  if (!id || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
  coverAspectCache.set(id, img.naturalHeight / img.naturalWidth);
}

function readMasonryBox(
  element: Element,
  entry: ResizeObserverEntry | undefined,
) {
  let width = 0;
  let height = 0;
  if (entry?.borderBoxSize?.[0]) {
    const box = entry.borderBoxSize[0];
    width = box.inlineSize;
    height = box.blockSize;
  } else {
    const rect = element.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  }

  return {
    width: Math.max(0, Math.ceil(width)),
    height: Math.max(0, Math.ceil(height)),
  };
}

function estimateMasonryItemSize(
  item: Item | undefined,
  fallback: number,
  columnWidth: number,
) {
  if (!item) return fallback;

  if (item.type === "file" && columnWidth > 0) {
    return Math.max(1, Math.ceil(columnWidth * DEFAULT_COVER_ASPECT));
  }

  const ratio = coverAspectCache.get(item.id);
  if (ratio && columnWidth > 0) {
    return Math.max(1, Math.ceil(columnWidth * ratio));
  }

  if (item.cover_aspect && item.cover_aspect > 0 && columnWidth > 0) {
    return Math.max(1, Math.ceil(columnWidth * item.cover_aspect));
  }

  const measured = masonryBoxCache.get(item.id);
  if (measured && measured.height > 0) {
    if (columnWidth > 0 && measured.width > 0) {
      if (Math.abs(measured.width - columnWidth) <= 1) {
        return measured.height;
      }
      return Math.max(1, Math.ceil((measured.height * columnWidth) / measured.width));
    }
    return measured.height;
  }

  if (columnWidth > 0) {
    return Math.max(1, Math.ceil(columnWidth * DEFAULT_COVER_ASPECT));
  }
  return masonrySizeCache.get(item.id) ?? fallback;
}

function MasonryColumn({
  items,
  gap,
  estimateSize,
  columnWidth,
  scrollMargin,
  renderItem,
}: {
  items: Item[];
  gap: number;
  estimateSize: number;
  columnWidth: number;
  scrollMargin: number;
  renderItem: (item: Item) => ReactNode;
}) {
  const overscan = useVirtualOverscan(estimateSize, gap);
  const getItemKey = useCallback((index: number) => {
    return items[index]?.id ?? index;
  }, [items]);
  const estimateItemSize = useCallback(
    (index: number) =>
      estimateMasonryItemSize(items[index], estimateSize, columnWidth),
    [columnWidth, estimateSize, items],
  );
  const measureMasonryElement = useCallback(
    (
      element: HTMLElement,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<Window, HTMLElement>,
    ) => {
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      const cached = instance.itemSizeCache.get(key);
      const item = items[index];
      const knownSize = estimateMasonryItemSize(item, estimateSize, columnWidth);

      // When a loaded cover's URL is cache-busted (queued -> caching -> completed),
      // LazyCover briefly renders its fallback while the new src decodes.  Do not
      // let that transient fallback overwrite the real, already-known tile height.
      if (
        item &&
        !element.querySelector(".cover-img--ready") &&
        (coverAspectCache.has(item.id) || masonryBoxCache.has(item.id))
      ) {
        return knownSize;
      }

      const { width, height } = readMasonryBox(element, entry);
      if (height <= 0) {
        return cached ?? knownSize;
      }
      if (item) {
        masonrySizeCache.set(item.id, height);
        masonryBoxCache.set(item.id, { width, height });
      }
      return height;
    },
    [columnWidth, estimateSize, items],
  );
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: estimateItemSize,
    overscan,
    scrollMargin,
    gap,
    getItemKey,
    measureElement: measureMasonryElement,
  });

  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance,
    ) => item.start < (instance.scrollOffset ?? 0);
    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    const unsubs = items.map((item, index) =>
      registerScrollTarget(item.id, () => {
        virtualizer.scrollToIndex(index, {
          align: "center",
          behavior: "auto",
        });
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [items, virtualizer]);

  if (items.length === 0) return <div className="masonry-col" />;

  return (
    <div
      className="masonry-col"
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualItems.map((vItem) => {
        const item = items[vItem.index];
        if (!item) return null;
        return (
            <div
              key={vItem.key}
              className="masonry-item"
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vItem.start - scrollMargin}px)`,
              }}
            >
              {renderItem(item)}
            </div>
        );
      })}
    </div>
  );
}

function VirtualMasonry({
  items,
  minColumnWidth,
  gap,
  estimateSize,
  renderItem,
  className,
}: {
  items: Item[];
  minColumnWidth: number;
  gap: number;
  estimateSize: number;
  renderItem: (item: Item) => ReactNode;
  className?: string;
}) {
  const { ref, columns, columnWidth } = useColumnCount(minColumnWidth, gap);
  const assignmentRef = useRef<Map<string, number>>(new Map());
  const packedColumnsRef = useRef(columns);

  const buckets = useMemo(() => {
    const previous =
      packedColumnsRef.current === columns ? assignmentRef.current : null;
    packedColumnsRef.current = columns;
    const { buckets: nextBuckets, assignment } = packIntoColumns(
      items,
      columns,
      (item) => estimateMasonryItemSize(item, estimateSize, columnWidth),
      gap,
      previous,
    );
    assignmentRef.current = assignment;
    return nextBuckets;
  }, [columnWidth, columns, estimateSize, gap, items]);

  const scrollMargin = useScrollMargin(ref, items.length, columns, gap);

  const style = { "--masonry-gap": `${gap}px` } as CSSProperties;

  return (
    <div ref={ref} className={className} style={style}>
      <div className="masonry-columns">
        {buckets.map((colItems, colIndex) => (
          <MasonryColumn
            key={colIndex}
            items={colItems}
            gap={gap}
            estimateSize={estimateSize}
            columnWidth={columnWidth}
            scrollMargin={scrollMargin}
            renderItem={renderItem}
          />
        ))}
      </div>
    </div>
  );
}

const COVER_RETRY_MS = 2000;
const COVER_PRIORITY_RETRY_MS = 700;
const COVER_MAX_RETRIES = 6;
const COVER_PRIORITY_MAX_RETRIES = 8;
const COVER_MAX_RETRY_DELAY_MS = 15000;

/** Remember covers that already decoded so virtual remounts do not reload. */
const coverLoadCache = new Set<string>();

type CoverPriority = "high" | "normal";
type CoverState = "idle" | "loading" | "retrying" | "loaded" | "exhausted";

/** Netflix-style buffering ring for cover loading. */
function NetflixSpinner() {
  return <div className="netflix-spinner" role="status" aria-label="加载中" />;
}

function isElementNearViewport(el: HTMLElement, rootMargin: string) {
  const margin = Number.parseFloat(rootMargin) || 0;
  const rect = el.getBoundingClientRect();
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  return (
    rect.bottom >= -margin &&
    rect.top <= height + margin &&
    rect.right >= 0 &&
    rect.left <= width
  );
}

/** Load cover when near viewport; retry while visible if thumb is not ready yet. */
function LazyCover({
  src,
  placeholderSrc,
  alt,
  className,
  fallbackClass = "poster-fallback",
  fallbackText = "No Cover",
  coverId,
  aspectRatio,
  coverPriority = "normal",
  previewSourceId,
  previewHidden,
  loadingPaused,
  onLoadingChange,
  onReady,
  onVisibilityChange,
}: {
  src?: string;
  placeholderSrc?: string;
  alt: string;
  className?: string;
  fallbackClass?: string;
  fallbackText?: string;
  coverId?: string;
  aspectRatio?: number;
  coverPriority?: CoverPriority;
  previewSourceId?: string;
  previewHidden?: boolean;
  loadingPaused?: boolean;
  onLoadingChange?: (id: string, loading: boolean) => void;
  onReady?: (id: string) => void;
  onVisibilityChange?: (id: string, visible: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lazyRootMargin = useLazyRootMargin();
  const visibilityMargin =
    coverPriority === "high"
      ? `${Math.round((Number.parseFloat(lazyRootMargin) || 0) / VIRTUAL_BUFFER_SCREENS)}px 0px`
      : lazyRootMargin;
  const cachedCover = Boolean(src && coverLoadCache.has(src));
  const [inView, setInView] = useState(false);
  const [coverState, setCoverState] = useState<CoverState>(
    cachedCover ? "loaded" : "idle",
  );
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryWaiting, setRetryWaiting] = useState(false);
  const [requestInFlight, setRequestInFlight] = useState(false);
  const retryTimerRef = useRef<number | null>(null);
  const inViewRef = useRef(false);

  const loadSrc = useMemo(() => {
    if (!src) return "";
    const u = new URL(src);
    if (coverPriority === "high") u.searchParams.set("priority", "1");
    if (retryAttempt > 0) u.searchParams.set("retry", String(retryAttempt));
    return u.toString();
  }, [src, retryAttempt, coverPriority]);

  function clearRetryTimer() {
    if (retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }

  function requestRetry() {
    clearRetryTimer();
    setRequestInFlight(false);
    if (!src || previewHidden || loadingPaused || !inViewRef.current) {
      setCoverState("idle");
      setRetryWaiting(false);
      return;
    }
    const maxRetries =
      coverPriority === "high"
        ? COVER_PRIORITY_MAX_RETRIES
        : COVER_MAX_RETRIES;
    if (retryAttempt >= maxRetries) {
      setCoverState("exhausted");
      setRetryWaiting(false);
      return;
    }
    setCoverState("retrying");
    setRetryWaiting(true);
    const baseDelay =
      coverPriority === "high"
        ? COVER_PRIORITY_RETRY_MS
        : COVER_RETRY_MS;
    const retryDelay = Math.min(
      COVER_MAX_RETRY_DELAY_MS,
      baseDelay * 2 ** Math.max(0, retryAttempt),
    );
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryWaiting(false);
      setRetryAttempt((n) => n + 1);
    }, retryDelay);
  }

  useEffect(() => {
    inViewRef.current = inView;
  }, [inView]);

  useEffect(() => {
    if (!src) {
      setCoverState("idle");
      setRetryAttempt(0);
      setRetryWaiting(false);
      setRequestInFlight(false);
      clearRetryTimer();
      return;
    }
    if (coverLoadCache.has(src)) {
      setCoverState("loaded");
      setRetryWaiting(false);
      setRequestInFlight(false);
      return;
    }
    setInView(false);
    setCoverState("idle");
    setRetryAttempt(0);
    setRetryWaiting(false);
    setRequestInFlight(false);
    clearRetryTimer();
  }, [src]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;

    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: visibilityMargin },
    );
    io.observe(el);
    let raf = 0;
    const checkVisibility = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        setInView(isElementNearViewport(el, visibilityMargin));
      });
    };
    checkVisibility();
    window.addEventListener("scroll", checkVisibility, { passive: true });
    window.addEventListener("resize", checkVisibility);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", checkVisibility);
      window.removeEventListener("resize", checkVisibility);
      io.disconnect();
    };
  }, [src, visibilityMargin]);

  useEffect(() => {
    if (!coverId || !onVisibilityChange) return;
    onVisibilityChange(coverId, inView);
  }, [coverId, inView, onVisibilityChange]);

  useEffect(() => {
    if (!coverId || !onVisibilityChange) return;
    return () => onVisibilityChange(coverId, false);
  }, [coverId, onVisibilityChange]);

  useEffect(() => {
    if (!inView) {
      clearRetryTimer();
      setRetryWaiting(false);
      setRequestInFlight(false);
      if (coverState !== "loaded") {
        setRetryAttempt(0);
        setCoverState("idle");
      }
      return;
    }
    if (previewHidden || loadingPaused) {
      clearRetryTimer();
      setRetryWaiting(false);
      setRequestInFlight(false);
      if (coverState !== "loaded" && coverState !== "exhausted") {
        setCoverState("idle");
      }
      return;
    }
    if (
      !src ||
      coverState === "loaded" ||
      coverState === "exhausted" ||
      retryTimerRef.current != null
    ) {
      return;
    }
    const nextState = retryAttempt > 0 ? "retrying" : "loading";
    if (coverState !== nextState) setCoverState(nextState);
  }, [src, coverState, retryAttempt, previewHidden, loadingPaused, inView]);

  useEffect(() => {
    return () => {
      clearRetryTimer();
    };
  }, []);

  function handleLoad(img: HTMLImageElement) {
    clearRetryTimer();
    setRequestInFlight(false);
    setRetryWaiting(false);
    cacheCoverAspect(coverId, img);
    if (src) coverLoadCache.add(src);
    if (coverId) onReady?.(coverId);
    setCoverState("loaded");
  }

  function handleError() {
    requestRetry();
  }

  const hasSrc = Boolean(loadSrc);
  const cachedReady = Boolean(src && coverLoadCache.has(src));
  const loaded = coverState === "loaded" || cachedReady;
  const shouldLoad =
    hasSrc &&
    !loaded &&
    coverState !== "exhausted" &&
    !previewHidden &&
    !loadingPaused &&
    inView;
  const showImg = hasSrc && (loaded || shouldLoad);
  const isLoading = shouldLoad;
  const showLoadingFallback = isLoading;
  const showPlaceholder = Boolean(placeholderSrc && !loaded && !previewHidden);
  const showFallback = hasSrc && !loaded && !previewHidden && !showPlaceholder;

  useEffect(() => {
    if (!shouldLoad || !loadSrc || retryWaiting) {
      if (!shouldLoad || !loadSrc) setRequestInFlight(false);
      return;
    }

    setRequestInFlight(true);
  }, [loadSrc, retryWaiting, shouldLoad]);

  const knownAspect =
    (coverId ? coverAspectCache.get(coverId) : undefined) ??
    aspectRatio ??
    DEFAULT_COVER_ASPECT;
  const lockedAspectStyle = {
    aspectRatio: `1 / ${knownAspect}`,
  } as CSSProperties;

  useEffect(() => {
    if (!src || !coverLoadCache.has(src)) return;
    setCoverState("loaded");
  }, [previewHidden, src]);

  useEffect(() => {
    if (!coverId || !onLoadingChange) return;
    onLoadingChange(coverId, requestInFlight);
    return () => onLoadingChange(coverId, false);
  }, [coverId, requestInFlight, onLoadingChange]);

  return (
    <div
      ref={ref}
      className={[
        "cover-shell",
        previewHidden ? "cover-shell--preview-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-preview-source={previewSourceId}
      style={lockedAspectStyle}
    >
      {showPlaceholder && (
        <img
          className="cover-placeholder"
          src={placeholderSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      {showImg && (
        <img
          className={[
            "cover-img",
            loaded
              ? "cover-img--ready"
              : "cover-img--pending",
            className,
          ]
            .filter(Boolean)
            .join(" ")}
          src={loadSrc}
          alt={alt}
          decoding="async"
          fetchPriority={coverPriority === "high" ? "high" : "low"}
          onLoad={(e) => handleLoad(e.currentTarget)}
          onError={handleError}
        />
      )}
      {showFallback && (
        <div className={fallbackClass} style={lockedAspectStyle}>
          {showLoadingFallback ? (
            <span className="cover-loading-label">
              <NetflixSpinner />
            </span>
          ) : (
            fallbackText
          )}
        </div>
      )}
    </div>
  );
}

function messageSummary(item: Item): string {
  const text = item.text?.trim();
  if (text) return text;
  if (item.media_unavailable) return "媒体暂不可预览";
  if (item.message_kind === "service") return "服务消息";
  return displayName(item);
}

function messageSource(item: Item): string {
  const parts: string[] = [];
  if (item.author) parts.push(item.author);
  if (item.forwarded_from) parts.push(`转发自 ${item.forwarded_from}`);
  if (item.saved_from && item.saved_from !== item.forwarded_from) {
    parts.push(`来自 ${item.saved_from}`);
  }
  return parts.join(" · ");
}

function VirtualMessageList({
  items,
  renderItem,
  contained = false,
}: {
  items: Item[];
  renderItem: (item: Item) => ReactNode;
  contained?: boolean;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const containedRef = useRef<HTMLDivElement>(null);
  const scrollMargin = useScrollMargin(windowRef, items.length);
  const overscan = useVirtualOverscan(104, 0);
  const windowVirtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => 104,
    overscan,
    scrollMargin,
    getItemKey: (index) => items[index]?.id ?? index,
  });
  const containedVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 104,
    overscan,
    getScrollElement: () => containedRef.current,
    getItemKey: (index) => items[index]?.id ?? index,
  });
  const virtualizer = contained ? containedVirtualizer : windowVirtualizer;
  const ref = contained ? containedRef : windowRef;
  const offset = contained ? 0 : scrollMargin;

  return (
    <div
      ref={ref}
      className={["message-list", contained ? "message-list--contained" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className="message-list-inner"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          return (
            <div
              key={virtualItem.key}
              className="message-list-item"
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start - offset}px)`,
              }}
            >
              {renderItem(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessagePanel({
  items,
  onOpen,
}: {
  items: Item[];
  onOpen: (item: Item, target: HTMLElement) => void;
}) {
  return (
    <aside className="message-panel" aria-label="文本消息">
      <div className="message-panel-header">
        <strong>Messages</strong>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? (
        <div className="empty message-panel-empty">暂无文本消息。</div>
      ) : (
        <VirtualMessageList
          contained
          items={items}
          renderItem={(item) => {
            const source = messageSource(item);
            const date = formatMessageDate(item.date);
            return (
              <button
                type="button"
                className={[
                  "message-row",
                  item.message_kind === "service" ? "message-row--service" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(event) => onOpen(item, event.currentTarget)}
              >
                <div className="message-row-copy">
                  <div className="message-row-meta">
                    {[source, date, `#${item.message_id}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="message-row-text">{messageSummary(item)}</div>
                  {item.media_unavailable && (
                    <div className="message-row-unavailable">
                      {item.media_unavailable}
                    </div>
                  )}
                </div>
              </button>
            );
          }}
        />
      )}
    </aside>
  );
}

function MessagePreview({
  item,
  onClose,
  onCache,
  onPause,
}: {
  item: Item;
  onClose: () => void;
  onCache: (item: Item) => void;
  onPause: (item: Item) => void;
}) {
  useEffect(() => {
    const root = document.documentElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    root.classList.add("body-scroll-locked");
    window.addEventListener("keydown", onKeyDown);
    return () => {
      root.classList.remove("body-scroll-locked");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const source = messageSource(item);
  const date = formatMessageDate(item.date);

  return (
    <div className="message-preview-root">
      <button
        type="button"
        className="message-preview-backdrop"
        aria-label="关闭消息预览"
        onClick={onClose}
      />
      <button
        type="button"
        className="message-preview-close"
        aria-label="关闭"
        onClick={onClose}
      >
        <X size={42} strokeWidth={1.6} aria-hidden="true" />
      </button>
      <article className="message-preview-content">
        <div className="message-preview-meta">
          {[source, date, `#${item.message_id}`].filter(Boolean).join(" · ")}
        </div>
        <div className="message-preview-text">{messageSummary(item)}</div>
        {item.media_unavailable && (
          <div className="message-preview-note">{item.media_unavailable}</div>
        )}
        {item.type === "file" && (
          <div className="message-preview-file">
            <strong>{displayName(item)}</strong>
            <span>{formatSize(item.size)}</span>
            {item.status === "caching" ? (
              <button
                type="button"
                className="btn ghost"
                onClick={() => onPause(item)}
              >
                暂停
              </button>
            ) : item.status === "completed" ? (
              <span>已落盘</span>
            ) : (
              <button
                type="button"
                className="btn ghost"
                onClick={() => onCache(item)}
              >
                {item.status === "paused" ? "继续下载" : "下载到目录"}
              </button>
            )}
          </div>
        )}
      </article>
    </div>
  );
}

function DownloadDock({ items }: { items: Item[] }) {
  const active = useMemo(() => {
    const caching = items.filter((i) => i.status === "caching");
    const queued = items
      .filter((i) => (i.queue_pos ?? 0) > 0 && i.status !== "caching")
      .sort((a, b) => (a.queue_pos ?? 0) - (b.queue_pos ?? 0));
    return [...caching, ...queued];
  }, [items]);

  if (active.length === 0) return null;

  const shown = active.slice(0, 12);
  const extra = active.length - shown.length;

  return (
    <div className="download-dock" aria-live="polite">
      <div className="download-dock-label">下载队列</div>
      <div className="download-dock-list">
        {shown.map((item) => (
          <div key={item.id} className="download-dock-item" title={displayName(item)}>
            <span className="download-dock-name">{displayName(item)}</span>
            <span className="download-dock-meta">
              {item.status === "caching"
                ? `${progressPct(item)}%`
                : `#${item.queue_pos}`}
            </span>
            {item.status === "caching" && (
              <span
                className="download-dock-bar"
                style={{ width: `${progressPct(item)}%` }}
              />
            )}
          </div>
        ))}
        {extra > 0 && (
          <div className="download-dock-more">+{extra} 项排队</div>
        )}
      </div>
    </div>
  );
}

function chatTypeLabel(type: ChatInfo["type"]): string {
  switch (type) {
    case "saved":
      return "收藏";
    case "private":
      return "私聊";
    case "group":
      return "群组";
    case "channel":
      return "频道";
  }
}

const CHAT_AVATAR_GRADIENTS = [
  ["#e17076", "#f18c93"],
  ["#e7a76a", "#f4c07b"],
  ["#e3be75", "#f0d18b"],
  ["#80bfa3", "#9cd1b7"],
  ["#6fb6d8", "#91c9e1"],
  ["#a695e7", "#baaff0"],
  ["#d39bd1", "#e1b3df"],
] as const;

function chatAvatarSeed(id: string | undefined, title: string): number {
  let hash = 0;
  for (const char of `${id ?? ""}:${title}`) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

function chatAvatarGradient(id: string | undefined, title: string): string {
  const [top, bottom] =
    CHAT_AVATAR_GRADIENTS[chatAvatarSeed(id, title) % CHAT_AVATAR_GRADIENTS.length];
  return `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)`;
}

function chatAvatarInitials(title: string): string {
  const words = title.trim().split(/[\s-]+/).filter(Boolean);
  const first = Array.from(words[0] ?? "")[0] ?? "?";
  const second = Array.from(words[1] ?? "")[0] ?? "";
  return `${first}${second}`.toUpperCase();
}

function ChatAvatar({
  id,
  title,
  src,
  type,
  local = false,
}: {
  id?: string;
  title: string;
  src?: string;
  type?: ChatInfo["type"];
  local?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const icon = local ? (
    <FileText size={18} strokeWidth={1.8} />
  ) : type === "saved" ? (
    <Bookmark size={18} strokeWidth={1.8} />
  ) : null;

  return (
    <span
      className={icon ? "chat-avatar chat-avatar--icon" : "chat-avatar"}
      style={{ background: chatAvatarGradient(id, title) }}
      aria-hidden="true"
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : icon ? (
        icon
      ) : (
        <span>{chatAvatarInitials(title)}</span>
      )}
    </span>
  );
}

function ChatSelect({
  value,
  chats,
  disabled,
  onChange,
}: {
  value: string;
  chats: ChatInfo[];
  disabled: boolean;
  onChange: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = chats.find((chat) => chat.id === value);
  const title = selected?.title ?? (value ? "聊天" : "本地 JSON");
  const meta = selected ? chatTypeLabel(selected.type) : "本地文件";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const selectedOption = menuRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    selectedOption?.scrollIntoView({ block: "nearest" });
  }, [open, value, chats.length]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (id: string) => {
    setOpen(false);
    if (id !== value) void onChange(id);
  };

  return (
    <div className="chat-select" ref={rootRef}>
      <button
        type="button"
        className="chat-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChatAvatar
          id={selected?.id ?? "local-json"}
          title={title}
          src={selected?.avatar_url ? mediaURL(selected.avatar_url) : undefined}
          type={selected?.type}
          local={!selected}
        />
        <span className="chat-select-copy">
          <strong>{title}</strong>
          <span>{meta}</span>
        </span>
        <ChevronDown
          className={open ? "chat-select-chevron is-open" : "chat-select-chevron"}
          size={18}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          className="chat-select-menu"
          ref={menuRef}
          role="listbox"
          aria-label="消息来源"
        >
          <button
            type="button"
            className={!value ? "chat-select-option is-selected" : "chat-select-option"}
            role="option"
            aria-selected={!value}
            onClick={() => choose("")}
          >
            <ChatAvatar id="local-json" title="本地 JSON" local />
            <span className="chat-select-copy">
              <strong>本地 JSON</strong>
              <span>本地文件</span>
            </span>
          </button>
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={
                chat.id === value
                  ? "chat-select-option is-selected"
                  : "chat-select-option"
              }
              role="option"
              aria-selected={chat.id === value}
              onClick={() => choose(chat.id)}
            >
              <ChatAvatar
                id={chat.id}
                title={chat.title}
                src={chat.avatar_url ? mediaURL(chat.avatar_url) : undefined}
                type={chat.type}
              />
              <span className="chat-select-copy">
                <strong>{chat.title}</strong>
                <span>{chatTypeLabel(chat.type)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <MediaApp />
    </AuthGate>
  );
}

function MediaApp() {
  const [items, setItems] = useState<Item[]>([]);
  const [apiReady, setApiReady] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importTotal, setImportTotal] = useState(0);
  const [importDone, setImportDone] = useState(0);
  const [importItems, setImportItems] = useState(0);
  const [importPhase, setImportPhase] = useState("");
  const [importSource, setImportSource] = useState("");
  const [importDetail, setImportDetail] = useState("");
  const [downloadingCount, setDownloadingCount] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const [coverBuildingCount, setCoverBuildingCount] = useState(0);
  const [coverQueuedCount, setCoverQueuedCount] = useState(0);
  const [coverLoadingCount, setCoverLoadingCount] = useState(0);
  const coverLoadingRef = useRef(new Set<string>());
  const visibleCoverIdsRef = useRef(new Set<string>());
  const coverStateFrameRef = useRef<number | null>(null);
  const coverPlaybackPausedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [activeChat, setActiveChat] = useState("");
  const [chatHasMore, setChatHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  /** Auto-fill only while the page is too short to scroll; capped to avoid runaway paging. */
  const autoFillWithoutScrollRef = useRef(0);
  const [rangeType, setRangeType] = useState<RangeType>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [player, setPlayer] = useState<PlayerState>(null);
  const [messagePreview, setMessagePreview] = useState<Item | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<DOMRectReadOnly | null>(
    null,
  );
  const [previewOriginRotation, setPreviewOriginRotation] = useState(0);
  const [previewTransitionMode, setPreviewTransitionMode] =
    useState<PreviewTransitionMode>("zoom");
  const [previewClosing, setPreviewClosing] = useState(false);
  const [cardOverlayHiddenId, setCardOverlayHiddenId] = useState<string | null>(
    null,
  );
  const [playError, setPlayError] = useState("");
  const pendingOpenTimerRef = useRef<number | null>(null);
  const pendingOpenTokenRef = useRef(0);
  const selectChatTokenRef = useRef(0);

  const onCoverLoadingChange = useCallback((id: string, loading: boolean) => {
    const set = coverLoadingRef.current;
    if (loading) set.add(id);
    else set.delete(id);
    setCoverLoadingCount(set.size);
  }, []);
  const applyPayload = useCallback((payload: ItemsPayload) => {
    const nextItems = payload.items ?? [];
    const nextIDs = new Set(nextItems.map((item) => item.id));
    for (const id of visibleCoverIdsRef.current) {
      if (!nextIDs.has(id)) visibleCoverIdsRef.current.delete(id);
    }
    setItems(nextItems);
    setImporting(payload.importing);
    setImportError(payload.import_error ?? "");
    setImportTotal(payload.import_total ?? 0);
    setImportDone(payload.import_done ?? 0);
    setImportItems(payload.import_items ?? payload.items?.length ?? 0);
    setImportPhase(payload.import_phase ?? "");
    setImportSource(payload.import_source ?? "");
    setImportDetail(payload.import_detail ?? "");
    setDownloadingCount(payload.downloading_count ?? 0);
    setQueuedCount(payload.queued_count ?? 0);
    setCoverBuildingCount(payload.cover_building_count ?? 0);
    setCoverQueuedCount(payload.cover_queued_count ?? 0);
    setActiveChat(payload.active_chat ?? "");
    setChatHasMore(payload.chat_has_more ?? false);
    setApiReady(true);
  }, []);

  const applyProgress = (payload: ProgressPayload) => {
    const updates = new Map(payload.items.map((update) => [update.id, update.progress]));
    setItems((current) => {
      let changed = false;
      const next = current.map((item) => {
        const progress = updates.get(item.id);
        if (progress == null || progress === item.progress) return item;
        changed = true;
        return { ...item, progress };
      });
      return changed ? next : current;
    });
  };

  useEffect(() => {
    let alive = true;
    fetchItems()
      .then((payload) => {
        if (!alive) return;
        applyPayload(payload);
      })
      .catch((err: Error) => {
        if (alive) {
          setApiReady(true);
          setError(err.message || "无法连接 API，请先启动 tdl web");
        }
      });
    fetchChats()
      .then((next) => {
        if (alive) setChats(next);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setChatsLoading(false);
      });

    const stop = subscribeEvents(
      (payload) => {
        applyPayload(payload);
        setError("");
      },
      applyProgress,
    );
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const mediaItems = useMemo(
    () => items.filter((i) => i.type !== "message"),
    [items],
  );
  const messageItems = useMemo(
    () => items.filter((i) => i.type === "message"),
    [items],
  );
  const previewMediaItems = useMemo(
    () => mediaItems.filter((i) => i.type === "video" || i.type === "image"),
    [mediaItems],
  );
  const mediaItemCount = mediaItems.length;
  const done = items.filter(
    (i) => i.type !== "message" && i.status === "completed",
  ).length;

  useEffect(() => {
    return () => {
      if (pendingOpenTimerRef.current != null) {
        window.clearTimeout(pendingOpenTimerRef.current);
      }
    };
  }, []);

  const livePlayer = useMemo(() => {
    if (!player) return null;
    const fresh = items.find((i) => i.id === player.item.id);
    return fresh ? { ...player, item: fresh } : player;
  }, [player, items]);
  const liveMessagePreview = useMemo(() => {
    if (!messagePreview) return null;
    return items.find((item) => item.id === messagePreview.id) ?? messagePreview;
  }, [items, messagePreview]);
  const coverPlaybackPaused = Boolean(
    busy || cardOverlayHiddenId || livePlayer?.kind === "video",
  );
  coverPlaybackPausedRef.current = coverPlaybackPaused;
  const chromeCollapsed = Boolean(
    livePlayer || liveMessagePreview || cardOverlayHiddenId,
  );

  const flushCoverState = useCallback((keepalive = false) => {
    void updateCoverState(
      coverPlaybackPausedRef.current,
      Array.from(visibleCoverIdsRef.current),
      keepalive,
    ).catch(() => {});
  }, []);

  const scheduleCoverState = useCallback(() => {
    if (coverStateFrameRef.current != null) return;
    coverStateFrameRef.current = window.requestAnimationFrame(() => {
      coverStateFrameRef.current = null;
      flushCoverState();
    });
  }, [flushCoverState]);

  const onCoverVisibilityChange = useCallback(
    (id: string, visible: boolean) => {
      const set = visibleCoverIdsRef.current;
      if (visible) set.add(id);
      else set.delete(id);
      scheduleCoverState();
    },
    [scheduleCoverState],
  );

  useEffect(() => {
    scheduleCoverState();
  }, [coverPlaybackPaused, scheduleCoverState]);

  useEffect(() => {
    const resume = () => {
      void updateCoverState(false, [], true).catch(() => {});
    };
    const restore = () => scheduleCoverState();
    window.addEventListener("pagehide", resume);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", resume);
      window.removeEventListener("pageshow", restore);
      if (coverStateFrameRef.current != null) {
        window.cancelAnimationFrame(coverStateFrameRef.current);
        coverStateFrameRef.current = null;
      }
      resume();
    };
  }, [scheduleCoverState]);

  // Prefer item.error from SSE as the single play-failure message.
  useEffect(() => {
    if (!livePlayer) return;
    const err = livePlayer.item.error?.trim();
    if (livePlayer.item.status === "error" && err) {
      setPlayError(`无法播放：${err}`);
      return;
    }
    if (livePlayer.item.status !== "error") {
      setPlayError("");
    }
  }, [livePlayer?.item.id, livePlayer?.item.status, livePlayer?.item.error]);

  async function onImport() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await importJSON(file, rangeType, from, to);
      setImporting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onSelectChat(id: string) {
    const token = selectChatTokenRef.current + 1;
    selectChatTokenRef.current = token;
    visibleCoverIdsRef.current.clear();
    void updateCoverState(true, [], true).catch(() => {});
    setBusy(true);
    setError("");
    void selectChat(id)
      .then((payload) => {
        if (token === selectChatTokenRef.current) applyPayload(payload);
      })
      .catch((err) => {
        if (token === selectChatTokenRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (token === selectChatTokenRef.current) setBusy(false);
      });
  }

  const onLoadMore = useCallback(async () => {
    if (!activeChat || !chatHasMore || importing || loadingMoreRef.current) {
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const payload = await loadMoreChat();
      applyPayload(payload);
    } catch (err) {
      setChatHasMore(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [activeChat, applyPayload, chatHasMore, importing]);

  useEffect(() => {
    autoFillWithoutScrollRef.current = 0;
  }, [activeChat]);

  useEffect(() => {
    if (!activeChat || !chatHasMore || loadingMore || importing) return;

    const AUTO_FILL_WHILE_SHORT_MAX = 8;

    const pageMetrics = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const viewport = window.innerHeight;
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      );
      return {
        nearBottom: height - (scrollTop + viewport) <= viewport * 2,
        scrollable: height > viewport + 48,
      };
    };

    const requestMore = (reason: "auto" | "user") => {
      const { nearBottom, scrollable } = pageMetrics();
      if (!nearBottom) return;

      if (reason === "user") {
        autoFillWithoutScrollRef.current = 0;
        void onLoadMore();
        return;
      }

      // Effect/auto re-check after each page: do not chain while the page can
      // already scroll — wait for a real scroll near the bottom instead.
      if (scrollable) return;
      if (autoFillWithoutScrollRef.current >= AUTO_FILL_WHILE_SHORT_MAX) return;
      autoFillWithoutScrollRef.current += 1;
      void onLoadMore();
    };

    requestMore("auto");
    const onScroll = () => requestMore("user");
    const onResize = () => requestMore("user");
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [
    activeChat,
    chatHasMore,
    importing,
    items.length,
    loadingMore,
    onLoadMore,
  ]);

  async function onCache(item: Item) {
    try {
      await cacheItem(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onPause(item: Item) {
    try {
      await pauseItem(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDownloadAll() {
    try {
      await downloadItems([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onPauseAll() {
    try {
      await pauseAllItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const closeMessagePreview = useCallback(() => {
    setMessagePreview(null);
  }, []);

  function openMessageItem(item: Item, target: HTMLElement) {
    setMessagePreview(null);
    if (item.type === "video") {
      openVideoPlayer(item, target);
      return;
    }
    if (item.type === "image") {
      openPlayer("image", item, target);
      return;
    }
    clearPendingOpen();
    setMessagePreview(item);
  }

  function getPreviewSourceEl(target: HTMLElement): HTMLElement {
    return (
      (target.closest("[data-preview-source]") as HTMLElement | null) ??
      (target.querySelector("[data-preview-source]") as HTMLElement | null) ??
      target
    );
  }

  function getPreviewRotation(target: HTMLElement): number {
    const el = target.closest("[data-preview-rotation]") as HTMLElement | null;
    const rotation = Number(el?.dataset.previewRotation ?? 0);
    return Number.isFinite(rotation) ? rotation : 0;
  }

  function clearPendingOpen() {
    if (pendingOpenTimerRef.current != null) {
      window.clearTimeout(pendingOpenTimerRef.current);
      pendingOpenTimerRef.current = null;
    }
    pendingOpenTokenRef.current += 1;
  }

  function openPlayer(
    kind: "video" | "image",
    item: Item,
    target: HTMLElement,
    transitionMode: PreviewTransitionMode = "zoom",
  ) {
    clearPendingOpen();
    setPlayError("");
    setPreviewClosing(false);
    setCardOverlayHiddenId(kind === "video" ? item.id : null);
    setPreviewTransitionMode(transitionMode);
    setPreviewOrigin(getPreviewSourceEl(target).getBoundingClientRect());
    setPreviewOriginRotation(getPreviewRotation(target));
    setPlayer({ kind, item });
  }

  function openVideoPlayer(item: Item, target: HTMLElement) {
    clearPendingOpen();
    const token = pendingOpenTokenRef.current;
    const originRect = getPreviewSourceEl(target).getBoundingClientRect();
    const originRotation = getPreviewRotation(target);
    setPlayError("");
    setPreviewClosing(false);
    setCardOverlayHiddenId(item.id);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : CARD_OVERLAY_SLIDE_MS;
    pendingOpenTimerRef.current = window.setTimeout(() => {
      if (token !== pendingOpenTokenRef.current) return;
      pendingOpenTimerRef.current = null;
      setPreviewTransitionMode("zoom");
      setPreviewOrigin(originRect);
      setPreviewOriginRotation(originRotation);
      setPlayer({ kind: "video", item });
    }, delay);
  }

  function navigatePlayer(item: Item) {
    setPlayError("");
    setPreviewClosing(false);
    setCardOverlayHiddenId(item.type === "video" ? item.id : null);
    setPlayer({ kind: item.type === "image" ? "image" : "video", item });
  }

  function requestClosePlayer() {
    setPreviewClosing(true);
  }

  function finalizeClosePlayer() {
    setPlayer(null);
    setPreviewOrigin(null);
    setPreviewOriginRotation(0);
    setPreviewTransitionMode("zoom");
    setPreviewClosing(false);
    setPlayError("");
    window.requestAnimationFrame(() => setCardOverlayHiddenId(null));
  }

  function renderMediaItem(item: Item) {
    const isVideo = item.type === "video";
    const hasCover = isVideo || item.type === "image";
    const source = messageSource(item);
    const cardMeta = [
      formatMessageDate(item.date),
      isVideo ? formatDuration(item.duration) : "",
      formatSize(item.size),
      source,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div
        className="card-wrap"
        id={`scroll-item-${item.id}`}
        data-scroll-item={item.id}
      >
        <button
          type="button"
          className={["card", item.type === "file" ? "card--file" : ""]
            .filter(Boolean)
            .join(" ")}
          title={displayName(item)}
          onClick={(event) => openMessageItem(item, event.currentTarget)}
        >
          <StatusBadge item={item} maxQueuePos={VIDEO_QUEUE_DISPLAY_LIMIT} />
          <div className="card-cover">
            {hasCover ? (
              <LazyCover
                className="poster"
                fallbackText={isVideo ? "Video" : "Image"}
                src={coverURL(
                  item.cover || item.thumb_url || item.preview_url,
                )}
                placeholderSrc={item.inline_thumb}
                alt={displayName(item)}
                coverId={item.id}
                aspectRatio={item.cover_aspect}
                coverPriority={isVideo ? "high" : "normal"}
                previewSourceId={item.id}
                previewHidden={livePlayer?.item.id === item.id}
                loadingPaused={coverPlaybackPaused}
                onLoadingChange={onCoverLoadingChange}
                onVisibilityChange={onCoverVisibilityChange}
              />
            ) : (
              <div className="card-file-cover">
                <FileText size={48} strokeWidth={1.2} aria-hidden="true" />
                <span>{item.mime || "FILE"}</span>
              </div>
            )}
            <div
              className={[
                "card-overlay",
                cardOverlayHiddenId === item.id
                  ? "card-overlay--hidden"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="card-overlay-inner">
                <div className="card-title">{displayName(item)}</div>
                <div className="card-meta">
                  <div className="card-sub">{cardMeta}</div>
                  {item.status === "queued" && (
                    <div className="card-status">
                      {(item.queue_pos ?? 0) > 0 &&
                      (item.queue_pos ?? 0) <= VIDEO_QUEUE_DISPLAY_LIMIT ? (
                        statusLabel(item)
                      ) : (
                        <CloudDownload
                          className="card-cloud-icon"
                          size={14}
                          strokeWidth={2}
                          aria-label="未缓存"
                        />
                      )}
                    </div>
                  )}
                </div>
                {item.media_unavailable && (
                  <div className="card-note">{item.media_unavailable}</div>
                )}
              </div>
              {(item.status === "caching" ||
                item.status === "paused" ||
                item.progress > 0) &&
                item.status !== "completed" && (
                  <div className="progress">
                    <span style={{ width: `${progressPct(item)}%` }} />
                  </div>
                )}
            </div>
          </div>
        </button>
      </div>
    );
  }

  return (
    <>
      <header
        className={[
          "topbar",
          chromeCollapsed ? "topbar--collapsed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="topbar-inner">
          <div className="brand">
            BOC <span>PREVIEW</span>
          </div>
          <StatusBar
            apiReady={apiReady}
            importing={importing}
            importPhase={importPhase}
            importSource={importSource}
            importDetail={importDetail}
            importDone={importDone}
            importTotal={importTotal}
            importItems={importItems}
            downloadingCount={downloadingCount}
            queuedCount={queuedCount}
            coverBuildingCount={coverBuildingCount}
            coverQueuedCount={coverQueuedCount}
            coverLoadingCount={coverLoadingCount}
            itemCount={items.length}
            completedCount={done}
          />
        </div>
      </header>
      <div
        className={[
          "app",
          chromeCollapsed ? "app--chrome-collapsed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >

      <DownloadDock items={items} />

      <section className="toolbar">
        <div className="field source-field">
          <label>消息来源</label>
          <ChatSelect
            value={activeChat}
            chats={chats}
            disabled={busy || importing || chatsLoading}
            onChange={onSelectChat}
          />
        </div>
        {activeChat ? (
          <div className="live-source">
            <span className="live-dot" />
          </div>
        ) : (
          <>
            <div className="field">
              <label>JSON 导出</label>
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="field">
              <label>范围类型</label>
              <select
                value={rangeType}
                onChange={(e) => setRangeType(e.target.value as RangeType)}
              >
                <option value="">全部</option>
                <option value="id">消息 ID</option>
                <option value="time">时间戳</option>
              </select>
            </div>
            <div className="field">
              <label>From</label>
              <input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="起始"
                disabled={!rangeType}
              />
            </div>
            <div className="field">
              <label>To</label>
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="结束"
                disabled={!rangeType}
              />
            </div>
            <button className="btn" disabled={!file || busy || importing} onClick={onImport}>
              {busy ? "导入中…" : "导入"}
            </button>
          </>
        )}
        <button
          className="btn ghost"
          disabled={!mediaItemCount || importing}
          onClick={onDownloadAll}
        >
          下载全部
        </button>
        <button
          className="btn ghost"
          disabled={importing || (downloadingCount === 0 && queuedCount === 0)}
          onClick={() => void onPauseAll()}
        >
          暂停全部
        </button>
      </section>

      {importError && <div className="banner error">{importError}</div>}
      {error && !(livePlayer && playError) && (
        <div className="banner error">{error}</div>
      )}

      {!apiReady ? (
        <AppSkeleton />
      ) : (
        <>
          <ScrollRail
            collapsed={chromeCollapsed}
            items={mediaItems}
          />
          <div className="content-split">
            <section id="section-media" className="section media-section">
              <h2>Media</h2>
              {mediaItems.length === 0 ? (
                <div className="empty">
                  {importing
                    ? "正在加载媒体列表…"
                    : activeChat
                      ? "最近消息中暂无视频、图片或文件。"
                      : "暂无媒体。导入 JSON 后会显示统一瀑布流。"}
                </div>
              ) : (
                <VirtualMasonry
                  className="media-grid masonry-flow"
                  items={mediaItems}
                  minColumnWidth={280}
                  gap={16}
                  estimateSize={320}
                  renderItem={renderMediaItem}
                />
              )}
            </section>
            <MessagePanel
              items={messageItems}
              onOpen={(item, target) => openMessageItem(item, target)}
            />
          </div>
          {activeChat && (loadingMore || chatHasMore) && (
            <div className="empty masonry-load-more">
              {loadingMore && <NetflixSpinner />}
              {loadingMore ? "正在加载更早消息…" : "继续向下滚动加载更早消息"}
            </div>
          )}
        </>
      )}

    </div>
      {livePlayer && previewOrigin && (
        <MediaPreview
          player={livePlayer}
          originRect={previewOrigin}
          originRotation={previewOriginRotation}
          transitionMode={previewTransitionMode}
          thumbSrc={coverURL(
            livePlayer.item.cover ||
              livePlayer.item.thumb_url ||
              livePlayer.item.preview_url,
          )}
          aspectRatio={
            coverAspectCache.get(livePlayer.item.id) ?? livePlayer.item.cover_aspect
          }
          closing={previewClosing}
          mediaItems={previewMediaItems}
          playError={playError}
          onPlayError={setPlayError}
          onNavigate={navigatePlayer}
          onCloseRequest={requestClosePlayer}
          onClosed={finalizeClosePlayer}
          onPause={onPause}
        />
      )}
      {liveMessagePreview && (
        <MessagePreview
          item={liveMessagePreview}
          onClose={closeMessagePreview}
          onCache={(item) => void onCache(item)}
          onPause={(item) => void onPause(item)}
        />
      )}
    </>
  );
}

function StatusBadge({
  item,
  maxQueuePos,
}: {
  item: Item;
  maxQueuePos?: number;
}) {
  if (item.status === "completed") {
    return null;
  }
  if (item.status === "caching") {
    return <span className="badge busy">下载中 {progressPct(item)}%</span>;
  }
  if (item.status === "error") {
    return <span className="badge busy">错误</span>;
  }
  const queuePos = item.queue_pos ?? 0;
  const showQueue =
    queuePos > 0 &&
    (maxQueuePos === undefined || queuePos <= maxQueuePos);
  if (showQueue) {
    return <span className="badge queue">排队 #{queuePos}</span>;
  }
  if (item.status === "paused") {
    return <span className="badge paused">{progressPct(item)}%</span>;
  }
  if (item.resume_completed) {
    return <span className="badge done">RESUME</span>;
  }
  return null;
}
