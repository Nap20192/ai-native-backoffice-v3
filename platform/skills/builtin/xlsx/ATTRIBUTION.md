# Источник навыка xlsx

- Репозиторий: https://github.com/NousResearch/hermes-agent
- Папка: `skills/productivity/xlsx`
- Коммит: `acc3cada0da86c81efc8aa6c5a291989549ca900` от 2026-10-16
- Лицензия: MIT, Copyright (c) 2026 Nous Research. Текст лежит рядом в `LICENSE` без изменений.

Справочник скопирован как в источнике. Скрипты и тесты тоже, кроме правок 2026-10-19 ниже.

## Что изменено

- `SKILL.md`, frontmatter. Добавлено поле `display_title: Excel (xlsx)`. В `related_skills` имя `powerpoint` заменено на `pptx`.
- `SKILL.md`, новый раздел «Platform notes (OpenMA)». Он называет точку монтирования `/workspace/.openma/skills/xlsx/latest/xlsx/`, папку выходов `/mnt/session/outputs/` без подпапок, инструменты платформы, установку пакетов и папку навыка для агента с закреплённой версией.
- `SKILL.md`, команды в «How to Run» идут через `python3` и полный путь к `scripts/`. Пример создания и конвертации в PDF и CSV пишет файл в `/mnt/session/outputs/`.
- `SKILL.md`, имена инструментов Hermes заменены на инструменты платформы: `terminal` на `bash`, `write_file` на `write`, `read_file` на `read`.

## Правка 2026-10-19: LibreOffice и урезанный SKILL.md

- `SKILL.md` урезан по плану `docs/plans/environment-programs.md`, срез Н2. Ушли шаг создания книги в «Procedure» и строка создания в «How to Run». `xlsx_create.py` остался в `scripts/` и занимает одну строку в Quick Reference. Остались чтение, правка, перестройка, пересчёт формул, CSV, перевод в PDF и проверка страниц. Описание во frontmatter говорит о том же, версия 1.2.0.
- `SKILL.md`, «Platform notes». Вместо установки через `pip --break-system-packages` и шаблона «Документы» названы образ окружения «Рабочее место с LibreOffice» и проверка `command -v soffice`. Если LibreOffice нет, агент просит пользователя выбрать этот образ на карточке окружения и не ставит LibreOffice через apt-get.
- `SKILL.md`, первый шаг «Procedure»: формулы пересчитываются через `xlsx_recalc.py`, результат проверяется `xlsx_read.py --formulas`. Новый раздел «Visual check»: `soffice --headless --convert-to pdf`, затем `pdftoppm -png -r 80`.
- `scripts/_soffice.py`, новый файл, такой же лежит в навыке pptx. Он ищет `soffice` или `libreoffice`, даёт каждому запуску свой временный профиль LibreOffice и останавливает зависший запуск по таймауту. Если LibreOffice нет, подсказка называет образ «Рабочее место с LibreOffice».
- `scripts/xlsx_recalc.py` работает через `_soffice.py`. Таймаут даёт выход 1 и JSON с ошибкой «LibreOffice timed out» вместо текста subprocess.
- `tests/test_xlsx_skill.py`. В конец добавлены проверки пересчёта с подменённым LibreOffice: поиск по имени `libreoffice`, временный профиль, таймаут, подсказка без LibreOffice.
