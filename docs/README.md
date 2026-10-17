# Документация платформы агентов

Черновик 2, 2026-10-15.

## Карта

| Документ | Что внутри | Когда читать |
|---|---|---|
| [design.md](design.md) | Общий дизайн: объекты, ход сессии, harness, MCP Hub, агенты в консоли, боты, драйверы, Kubernetes, план | Сначала |
| [decisions.md](decisions.md) | 40 решений по стыковке компонентов (D1...D40), общие контракты (`RunTurn`, лимиты, имена, коды ошибок), вопросы владельцу | Перед работой над любым стыком |
| [decisions-2026-10-17.md](decisions-2026-10-17.md) | D41: остался только harness Pi, ACP и `ai-sdk` удалены. D42: Temporal отложен, условия возврата к нему и план на Postgres | Перед работой над harness, очередью ходов и репликами. Главнее design.md и спек 02, 03 |
| [components/](components/) | Спеки 10 компонентов. В начале каждой раздел «0. Согласовано», он главнее остального текста | Когда делаешь компонент |
| [flows/](flows/) | 10 сквозных сценариев. По ним нашли нестыковки, решения в `decisions.md` | Для проверки и приёмочных тестов |

### Компоненты

| № | Спека | Коротко |
|---|---|---|
| 01 | [Runtime API и журнал](components/01-runtime-api.md) | Вход в Runtime, журнал событий в Postgres, SSE, ожидания, Storage |
| 02 | [SessionWorkflow](components/02-session-workflow.md) | Temporal: когда и что запускать, ожидания, outcomes, сабагенты, сон песочницы. Temporal отложен, D42 |
| 03 | [Harness-воркеры](components/03-harness-workers.md) | Один ход: ACP с Claude и Codex, `simple`, восстановление после падения. ACP удалён, остался Pi, D41 |
| 04 | [Песочница](components/04-sandbox.md) | Environment, драйверы `docker` и `kubernetes`, `sandboxd`, сон и пробуждение |
| 05 | [MCP Hub](components/05-mcp-hub.md) | Реестр тулов, права, подтверждения, токен сессии, встроенные серверы |
| 06 | [Vault, egress, шлюз моделей](components/06-vault-egress-models.md) | Секреты, подмена на выходе, бюджеты, маршрут по классу данных |
| 07 | [Control plane агентов](components/07-agent-control-plane.md) | Черновик, версии, публикация, конструктор, консоль |
| 08 | [IAM и тенанты](components/08-iam-tenancy.md) | Кто, в каком тенанте, что можно. Роли, согласования, аудит |
| 09 | [Каналы и боты](components/09-channels-bots.md) | Slack, Telegram, web. Роутер, `send_user`, карточки подтверждений |
| 10 | [Deployments, память, скиллы](components/10-deployments-memory-skills.md) | Расписания и вебхуки, memory stores, пакеты скиллов |

### Сценарии

| № | Сценарий | Главные решения |
|---|---|---|
| 01 | [Создание агента в консоли](flows/01-create-agent.md) | D10...D15, D29, D36 |
| 02 | [Ход в web-чате с падением воркера](flows/02-chat-turn-crash.md) | D1, D4, D6...D9 |
| 03 | [Write-тул с подтверждением через часы](flows/03-write-approval.md) | D2, D16 |
| 04 | [Custom tool и сообщения во время ожидания](flows/04-custom-tool-busy.md) | D2, D3, D17, D18 |
| 05 | [Бот в Slack-треде](flows/05-slack-bot.md) | D30, D31, D32 |
| 06 | [Отчёт по расписанию с outcome и сабагентами](flows/06-scheduled-report.md) | D18, D33, D34, D35 |
| 07 | [Внешний API с секретом из vault](flows/07-secret-egress.md) | D26, D27 |
| 08 | [Новая версия агента при идущих сессиях](flows/08-version-rollout.md) | D21, D22, D23 |
| 09 | [Сон и пробуждение песочницы](flows/09-sandbox-sleep-wake.md) | D24, D25, D26 |
| 10 | [Изоляция тенантов](flows/10-tenant-isolation.md) | D9, D25, D26, D28, D40 |

## Как компоненты связаны

Подписи на стрелках это контракты. Номер решения в скобках ведёт в [decisions.md](decisions.md).

