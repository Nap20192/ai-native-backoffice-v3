import type { HTMLAttributes } from "react";

/**
 * Security boundary for subscription-backed model credentials.
 *
 * A Codex/ChatGPT subscription credential is intentionally only supported by
 * a trusted local direct-host during development. Remote and managed
 * sandboxes must receive an approved model-gateway credential instead; this
 * component keeps that boundary visible anywhere a user can connect or
 * configure a runtime.
 */
export function LocalDebugOnlyWarning({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="note"
      aria-label="Только для локальной отладки"
      className={`callout-warning flex-col gap-1 text-xs ${className}`.trim()}
      {...props}
    >
      <div className="font-semibold">Только для локальной отладки, высокий риск</div>
      <p className="leading-relaxed">
        Вход по подписке Codex/ChatGPT остаётся на этом доверенном хосте. Никогда не копируйте
        <code className="mx-1 rounded bg-ddc-surface px-1 py-0.5 font-mono text-2xs">~/.codex/auth.json</code>
        или токены OAuth в песочницу. Удалённые и управляемые песочницы должны использовать
        утверждённый API-ключ или OAuth провайдера через шлюз моделей OMA.
      </p>
      <p className="leading-relaxed">
        Учётные данные подписки не подходят для рабочей среды: условия провайдера, лимиты
        или проверки безопасности могут ограничить или заблокировать аккаунт. Этот путь только
        для локальной отладки.
      </p>
    </div>
  );
}
