# AGENTS.md — контекст проекта для ИИ-агентов

> **Правило поддержки:** при добавлении/изменении функциональности обновляй этот файл в том же коммите. Считай его единственным источником правды о «как тут всё устроено и почему». README.md — для людей, AGENTS.md — для агентов.

## Что это за проект

Скрапер `byrutgame.org` → JSON-источник загрузок для **Hydra Launcher** (open-source игровой лаунчер с торрента­ми). Hydra не умеет добавлять «сайт» как источник — только публичную ссылку на JSON определённого формата. Этот проект:

1. Скрейпит страницы игр с byrutgame.org
2. Скачивает `.torrent`-файлы и вычисляет **infohash v1** (sha1 от bencode-словаря `info`)
3. Строит magnet-ссылки (`magnet:?xt=urn:btih:<hash>&tr=...`)
4. Генерирует `byrut.json` в формате Hydra и публикует его через GitHub raw-ссылку

Ссылка для Hydra (живёт у пользователя): `https://raw.githubusercontent.com/David3e234234/byrut-hydra-source/main/byrut.json`

## Формат выходного JSON (критично, менять нельзя)

```json
{
  "name": "ByrutGame",
  "downloads": [
    {
      "title": "Чистое название игры",
      "uris": ["magnet:?xt=urn:btih:..."],
      "uploadDate": "2026-09-03 00:00",
      "fileSize": "10.94 GB"
    }
  ]
}
```

- Сопоставление в Hydra идёт **по title** (нормализация названия), поэтому `title` должен быть чистым: без «торрент на ПК», «(последняя версия X.Y)», «скачать». За это отвечает `extractTitle()`
- Никаких лишних полей верхнего уровня — Hydra ожидает `name` + `downloads`
- `_torrentUrl` — служебное поле кэша, перед записью в `byrut.json` удаляется

## Файлы

| Файл | Назначение | Можно удалять? |
|---|---|---|
| `scrape.mjs` | весь скрапер, один файл, без зависимостей (Node 18+, встроенный fetch) | нет |
| `byrut.json` | артефакт для Hydra, коммитится в репо | нет |
| `.cache/downloads.json` | накопительная база «URL страницы игры → {title, uris, uploadDate, fileSize}». **Коммитится** — это память между запусками Actions | нет |
| `.github/workflows/update.yml` | автообновление по cron + ручные режимы | нет |

## Архитектура scrape.mjs

Один файл, ~500 строк, без npm-зависимостей. Ключевые функции:

- `fetchText(url)` — fetch с браузерным UA, таймаутом 30с
- `decodeBencodeAt(buf, off)` / `computeInfohash(buf)` — мини-bencode парсер; infohash = sha1 от сырых байт словаря `info` (важно: не перере-кодировать, считать хэш от **оригинального среза байт**)
- `extractGameLinks(html)` — regex по `/https?:\/\/byrutgame.org\/(\d+)-[a-z0-9-]+\.html/gi`
- `extractTitle / extractSize / extractDate` — парсинг из HTML; юниты нормализуются к латинице (`ГБ→GB`) для стабильности отпечатка
- `extractTorrentLink` — приоритет кнопке `class="itemtop_games"`; download URL вида `https://byrutgame.org/index.php?do=download&id=N`
- `downloadTorrent` — с ретраями (2), реферером и проверкой bencode-магии (первый байт `d` или цифра)
- `loadSitemapGameUrls()` — читает `news_pages.xml` + `news_pages2.xml` (~55 500 URL игр; у category_pages.xml игр нет)
- `processGamePage(link, cache, entries)` — сердце: страница → отпечаток → (новая | обновлённая | без изменений) → magnet
- `main()` — режимы (см. ниже), периодическое сохранение кэша каждые 50 игр, финальная запись `byrut.json` + кэша

### Кэш и отпечаток обновлений

- Ключ кэша — URL страницы игры → дублей не бывает
- Отпечаток игры: `fileSize|uploadDate|title`. Не совпал с кэшем → на сайте обновился репак → (при `--refresh`) перекачка `.torrent` и новый magnet
- Кэшированные игры в режиме `--all` проходят **мгновенно и не тратят лимит** `--limit`

## Режимы запуска

