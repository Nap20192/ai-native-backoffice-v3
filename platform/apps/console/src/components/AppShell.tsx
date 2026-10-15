import { Input } from "@/components/ui/input";
import { useMemo } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";

import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { ROUTE_CHORDS } from "../lib/route-chords";
import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { Spinner } from "@/components/ui/spinner";
import { CommandPalette } from "./CommandPalette";
import { ConsoleShell } from "./ConsoleShell";
import { NavigationProgress } from "./NavigationProgress";

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const chordBindings = useMemo<ChordBinding[]>(
    () =>
      Object.entries(ROUTE_CHORDS).map(([path, key]) => ({
        prefix: "g",
        key,
        handler: () => navigate(path),
        label: path,
      })),
    [navigate],
  );
  useChordKeybinding(chordBindings);

  if (isLoading) {
    return (
      <div className="bg-ddc-bg flex h-screen items-center justify-center">
        <Spinner className="size-8 text-ddc-primary" aria-label={t.shell.loadingSession} />
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <TooltipProvider delayDuration={250}>
      <NavigationProgress />
      <CommandPalette />

      <div className="console-autofill-honeypot" aria-hidden="true">
        <Input type="text" tabIndex={-1} autoComplete="username" name="username" />
        <Input
          type="password"
          tabIndex={-1}
          autoComplete="current-password"
          name="password"
        />
      </div>

      <ConsoleShell sidebar={<AppSidebar />} breadcrumb={<AppBreadcrumb />}>
        <main key={pathname} className="console-route-main">
          <Outlet />
        </main>
      </ConsoleShell>
    </TooltipProvider>
  );
}
