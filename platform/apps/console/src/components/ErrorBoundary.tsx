import { Button } from "@/components/ui/button";
import { AlertTriangleIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in the subtree so a single broken page
 * doesn't take down the whole shell. Without this, a thrown error in
 * any route blanks the entire console — sidebar, header, everything —
 * because React unmounts the tree at the nearest boundary, and there
 * isn't one above the route Outlet.
 *
 * Reset clears the error state so children re-mount cleanly. Pair with
 * a `key` on the child (e.g. location.pathname) to auto-reset on nav.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console — production source maps make this useful in
    // browser devtools. No remote sink yet (no Sentry); when one lands
    // this is the hook point.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <DefaultFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center"
    >
      <span
        className="mb-4 grid size-14 place-items-center rounded-2xl bg-ddc-tone-danger-bg text-ddc-tone-danger-fg"
        aria-hidden="true"
      >
        <AlertTriangleIcon className="size-6" />
      </span>
      <h2 className="mb-1 text-lg font-semibold text-ddc-heading">
        На странице произошла ошибка
      </h2>
      <p className="mb-6 max-w-md text-sm text-ddc-text-muted">
        {error.message || "Непредвиденная ошибка."}
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Повторить</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Обновить страницу
        </Button>
      </div>
    </div>
  );
}