```bash
node scrape.mjs                          # новости: 3 страницы (дефолт)
node scrape.mjs --pages N                # N страниц новостей
node scrape.mjs --all                    # весь sitemap (без лимита — дни!)
node scrape.mjs --all --limit N          # до N НОВЫХ игр за запуск
node scrape.mjs --check-updates --updates-limit N --refresh  # проверка N закэшированных игр на обновление версии
node scrape.mjs --full                   # легаси-флаг: перечитать кэшированные в news-режиме
```

Флаги: `--refresh` разрешает перекачку magnet при изменении отпечатка (без него — только фиксация метаданных).

## GitHub Actions (`.github/workflows/update.yml`)

| Триггер | Что делает |
|---|---|
| cron `0 3 * * *` | `--pages 5` (новинки) |
| cron `0 5 * * *` | `--all --limit 4000` (порция каталога) |
| cron `0 7 * * *`-подобный шаг в том же job | `--check-updates --updates-limit 1500 --refresh` |
| `workflow_dispatch` | ручной выбор режима: `all` / `news` / `check-updates` |

Жёсткие ограничения, которые нельзя нарушать:
- **GitHub Actions job ≤ 6 часов** → timeout-minutes: 350, лимиты подобраны под это
- Расписание GitHub замирает при неактивности репо 60 дней → любой коммит/ручной запуск оживляет
- Коммитит `github-actions[bot]`; git identity пользователя: `David3e234234 <170133610+David3e234234@users.noreply.github.com>` (noreply — чтобы не светить реальный email)

## Оценки времени (паузы вежливости: 1.5с страница, 0.7с torrent)

- Новая игра ≈ 2.2–2.5с → 4000 игр ≈ 2.5ч
- Полный каталог (~55 500) ≈ 1.5–2 суток одним прогоном → только порциями `--limit`
- check-updates по 1500/день → полный круг по каталогу ≈ 5 недель
- Не уменьшай паузы: сайт чужой, забанят UA — всё встанет

## Известные нюансы / грабли

1. **Страница без кнопки «Скачать торрент»** = анонс без релиза → пропуск (в логе `не найдена ссылка`). Это норма, не баг
2. **`/tmp` в Git Bash на Windows не работает** для python-скриптов (пути ломаются) — использовать файлы в корне проекта и удалять после
3. **Python на машине пользователя**: `python` (3.11) есть, `python3` — алиас на Microsoft Store (не работает)
4. **CRLF/LF**: git на Windows ругается warning'ами при add — безвредно
5. **git identity**: был инцидент — email `scraper@users.noreply.github.com` совпал с чужим GitHub-аккаунтом (Petro Franko) и подмесился в контрибьюторы. Исправлено перезаписью истории (`filter-branch`) на noreply-адрес владельца. Не использовать email без префикса `<ID>+<login>`
6. **Даты на сайте** бывают «Сегодня, 11:15» / «Вчера» — `extractDate` их не распарсит, останется старое значение из кэша (это ок)
7. **byrut.json сортируется по uploadDate desc** — Hydra показывает свежее первым
8. Обновление репака на сайте **может не менять размер/дату** (редко) — тогда детект не сработает; известных случаев не было

## Если сайт поменяет вёрстку

Порядок починки: открыть любую страницу игры → проверить по очереди `extractTitle` (тег `<title>`), `extractTorrentLink` (кнопка `itemtop_games` / `index.php?do=download&id=`), `extractSize` (`data-size`), `extractDate` (русские даты). Sitemap: `news_pages.xml`, `news_pages2.xml` (индекс: `sitemap.xml`).

## Идеи / бэклог (не реализовано)

- Зеркала трекеров в magnet (список зашит в `processGamePage`)
- Поддержка нескольких сайтов-источников (по аналогии: свой `name` в JSON, отдельные скрипты или конфиг)
- Прогресс-файл для check-updates (сейчас круг всегда с начала списка)
- Обработка «Сегодня/Вчера» в датах

## Чеклист при изменении scrape.mjs

- [ ] `node --check scrape.mjs` — синтаксис
- [ ] Локальный прогон `node scrape.mjs --pages 1` (минуты) или `--all --limit 3`
- [ ] Проверить `byrut.json`: title чистые, magnet валидные (`urn:btih:` + 40 hex), `fileSize` в латинских юнитах
- [ ] Обновить этот файл и README.md
- [ ] Коммит + пуш (Actions подхватит само)
