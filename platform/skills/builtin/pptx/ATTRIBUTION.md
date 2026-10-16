# Источник навыка pptx

- Репозиторий: https://github.com/NousResearch/hermes-agent
- Папка: `skills/productivity/powerpoint`
- Коммит: `acc3cada0da86c81efc8aa6c5a291989549ca900` от 2026-10-16
- Лицензия: MIT, Copyright (c) 2026 Nous Research. Текст лежит рядом в `LICENSE` без изменений.

Остальные файлы скопированы как в источнике. Правки для платформы перечислены ниже, в коде их отмечает комментарий `OpenMA port` или этот список.

## Что изменено

- Папка и имя навыка. В источнике `powerpoint`, у нас `pptx`: форма агента подключает навык с id `pptx`, а сервер берёт id из имени папки. Поэтому в frontmatter `name: pptx`.
- `SKILL.md`, frontmatter. Добавлено поле `display_title: PowerPoint (pptx)`.
- `SKILL.md`, новый раздел «Platform notes (OpenMA)». Он называет точку монтирования `/workspace/.openma/skills/pptx/latest/pptx/`, папку выходов `/mnt/session/outputs/` без подпапок, инструменты платформы, установку пакетов и папку навыка для агента с закреплённой версией.
- `SKILL.md`, команды в «How to Run» идут через `python3` и полный путь к `scripts/`. Пример создания и конвертации в PDF пишет файл в `/mnt/session/outputs/`.
- `SKILL.md`, имена инструментов Hermes заменены на инструменты платформы: `terminal` на `bash`, `write_file` на `write`, `read_file` и `vision_analyze` на `read`.
- `scripts/pptx_read.py`, режимы `--outline` и `--notes`. `ensure_ascii=False`: русский текст выходит буквами, а не кодами `\u04..`, и занимает в контексте модели меньше токенов.
- `tests/test_powerpoint_skill.py`. В конец добавлена проверка вывода кириллицы.
