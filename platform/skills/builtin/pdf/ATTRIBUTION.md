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

- `SKILL.md` переписан заново после оценки на Qwen3.6-35B 18.10.2026 (`.verify-evidence/skill-eval-qwen/report.md`). В нём осталось то, без чего Qwen ошибся: шрифт DejaVu Sans для кириллицы, пример спецификации с таблицей и проверка файла после записи. Ещё в нём пути платформы и список остальных скриптов. Описание во frontmatter говорит о том же, поле `display_title: PDF` осталось, в `related_skills` стоит `pptx`.
- `scripts/_fonts.py`, новый файл. Он регистрирует в reportlab шрифт DejaVu Sans, если тот установлен, иначе оставляет Helvetica и пишет предупреждение.
- `scripts/pdf_create.py`. Стили, таблица и номер страницы рисуются шрифтом из `_fonts.py`, кириллица больше не выходит квадратами. Новое поле спецификации `page_number_format`, по умолчанию `Page {page}`. Таблица принимает шапку ключом `headers`. Спецификация проверяется до отрисовки: незнакомый ключ или тип элемента, строка таблицы не списком или другой ширины останавливают скрипт с кодом 1. Раньше такой ключ молча пропускался.
- `scripts/pdf_stamp.py`. Без `--font` штамп рисуется шрифтом из `_fonts.py`.
- `scripts/pdf_make_form.py`. Подписи полей рисуются шрифтом из `_fonts.py`.
- `tests/test_pdf_skill.py`. В конец добавлены три проверки кириллицы и проверки таблицы: ключ `headers`, отказ на неверную спецификацию, сборка примера из SKILL.md.

## Правка 2026-10-19: poppler

- `SKILL.md`, шаг 3 «Check the file after writing». Добавлены команды poppler `pdftotext -layout`, `pdfinfo` и `pdftoppm -png -r 80` для проверки любого PDF и строка о том, что poppler есть в образах «Рабочее место агента» и «Рабочее место с LibreOffice». Версия 1.3.0.
