"use client";

import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { X, Maximize2, Minimize2 } from "lucide-react";
import { surface, shadow, border, specularStyle } from "@/components/ui/tokens";

interface AppWindowProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose?: () => void;
  className?: string;
  zIndex?: number;
  defaultPosition?: { x: number; y: number };
  minWidth?: number;
  minHeight?: number;
  defaultSize?: { w: number; h: number };
  headerRight?: ReactNode;
  /** Hides the close button + disables Escape-to-close. For process windows
   *  that demand attention until a backend state changes (e.g. hiring). */
  disableClose?: boolean;
}

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | null;

const EDGE_SIZE = 6;

export function AppWindow({
  title,
  subtitle,
  children,
  onClose,
  className = "",
  // Default above the OS chrome dock + top bar (z-50) so an open window is
  // never clipped or overlapped by the dock. Stays below gates (z-100) and
  // modals (z-150+).
  zIndex = 60,
  defaultPosition,
  minWidth = 280,
  minHeight = 200,
  defaultSize,
  headerRight,
  disableClose = false,
}: AppWindowProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const savedStateRef = useRef<{
    pos: { x: number; y: number };
    size: { w: number; h: number };
  } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeRef = useRef<{
    edge: ResizeEdge;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resolvedSize = defaultSize ?? null;
    if (resolvedSize) setSize(resolvedSize);

    const w =
      resolvedSize?.w ?? windowRef.current?.getBoundingClientRect().width ?? 0;
    const h =
      resolvedSize?.h ?? windowRef.current?.getBoundingClientRect().height ?? 0;

    if (defaultPosition) {
      setPos(defaultPosition);
    } else {
      setPos({
        x: (window.innerWidth - w) / 2,
        y: (window.innerHeight - h) / 2,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(() => onClose?.(), 200);
  }, [onClose]);

  const handleMaximize = useCallback(() => {
    if (!maximized) {
      savedStateRef.current = {
        pos: pos ?? { x: 0, y: 0 },
        size: size ?? { w: window.innerWidth * 0.8, h: window.innerHeight * 0.8 },
      };
      setPos({ x: 0, y: 0 });
      setSize({ w: window.innerWidth, h: window.innerHeight });
      setMaximized(true);
    } else {
      if (savedStateRef.current) {
        setPos(savedStateRef.current.pos);
        setSize(savedStateRef.current.size);
      }
      setMaximized(false);
    }
  }, [maximized, pos, size]);

  useEffect(() => {
    if (!onClose || disableClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, onClose, disableClose]);

  const onDragPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: pos?.x ?? 0,
        originY: pos?.y ?? 0,
      };
    },
    [pos],
  );

  const onDragPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPos({
        x: dragRef.current.originX + dx,
        y: dragRef.current.originY + dy,
      });
    },
    [],
  );

  const onDragPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const detectEdge = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): ResizeEdge => {
      const rect = windowRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const atTop = y < EDGE_SIZE;
      const atBottom = y > rect.height - EDGE_SIZE;
      const atLeft = x < EDGE_SIZE;
      const atRight = x > rect.width - EDGE_SIZE;
      if (atTop && atLeft) return "nw";
      if (atTop && atRight) return "ne";
      if (atBottom && atLeft) return "sw";
      if (atBottom && atRight) return "se";
      if (atTop) return "n";
      if (atBottom) return "s";
      if (atLeft) return "w";
      if (atRight) return "e";
      return null;
    },
    [],
  );

  const cursorForEdge = (edge: ResizeEdge): string => {
    switch (edge) {
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "nw":
      case "se":
        return "nwse-resize";
      default:
        return "";
    }
  };

  const onWindowPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const edge = detectEdge(e);
      if (!edge) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = windowRef.current!.getBoundingClientRect();
      resizeRef.current = {
        edge,
        startX: e.clientX,
        startY: e.clientY,
        originX: pos?.x ?? rect.left,
        originY: pos?.y ?? rect.top,
        originW: size?.w ?? rect.width,
        originH: size?.h ?? rect.height,
      };
    },
    [detectEdge, pos, size],
  );

  const onWindowPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (resizeRef.current) {
        const { edge, startX, startY, originX, originY, originW, originH } =
          resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newX = originX;
        let newY = originY;
        let newW = originW;
        let newH = originH;

        if (edge?.includes("e")) newW = Math.max(minWidth, originW + dx);
        if (edge?.includes("w")) {
          newW = Math.max(minWidth, originW - dx);
          newX = originX + (originW - newW);
        }
        if (edge?.includes("s")) newH = Math.max(minHeight, originH + dy);
        if (edge?.includes("n")) {
          newH = Math.max(minHeight, originH - dy);
          newY = originY + (originH - newH);
        }

        setPos({ x: newX, y: newY });
        setSize({ w: newW, h: newH });
        return;
      }
      const edge = detectEdge(e);
      const cursor = cursorForEdge(edge);
      if (windowRef.current) {
        windowRef.current.style.cursor = cursor;
      }
    },
    [detectEdge, minWidth, minHeight],
  );

  const onWindowPointerUp = useCallback(() => {
    resizeRef.current = null;
  }, []);

  const isInteracting = dragRef.current !== null || resizeRef.current !== null;

  return (
    <div
      ref={windowRef}
      className={`fixed rounded-2xl overflow-hidden flex flex-col transition-all ${className}`}
      style={{
        ...surface.base,
        boxShadow: shadow.md,
        // Maximized windows must sit ABOVE the OS chrome (top bar + dock at
        // z-50) so they aren't clipped/overlapped when filling the screen.
        // Stays below modals (z-200).
        zIndex: maximized ? Math.max(zIndex, 60) : zIndex,
        // Square the corners when filling the screen — rounded edges over a
        // full-bleed window leave wallpaper slivers at the corners.
        borderRadius: maximized ? 0 : undefined,
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.97)",
        transitionProperty: isInteracting ? "opacity" : "opacity, transform",
        transitionDuration: isInteracting ? "0ms" : "300ms",
        left: pos ? `${pos.x}px` : "50%",
        top: pos ? `${pos.y}px` : "50%",
        ...(size ? { width: `${size.w}px`, height: `${size.h}px` } : {}),
        ...(pos
          ? {}
          : {
              transform: visible
                ? "translate(-50%, -50%)"
                : "translate(-50%, -50%) scale(0.97)",
            }),
      }}
      onPointerDown={onWindowPointerDown}
      onPointerMove={onWindowPointerMove}
      onPointerUp={onWindowPointerUp}
    >
      {/* Specular top highlight */}
      <div className="absolute inset-x-0 top-0 h-px pointer-events-none" style={specularStyle} />

      <div
        className="flex items-center gap-3 px-4 py-3 cursor-grab active:cursor-grabbing select-none"
        style={{ borderBottom: border.divider }}
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        <div className="flex items-center gap-1.5 group/controls">
          {!disableClose && (
            <button
              onClick={handleClose}
              onPointerDown={(e) => e.stopPropagation()}
              className="size-3.5 rounded-full bg-white/10 hover:bg-white/25 transition-colors flex items-center justify-center"
              aria-label="Close"
            >
              <X className="size-2 text-white/30 group-hover/controls:text-white/80 transition-colors" />
            </button>
          )}
          <button
            onClick={handleMaximize}
            onPointerDown={(e) => e.stopPropagation()}
            className="size-3.5 rounded-full bg-white/10 hover:bg-white/25 transition-colors flex items-center justify-center"
            aria-label={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? (
              <Minimize2 className="size-2 text-white/30 group-hover/controls:text-white/80 transition-colors" />
            ) : (
              <Maximize2 className="size-2 text-white/30 group-hover/controls:text-white/80 transition-colors" />
            )}
          </button>
        </div>

        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium text-white/80 truncate">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>

        {headerRight && (
          <div
            className="shrink-0"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {headerRight}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
