import { useEffect, useMemo, useState } from "react";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Logo } from "../components/Logo";
import { LocalDebugOnlyWarning } from "../components/LocalDebugOnlyWarning";

/** Браузерная часть `oma bridge setup`. CLI занимает случайный порт на
 *  127.0.0.1 и открывает этот адрес с
 *  `?cb=http://127.0.0.1:<port>/cb&state=<nonce>`. Пользователь входит
 *  (cookie-сессия), страница отправляет POST /v1/oma/runtimes/connect-runtime
 *  и получает одноразовый код обмена, затем возвращает пользователя на
 *  локальный адрес CLI с `?code=...&state=...`. CLI меняет код на постоянный
 *  токен среды через /agents/runtime/exchange.
 *
 *  Зеркало CliLogin.tsx: та же форма, другая точка выдачи кода, один код на
 *  установку (без разбора по пространствам: токен принадлежит активному
 *  пространству на момент выдачи кода). */

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
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

export function ConnectRuntime() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("cb") ?? "";
  const state = params.get("state") ?? "";
  const callbackOk = isLoopback(callback);

  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  // Параметры адреса проверяются сразу, чтобы неверный callback не тратил
  // запрос к /v1/oma/me. Тот же запрет несёт условие в запросе ниже.
  const paramsValid = callbackOk && !!state && state.length >= 8;
  useEffect(() => {
    if (!callbackOk) {
      setError(
        "Недопустимый адрес возврата: разрешены только локальные адреса (127.0.0.1, localhost).",
      );
      return;
    }
    if (!state || state.length < 8) {
      setError("Параметр state отсутствует или неверен. Запустите команду oma bridge setup ещё раз.");
    }
  }, [callbackOk, state]);

  // Запрос /v1/oma/me через TQ. Он не дублируется за время жизни страницы:
  // переключение вкладки не повторяет запрос в пределах staleTime.
  const meQuery = useApiQuery<MeResponse>(paramsValid ? "/v1/oma/me" : null);
  const me = meQuery.data ?? null;
  const loading = paramsValid ? meQuery.isLoading : false;

  // Сбой /v1/oma/me: 401 показывает кнопку «Войти», остальное выводится в тексте.
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

  const approve = async () => {
    if (!me) return;
    setWorking(true);
    setError("");
    try {
      const { code } = await api<{ code: string; expires_at: number }>(
        "/v1/oma/runtimes/connect-runtime",
        {
          method: "POST",
          body: JSON.stringify({ state }),
        },
      );
      const url = new URL(callback);
      url.searchParams.set("code", code);
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
    <div className="bg-ddc-bg flex min-h-screen items-center justify-center px-4 py-8">
      <div className="card w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size="md" />
          <div className="min-w-0">
            <h1 className="text-lg leading-7 font-semibold text-ddc-heading">
              Подключение компьютера
            </h1>
            <p className="truncate text-xs text-ddc-text-muted">Локальная среда агентов</p>
          </div>
        </div>

        {loading && (
          <div role="status" className="flex items-center gap-2 text-sm text-ddc-text-muted">
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
            Проверяем сессию…
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="callout-danger mb-4">
            <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <span className="prose-wrap min-w-0">{error}</span>
          </div>
        )}

        {!loading && authNeeded && (
          <>
            <p className="mb-4 text-sm text-ddc-text-muted">
              Войдите, чтобы разрешить подключение этого компьютера.
            </p>
            <Button onClick={goLogin} className="w-full">
              Войти
            </Button>
          </>
        )}

        {!loading && !authNeeded && me && callbackOk && (
          <>
            <p className="mb-2 text-sm text-ddc-text">
              Разрешить этому компьютеру подключиться к консоли агентов от имени{" "}
              <span className="prose-wrap font-medium text-ddc-heading">
                {me.user?.email ?? me.user?.id ?? "этого пользователя"}
              </span>{" "}
              в рабочем пространстве{" "}
              <span className="prose-wrap font-medium text-ddc-heading">{me.tenant.name}</span>?
            </p>
            <p className="mb-5 text-xs text-ddc-text-muted">
              Когда вы привяжете к этому компьютеру агента, демон будет запускать на нём
              ACP-совместимых агентов (Claude Code, Codex и других). Отозвать доступ можно в любой
              момент на странице «Локальные среды».
            </p>
            <LocalDebugOnlyWarning className="mb-5" />

            <div className="flex gap-2">
              <Button onClick={approve} loading={working} className="flex-1">
                Разрешить
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={working}>
                Отмена
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
