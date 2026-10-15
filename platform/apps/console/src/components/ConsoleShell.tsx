import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { MenuIcon, PanelLeftOpenIcon } from "lucide-react";
import { useLocation } from "react-router";

import { useIsMobile } from "@/hooks/use-mobile";
import { useI18n } from "../i18n";

interface ConsoleShellProps {
  sidebar: ReactNode;
  breadcrumb: ReactNode;
  children: ReactNode;
}

// Ширина бокового меню как в портале DDC: 256px (w-64).
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 320;
const COLLAPSE_THRESHOLD = 170;

/** Постоянный каркас консоли, не зависящий от маршрута. Вход и маршрутизация
 * живут в AppShell, а здесь только пять состояний бокового меню и геометрия
 * слотов. */
export function ConsoleShell({
  sidebar,
  breadcrumb,
  children,
}: ConsoleShellProps) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768,
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarOverlayOpeningRef = useRef(false);
  const sidebarRailRef = useRef<HTMLDivElement>(null);
  const hoverZoneRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const previousMobile = useRef(isMobile);

  const hasExpandedSidebarPortal = useCallback(() => {
    return Boolean(
      sidebarRailRef.current?.querySelector(
        '[aria-expanded="true"], [data-state="open"][data-slot$="trigger"]',
      ),
    );
  }, []);

  const isInsideTopbarHotZone = useCallback(
    (target: Node, clientX: number) => {
      const topbar = topbarRef.current;
      if (!topbar?.contains(target)) return false;
      return clientX <= topbar.getBoundingClientRect().left + sidebarWidth;
    },
    [sidebarWidth],
  );

  useEffect(() => {
    if (isMobile && !previousMobile.current) {
      setSidebarOpen(false);
      setPreviewOpen(false);
    }
    previousMobile.current = isMobile;
  }, [isMobile]);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    setPreviewOpen(false);
  }, []);

  // Выдвижное меню на телефоне закрывает страницу: после перехода оно
  // закрывается само, как в портале DDC.
  useEffect(() => {
    if (isMobile) closeSidebar();
  }, [pathname, isMobile, closeSidebar]);

  const showSidebar = useCallback(() => {
    setPreviewOpen(false);
    setSidebarOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        setPreviewOpen(false);
        setSidebarOpen((open) => !open);
      }
      if (event.key === "Escape") {
        if (isMobile) closeSidebar();
        else setPreviewOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSidebar, isMobile]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = drag.startWidth + event.clientX - drag.startX;
      if (next < COLLAPSE_THRESHOLD) {
        dragRef.current = null;
        closeSidebar();
        return;
      }
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next)));
    };
    const onPointerUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [closeSidebar]);

  useEffect(() => {
    if (sidebarOpen || isMobile || !previewOpen) return;

    const onPointerMove = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (sidebarRailRef.current?.contains(target)) return;
      if (hoverZoneRef.current?.contains(target)) return;
      if (isInsideTopbarHotZone(target, event.clientX)) return;
      if (hasExpandedSidebarPortal()) {
        sidebarOverlayOpeningRef.current = false;
        return;
      }
      sidebarOverlayOpeningRef.current = false;
      setPreviewOpen(false);
    };

    document.addEventListener("pointermove", onPointerMove);
    return () => document.removeEventListener("pointermove", onPointerMove);
  }, [hasExpandedSidebarPortal, isInsideTopbarHotZone, isMobile, previewOpen, sidebarOpen]);

  const sidebarVisible = sidebarOpen || previewOpen;
  const sidebarState = isMobile
    ? sidebarOpen
      ? "mobile-drawer"
      : "mobile-hidden"
    : sidebarOpen
      ? "desktop-full"
      : previewOpen
        ? "desktop-preview"
        : "desktop-hidden";

  return (
    <div
      className="console-shell"
      data-console-shell
      data-sidebar-state={sidebarState}
      style={{ "--shell-sidebar-current-w": `${sidebarWidth}px` } as CSSProperties}
    >
      <div
        className="console-sidebar-preview-scrim"
        data-testid="sidebar-preview-scrim"
        data-open={previewOpen && !sidebarOpen && !isMobile ? "true" : "false"}
        aria-hidden="true"
      />

      <div
        ref={sidebarRailRef}
        className="console-sidebar-rail"
        data-shell-slot="sidebar"
        aria-hidden={!sidebarVisible}
        onPointerDownCapture={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest("[data-sidebar-overlay-trigger]")
          ) {
            sidebarOverlayOpeningRef.current = true;
          }
        }}
        onMouseLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (
            nextTarget instanceof Node &&
            isInsideTopbarHotZone(nextTarget, event.clientX)
          ) {
            return;
          }
          if (
            !sidebarOpen &&
            !isMobile &&
            !sidebarOverlayOpeningRef.current &&
            !hasExpandedSidebarPortal()
          ) {
            setPreviewOpen(false);
          }
        }}
      >
        {sidebar}
        {sidebarOpen && !isMobile && (
          <Button
            variant="ghost"
            type="button"
            className="console-sidebar-resize"
            aria-label={t.shell.resizeSidebar}
            title={t.shell.resizeSidebar}
            onPointerDown={(event) => {
              event.preventDefault();
              dragRef.current = { startX: event.clientX, startWidth: sidebarWidth };
            }}
          />
        )}
      </div>

      {!sidebarOpen && !isMobile && (
        <div
          ref={hoverZoneRef}
          className="console-sidebar-hover-zone"
          aria-hidden="true"
          onMouseEnter={() => setPreviewOpen(true)}
        />
      )}

      {isMobile && sidebarOpen && (
        <PlainButton
          className="console-sidebar-scrim"
          aria-label={t.shell.closeSidebar}
          title={t.shell.closeSidebar}
          onClick={closeSidebar}
        />
      )}

      <div className="console-workspace" data-shell-slot="workspace">
        <header
          ref={topbarRef}
          className="console-topbar"
          data-top-row
          onPointerMove={(event) => {
            if (
              !sidebarOpen &&
              !isMobile &&
              isInsideTopbarHotZone(event.target as Node, event.clientX)
            ) {
              setPreviewOpen(true);
            }
          }}
        >
          {!sidebarOpen && (
            <Button
              variant="ghost"
              type="button"
              className="console-sidebar-restore"
              aria-label={t.shell.showSidebar}
              title={t.shell.showSidebar}
              onClick={showSidebar}
            >
              {isMobile ? (
                <MenuIcon aria-hidden="true" />
              ) : (
                <PanelLeftOpenIcon aria-hidden="true" />
              )}
            </Button>
          )}
          {breadcrumb}
        </header>

        <section
          className="console-route-surface"
          data-testid="console-route-surface"
        >
          {children}
        </section>
      </div>
    </div>
  );
}
