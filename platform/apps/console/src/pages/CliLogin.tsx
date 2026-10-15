import { useEffect, useMemo, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Logo } from "../components/Logo";
import { useBranding } from "../lib/branding";

// Browser-side handler for `oma auth login`. The CLI opens this URL with
// callback + state in the query string, the user authenticates (cookie
// session) + picks one or more workspaces, and the page redirects back
// to the CLI's loopback server with N freshly-minted per-tenant tokens.
//
// Flow:
//   1. Read query params (callback, state, hostname, tenant?).
//   2. If no cookie session → bounce through /login with `next=` set to here.
//   3. Fetch /v1/oma/me to learn user + memberships.
//   4. Show approval UI: when N==1, just an Approve button; when N>1, a
//      checkbox list (defaults: ?tenant pre-selected, otherwise all).
//   5. POST /v1/oma/me/cli-tokens N times — one token per selected tenant.
//   6. window.location = `${callback}?tokens=<base64-json>&user=...&state=...`
//      — the array form so the CLI can populate every selected tenant's
//      profile in one round trip.
//
// Security notes:
//   - The `state` param is opaque to us; the CLI generates a nonce, stashes
//     it locally, and verifies it on the callback. We just round-trip it.
//   - The `callback` param MUST be a 127.0.0.1 / localhost URL — we reject
//     anything else so a malicious link can't trick a logged-in user into
//     handing tokens to an attacker-controlled host.
//   - One mint failure aborts the whole batch — partial tokens are
//     surfaced as an error, not silently delivered, so the user can see
//     exactly what landed.

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

interface MintedToken {
  tenant_id: string;
  tenant_name: string;
  role: string;
  token: string;
  key_id: string;
}