```mermaid
flowchart TB
    subgraph IN["Входы"]
        CON["Консоль и SDK"]
        CHAT["Slack, Telegram, web"]
    end

    subgraph CP["Управление"]
        C07["07 Control plane агентов"]
        C08["08 IAM и тенанты"]
        C10["10 Deployments, память, скиллы"]
        C09["09 Каналы и боты"]
    end

    subgraph RT["Runtime"]
        C01["01 Runtime API и журнал"]
        C02["02 SessionWorkflow (Temporal)"]
        C03["03 Harness-воркеры"]
        C04["04 Песочница"]
    end

    subgraph HUBG["MCP Hub"]
        C05["05 MCP Hub"]
        C06["06 Vault, egress-прокси, шлюз моделей"]
    end

    EXT["Внешние MCP-серверы, API, провайдеры моделей"]

    CON -->|"REST /v1/agents, publish"| C07
    CON -->|"POST /v1/sessions, events, SSE stream"| C01
    CHAT -->|"вебхуки с подписью"| C09
    C09 -->|"POST /v1/sessions и events с act_as, event-stream (D31)"| C01
    C10 -->|"POST /v1/sessions Idempotency-Key run_id, terminate (D33)"| C01
    C07 -->|"тест: POST /v1/sessions config_id tst_ (D36)"| C01

    C01 -->|"agent-refs:resolve, agent-configs по config_id (D21, D10)"| C07
    C01 -->|"session-principals (D19)"| C08
    C01 -->|"ResolveSessionContext (D19)"| C10
    C01 -->|"Signal-With-Start inputs_appended, updates ответов (D1)"| C02

    C02 -->|"activity RunTurn, контракт A1 (D4)"| C03
    C02 -->|"ensure_sandbox: Provision, Wake, Hibernate, Destroy (D24)"| C04
    C02 -->|"DecideApproval, ExecuteApprovedCall, CancelApproval (D16)"| C05
    C02 -->|"AppendSystemEvents, session.status"| C01
    C02 -->|"Grade через шлюз, DELETE egress-bundle (D34, D27)"| C06

    C03 -->|"turns/claim, events:append, deltas, waits (D6)"| C01
    C03 -->|"session-tokens, MCP /mcp (D9)"| C05
    C03 -->|"Attach replace, Exec (D8, D25)"| C04
    C03 -->|"вызовы модели с токеном сессии (D9)"| C06

    C04 -->|"egress-bundle при Provision и Wake (D26)"| C06
    C04 -.->|"песочница: HTTPS_PROXY :3128, Hub :443, модели :443"| C06

    C05 -->|"tool-scope (D11, D14, D30)"| C08
    C05 -->|"tool.confirmation_required, agent.custom_tool_use, subagents, files (D16, D17, D18)"| C01
    C05 -->|"X-Hub-Call-Context: agents (D29)"| C07
    C05 -->|"X-Hub-Call-Context: channels__send_user (D29)"| C09
    C05 -->|"X-Hub-Call-Context: тулы memory и skills (D29, D32)"| C10
    C05 -->|"вызовы upstream с vph_ через прокси (D26)"| C06

    C07 -->|"agent-configs/validate, toolsets:resolve (D13, D12)"| C05
    C07 -->|"approvals, agent-principals, principal-tokens (D15, D11)"| C08
    C08 -->|"approval.decided (D15)"| C07
    C09 -->|"identity-links, channel_identities (D31)"| C08
    C10 -->|"effective_subject SA deployment (D33)"| C08

    C06 -->|"подмена секрета только для allowed_hosts (D27)"| EXT
```

## Как читать решения

1. Нашёл расхождение между спеками: сначала ищи его в [decisions.md](decisions.md), потом в разделе 0 спеки.
2. Общие типы (`RunTurn`, лимиты, имена, коды ошибок) лежат только в приложении A к `decisions.md`. Спеки на них ссылаются.
3. Продуктовые вопросы, где выбран рекомендуемый вариант, собраны в разделе «Вопросы владельцу».
4. Крупные замечания ревью, которые ещё ждут решения (DNS песочницы, повтор хода с песочницей, шина событий, миграции, бэкапы, удаление данных, наблюдаемость, квоты, стоимость, локальный стенд), собраны в конце [decisions.md](decisions.md#замечания-ревью).
