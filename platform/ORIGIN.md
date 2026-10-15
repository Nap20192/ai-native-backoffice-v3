# Происхождение кода

Каталоги `apps/` и `packages/` скопированы из Open Managed Agents
(https://github.com/openma-ai/open-managed-agents), коммит 1e44c89 от 2026-10-15,
лицензия Apache 2.0 (см. LICENSE и NOTICE).

Взяты только приложения self-host сервера (`apps/main-node`, `apps/agent`), консоль
(`apps/console`) и пакеты, от которых они зависят. Cloudflare-развёртывание, `main-fly`,
`main-vercel`, сайт, документация и сервис интеграций не копировались.

Изменения поверх исходного кода фиксируются в истории git этого репозитория.
