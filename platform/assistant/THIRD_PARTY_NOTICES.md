# Сторонние источники текстов ассистента

Промпт `prompt.md` и документы `docs/*.md` написаны по-русски для этой платформы. Часть документов пересказывает чужие тексты, такие документы помечены строкой «Изменения» в начале. Ниже источники, их лицензии и что мы изменили.

## Пересказанные тексты

### OpenMA, навык create-agent

- Источник: https://github.com/openma-ai/open-managed-agents, файл `skills/create-agent/SKILL.md`, коммит 1e44c89.
- Лицензия Apache-2.0, текст в `licenses/openma-LICENSE.txt`.
- Где использован: `docs/platform-builder.md`, раздел «Процесс».
- Изменения: перевод на русский; команды `oma` и прямые запросы к API заменены инструментами ассистента; имена моделей провайдера заменены карточками моделей; добавлены подтверждение каждой записи, пачка `apply_changes`, создание сессии и первого сообщения; убраны запуск деплойментов и Cloudflare.

### anthropics/skills, навык skill-creator

- Источник: https://github.com/anthropics/skills, папка `skills/skill-creator`.
- Лицензия Apache-2.0, текст в `licenses/anthropics-skills-skill-creator-LICENSE.txt`.
- Где использован: `docs/writing-skills.md`.
- Изменения: перевод и сокращение; убраны прогон оценок через `claude -p`, скрипты `run_eval.py`, `run_loop.py` и просмотрщик результатов; проверка навыка перенесена в тестовую сессию платформы; добавлены ограничения платформы на размер и версии навыка.

## Идеи без копирования текста

Из этих источников мы взяли устройство или названия, текст написан заново. Лицензионный текст для них не нужен, ссылки оставлены для справки.

- Спецификация Agent Skills, https://agentskills.io: поля frontmatter и их пределы. Используется в `docs/writing-skills.md`.
- claude-cookbooks, ноутбуки `managed_agents` (MIT): подход к рубрике outcome и версиям промпта. Используется в `docs/outcomes-and-evals.md`.
- promptfoo (MIT) и Google ADK (Apache-2.0): названия проверок траектории. Используются в `docs/outcomes-and-evals.md`.
- Opik (Apache-2.0) и Langfuse (MIT): порядок чтения трассы одной сессии через MCP. Используется в `docs/session-review.md`.
- n8n-mcp, Langfuse, Langflow: таблица классов операций и карточка с разницей. Используются в коде сервера, текста отсюда нет.

## Что не берём

Код и тексты Dify, n8n, каталогов `ee` в Mastra, langgraph-api и Arize Phoenix не берём, их лицензии не подходят. Навыки docx, pdf, pptx, xlsx и doc-coauthoring из anthropics/skills не копируем, их лицензия запрещает хранить копии вне сервисов Anthropic. Руководства plugin-dev из claude-code-plugins тоже не копируем: локальная копия идёт под условиями Anthropic со всеми правами, текст `docs/system-prompts.md` свой.
