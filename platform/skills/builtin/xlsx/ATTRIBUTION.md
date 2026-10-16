# Источник навыка xlsx

- Репозиторий: https://github.com/NousResearch/hermes-agent
- Папка: `skills/productivity/xlsx`
- Коммит: `acc3cada0da86c81efc8aa6c5a291989549ca900` от 2026-10-16
- Лицензия: MIT, Copyright (c) 2026 Nous Research. Текст лежит рядом в `LICENSE` без изменений.

Скрипты, справочник и тесты скопированы как в источнике, их код не менялся.

## Что изменено

- `SKILL.md`, frontmatter. Добавлено поле `display_title: Excel (xlsx)`. В `related_skills` имя `powerpoint` заменено на `pptx`.
- `SKILL.md`, новый раздел «Platform notes (OpenMA)». Он называет точку монтирования `/workspace/.openma/skills/xlsx/latest/xlsx/`, папку выходов `/mnt/session/outputs/` без подпапок, инструменты платформы, установку пакетов и папку навыка для агента с закреплённой версией.
- `SKILL.md`, команды в «How to Run» идут через `python3` и полный путь к `scripts/`. Пример создания и конвертации в PDF и CSV пишет файл в `/mnt/session/outputs/`.
- `SKILL.md`, имена инструментов Hermes заменены на инструменты платформы: `terminal` на `bash`, `write_file` на `write`, `read_file` на `read`.
