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

## Правка 2026-10-19: LibreOffice и урезанный SKILL.md

- `SKILL.md` урезан по плану `docs/plans/environment-programs.md`, срез Н2. Ушли процедура создания колоды и строки создания в «How to Run». `pptx_create.py` остался в `scripts/` и занимает одну строку в Quick Reference. Остались чтение, правка, шаблоны, проверка картинкой и перевод в PDF. Описание во frontmatter говорит о том же, версия 1.2.0.
- `SKILL.md`, «Platform notes». Вместо установки через `pip --break-system-packages` и шаблона «Документы» названы образ окружения «Рабочее место с LibreOffice» и проверка `command -v soffice`. Если LibreOffice нет, агент просит пользователя выбрать этот образ на карточке окружения и не ставит LibreOffice через apt-get.
- `SKILL.md`, проверка картинкой: `soffice --headless --convert-to pdf`, затем `pdftoppm -png -r 80`.
- `scripts/pptx_create.py`. Подзаголовок на макете без своего заполнителя (`title_content` и другие) идёт надписью под заголовком, тело сдвигается ниже. В источнике подзаголовок писался в заполнитель 1, и пункты списка его стирали. Спецификация проверяется до сборки: незнакомый ключ верхнего уровня, ключ слайда или макет останавливают скрипт с кодом 1, местом и списком допустимых значений.
- `scripts/_soffice.py`, новый файл, такой же лежит в навыке xlsx. Он ищет `soffice` или `libreoffice`, даёт каждому запуску свой временный профиль LibreOffice и останавливает зависший запуск по таймауту. Если LibreOffice нет, подсказка называет образ «Рабочее место с LibreOffice».
- `scripts/pptx_render.py` работает через `_soffice.py`. Новый ключ `--timeout`, разрешение по умолчанию 80 точек на дюйм вместо 100. Сбой или таймаут дают выход 1 с одной строкой в stderr вместо трассировки.
- `tests/test_powerpoint_skill.py`. В конец добавлены проверки подзаголовка, отказа на неверную спецификацию и рендера с подменённым LibreOffice: поиск по имени `libreoffice`, временный профиль, таймаут, подсказка без LibreOffice.
