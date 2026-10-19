# Источник навыка docx

- Репозиторий: https://github.com/NousResearch/hermes-agent
- Папка: `skills/productivity/docx`
- Коммит: `acc3cada0da86c81efc8aa6c5a291989549ca900` от 2026-10-16
- Лицензия: MIT, Copyright (c) 2026 Nous Research. Текст лежит рядом в `LICENSE` без изменений.

Остальные файлы скопированы как в источнике. Правки для платформы перечислены ниже, в коде их отмечает комментарий `OpenMA port`.

## Что изменено

- `SKILL.md`, frontmatter. Добавлено поле `display_title: Word (docx)`, его показывает консоль. В `related_skills` имя `powerpoint` заменено на `pptx`.
- `SKILL.md`, новый раздел «Platform notes (OpenMA)». Он называет точку монтирования `/workspace/.openma/skills/docx/latest/docx/`, папку выходов `/mnt/session/outputs/` без подпапок, инструменты платформы, установку пакетов и папку навыка для агента с закреплённой версией.
- `SKILL.md`, команды в «How to Run» идут через `python3` и полный путь к `scripts/`. Пример создания и конвертации в PDF пишет файл в `/mnt/session/outputs/`.
- `SKILL.md`, имена инструментов Hermes заменены на инструменты платформы: `terminal` на `bash`, `write_file` на `write`, `patch` на `edit`.
- `scripts/docx_template.py`. Имя токена разбирает `\w`, поэтому заполняются токены на кириллице вроде `{{имя}}`. В источнике такие токены молча оставались в документе.
- `scripts/docx_validate.py`. Ссылка на неописанные встроенные стили `CommentReference` и `CommentText` теперь предупреждение, а не ошибка. python-docx 1.2 ставит их при добавлении комментария, Word и LibreOffice такой файл открывают.
- `scripts/docx_common.py`, функция `replace_in_paragraph`. В источнике цикл искал старый текст и в уже вставленной замене. Если новый текст содержит старый (`Acme` на `Acme Ltd`), цикл не кончался, `docx_edit.py replace` и `docx_template.py` зависали. Теперь совпадения ищутся один раз в исходном тексте и заменяются справа налево.
- `tests/test_docx_skill.py`. В конец добавлен класс `TestPlatformPort` с проверками этих правок.

## Правка 2026-10-19: LibreOffice и урезанный SKILL.md

- `SKILL.md` урезан по плану `docs/plans/environment-programs.md`, срез Н2. Ушли шаг создания документа в «Procedure» и строка создания в «How to Run». `docx_create.py` остался в `scripts/` и занимает одну строку в Quick Reference. Остались чтение, правка, шаблоны, рецензирование, комментарии, перевод в PDF и проверка страниц. Описание во frontmatter говорит о том же, версия 1.2.0.
- `SKILL.md`, «Platform notes». Вместо установки через `pip --break-system-packages` и шаблона «Документы» названы образ окружения «Рабочее место с LibreOffice» и проверка `command -v soffice`. Если LibreOffice нет, агент просит пользователя выбрать этот образ на карточке окружения и не ставит LibreOffice через apt-get.
- `SKILL.md`, новый раздел «Visual check»: `soffice --headless --convert-to pdf`, затем `pdftoppm -png -r 80` и `pdftotext -layout`.
- Скрипты не менялись.
