# Источник навыка pdf

- Репозиторий: https://github.com/NousResearch/hermes-agent
- Папка: `skills/productivity/pdf`
- Коммит: `acc3cada0da86c81efc8aa6c5a291989549ca900` от 2026-10-16
- Лицензия: MIT, Copyright (c) 2026 Nous Research. Текст лежит рядом в `LICENSE` без изменений.

Остальные файлы скопированы как в источнике. Правки для платформы перечислены ниже, в коде их отмечает комментарий `OpenMA port`.

## Что не перенесено

- `scripts/extract_pymupdf.py` и `scripts/extract_marker.py`. Они вызывают pymupdf под AGPL и marker под GPL.
- `references/ocr-extraction.md`, справочник к этим двум скриптам.
- `references/nano-pdf-editing.md`. Он описывает внешний CLI, которому нужен ключ чужой LLM.

## Что изменено

- `SKILL.md`, frontmatter. Описание перечисляет только оставшиеся возможности, без OCR и правки текста. Добавлено поле `display_title: PDF`. В `related_skills` имя `powerpoint` заменено на `pptx`.
- `SKILL.md`, новый раздел «Platform notes (OpenMA)». Он называет точку монтирования `/workspace/.openma/skills/pdf/latest/pdf/`, папку выходов `/mnt/session/outputs/` без подпапок, инструменты платформы, установку пакетов, шрифт DejaVu и папку навыка для агента с закреплённой версией.
- `SKILL.md`, ссылки на удалённые справочники заменены советом выгрузить страницы в PNG и посмотреть их инструментом `read`.
- `SKILL.md`, команды в «How to Run» идут через `python3` и полный путь к `scripts/`. Пример создания пишет файл в `/mnt/session/outputs/`.
- `SKILL.md`, имена инструментов Hermes заменены на инструменты платформы: `terminal` на `bash`, `write_file` на `write`, `read_file` и `vision_analyze` на `read`.
- `scripts/_fonts.py`, новый файл. Он регистрирует в reportlab шрифт DejaVu Sans, если тот установлен, иначе оставляет Helvetica и пишет предупреждение.
- `scripts/pdf_create.py`. Стили, таблица и номер страницы рисуются шрифтом из `_fonts.py`, кириллица больше не выходит квадратами. Новое поле спецификации `page_number_format`, по умолчанию `Page {page}`.
- `scripts/pdf_stamp.py`. Без `--font` штамп рисуется шрифтом из `_fonts.py`.
- `scripts/pdf_make_form.py`. Подписи полей рисуются шрифтом из `_fonts.py`.
- `tests/test_pdf_skill.py`. В конец добавлены три проверки кириллицы.