function isLoopback(callbackUrl: string): boolean {
  try {
    const u = new URL(callbackUrl);
    if (u.protocol !== "http:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

function tenantDisplayName(t: { id: string; name: string }): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) {
    return t.id;
  }
  return trimmed;
}

/** Browser-safe base64-encode of a UTF-8 JSON string. */
function encodeTokensParam(tokens: MintedToken[]): string {
  const json = JSON.stringify(tokens);
  // Use the binary-safe TextEncoder→btoa pattern; raw btoa() chokes on
  // multibyte characters that may appear in tenant names.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function CliLogin() {
  const { api } = useApi();
  const branding = useBranding();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("callback") ?? "";
  const state = params.get("state") ?? "";
  const hostname = params.get("hostname") ?? "этом устройстве";
  const requestedTenant = params.get("tenant") ?? "";
  const callbackOk = isLoopback(callback);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>("");

  // /v1/oma/me lookup via TQ. `enabled: callbackOk` defers the fetch until
  // we've validated the callback URL — an invalid callback short-circuits
  // straight to the error banner with no API roundtrip. /v1/oma/me's 401 is
  // already on useApi's silent-auth list so a pre-auth visit doesn't
  // produce a stray toast.
  const meQuery = useApiQuery<MeResponse>(
    callbackOk ? "/v1/oma/me" : null,
  );
  const loading = callbackOk ? meQuery.isLoading : false;

  // Apply the side effects of a successful /v1/oma/me — seed the default
  // workspace selection and stash the response for the render path.
  // Kept in an effect so a TQ refetch (tab focus, etc.) re-applies the
  // same defaults if data changes shape.
  useEffect(() => {
    if (!callbackOk) {
      setError("Недопустимый адрес обратного вызова. Разрешены только локальные адреса (127.0.0.1, localhost).");
      return;
    }
    const res = meQuery.data;
    if (!res) return;
    setMe(res);
    // Default selection: respect ?tenant if it's a real membership,
    // otherwise select all (the "authorize CLI for everything" intent
    // most multi-tenant users have on first login).
    const ids = res.tenants.map((t) => t.id);
    if (requestedTenant && ids.includes(requestedTenant)) {
      setSelected(new Set([requestedTenant]));
    } else {
      setSelected(new Set(ids));
    }
  }, [callbackOk, meQuery.data, requestedTenant]);

  // /v1/oma/me failure handling: 401 → bounce to /login; anything else → show
  // the message inline. Matches the prior .catch() branch.
  useEffect(() => {
    const err = meQuery.error;
    if (!err) return;
    if (/401|Unauthorized/i.test(String((err as Error).message))) {
      setAuthNeeded(true);
    } else {
      setError(String((err as Error).message ?? err));
    }
  }, [meQuery.error]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!me) return;
    setSelected(new Set(me.tenants.map((t) => t.id)));
  };

  const selectNone = () => setSelected(new Set());

  const approve = async () => {
    if (selected.size === 0 || !me) return;
    setWorking(true);
    setError("");
    try {
      // Mint per-tenant tokens. Run in parallel — the endpoint is cheap
      // and the user already consented to all selected workspaces.
      const orderedSelection = me.tenants.filter((t) => selected.has(t.id));
      const minted = await Promise.all(
        orderedSelection.map(async (t) => {
          const res = await api<{ token: string; tenant_id: string; user_id: string; key_id: string }>(
            "/v1/oma/me/cli-tokens",
            {
              method: "POST",
              body: JSON.stringify({
                tenant_id: t.id,
                name: `CLI на ${hostname}`,
              }),
              // Force the mint call to operate against THIS tenant — the
              // sidebar's stored localStorage might point elsewhere, and
              // the auth middleware would otherwise mint for the wrong one.
              headers: { "x-active-tenant": t.id },
            },
          );
          return {
            tenant_id: res.tenant_id,
            tenant_name: t.name,
            role: t.role,
            token: res.token,
            key_id: res.key_id,
          } satisfies MintedToken;
        }),
      );
      const url = new URL(callback);
      url.searchParams.set("tokens", encodeTokensParam(minted));
      url.searchParams.set("user", me.user?.id ?? minted[0]?.tenant_id ?? "");
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  const cancel = () => {
    if (callbackOk) {
      const url = new URL(callback);
      url.searchParams.set("error", "user_cancelled");
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } else {
      window.location.href = "/";
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ddc-bg px-4 py-8">
      <div className="card w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size="md" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ddc-heading">Авторизация CLI</h1>
            <div className="text-xs text-muted">Клиент командной строки {branding.productName}</div>
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner />
            Проверяем сессию…
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="callout-danger mb-4">
            <AlertCircleIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {!loading && authNeeded && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Войдите, чтобы продолжить авторизацию CLI на{" "}
              <span className="font-mono text-ddc-text">{hostname}</span>.
            </p>
            <Button onClick={goLogin} className="w-full">
              Войти
            </Button>
          </div>
        )}

        {!loading && !authNeeded && me && callbackOk && (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted">
                CLI на{" "}
                <span className="font-mono text-ddc-text">{hostname}</span> запрашивает
                доступ от имени{" "}
                <span className="font-mono text-ddc-text">{me.user?.email ?? me.user?.id ?? "этого пользователя"}</span>.
              </p>
              <p className="text-xs text-muted">
                Для каждого выбранного рабочего пространства будет выпущен отдельный
                API-ключ. Ключи видны на странице «API-ключи», их можно отозвать в любой момент.
              </p>
            </div>

            {me.tenants.length === 0 ? (
              <div role="alert" className="callout-danger">
                <AlertCircleIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
                В этой учётной записи нет рабочих пространств.
              </div>
            ) : me.tenants.length === 1 ? (
              <div>
                <div className="eyebrow mb-2">Рабочее пространство</div>
                <div className="flex items-center gap-3 rounded-xl bg-ddc-surface-muted p-3">
                  <WorkspaceAvatar name={tenantDisplayName(me.tenants[0])} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ddc-text" title={tenantDisplayName(me.tenants[0])}>
                      {tenantDisplayName(me.tenants[0])}
                    </div>
                    <div className="text-xs text-muted">{roleLabel(me.tenants[0].role)}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="eyebrow">
                    Рабочие пространства ({selected.size}/{me.tenants.length})
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="xs" onClick={selectAll}>
                      Все
                    </Button>
                    <Button type="button" variant="ghost" size="xs" onClick={selectNone}>
                      Ничего
                    </Button>
                  </div>
                </div>
                <div className="max-h-64 divide-y divide-ddc-divider overflow-y-auto rounded-xl border border-ddc-divider">
                  {me.tenants.map((t) => {
                    const isSelected = selected.has(t.id);
                    const display = tenantDisplayName(t);
                    return (
                      <Label
                        key={t.id}
                        className={`w-full cursor-pointer gap-3 px-3 py-2.5 text-left font-normal leading-normal transition-colors hover:bg-ddc-surface-muted ${isSelected ? "bg-ddc-selected-bg" : ""}`}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggle(t.id)}
                        />
                        <WorkspaceAvatar name={display} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-ddc-text" title={display}>{display}</div>
                          <div className="truncate text-xs text-muted">
                            <span className="font-mono">{t.id}</span> · {roleLabel(t.role)}
                          </div>
                        </div>
                      </Label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                onClick={approve}
                loading={working}
                disabled={selected.size === 0 || me.tenants.length === 0}
                className="flex-1"
              >
                {working
                  ? "Авторизация…"
                  : me.tenants.length <= 1
                    ? "Разрешить"
                    : `Разрешить (${selected.size})`}
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={working}>
                Отмена
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Роль в рабочем пространстве по-русски. Неизвестная роль показывается как есть. */
function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Владелец";
    case "admin":
      return "Администратор";
    case "member":
      return "Участник";
    default:
      return role;
  }
}

/** Плитка с первой буквой названия: аватар 32px в тоне brand. */
function WorkspaceAvatar({ name }: { name: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-8 flex-none items-center justify-center rounded-lg bg-ddc-tone-brand-bg text-xs font-semibold text-ddc-tone-brand-fg"
    >
      {name.charAt(0).toUpperCase() || "·"}
    </div>
  );
}
