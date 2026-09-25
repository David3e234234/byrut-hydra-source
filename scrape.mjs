#!/usr/bin/env node
/**
 * Скрапер byrutgame.org -> JSON-источник для Hydra Launcher
 *
 * Собирает последние раздачи с сайта, скачивает .torrent-файлы,
 * вычисляет infohash v1 и строит JSON формата Hydra:
 *
 * {
 *   "name": "...",
 *   "downloads": [
 *     { "title": "...", "uris": ["magnet:?xt=urn:btih:..."], "uploadDate": "...", "fileSize": "..." }
 *   ]
 * }
 *
 * Использование:
 *   node scrape.mjs                 # инкрементально: сначала кэш, потом новости
 *   node scrape.mjs --full          # полное обновление: перечитать все страницы новостей
 *   node scrape.mjs --pages 5       # прочитать только 5 страниц новостей
 *   node scrape.mjs --all           # ВЕСЬ сайт через sitemap (может занять дни за один прогон)
 *   node scrape.mjs --all --limit 500  # до 500 НОВЫХ игр за запуск (кэшированные не считаются);
 *                                      # удобно для порционного заполнения через cron/Actions
 *
 * Обнаружение обновлений: у каждой игры в кэше хранится короткий отпечаток
 * (размер + дата обновления на странице). Если отпечаток изменился — игра
 * обновилась на сайте, magnet перекачивается автоматически. Режим --full
 * больше не нужен: и news, и all проверяют обновления сами.
 */

import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const BASE = "https://byrutgame.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const OUT_FILE = "byrut.json";
const CACHE_DIR = ".cache";
const CACHE_FILE = path.join(CACHE_DIR, "downloads.json");

// Лимиты вежливости: сайт не наш, не долбим его запросами
const PAGE_DELAY_MS = 1500; // пауза между страницами
const TORRENT_DELAY_MS = 700; // пауза между скачиванием .torrent
const MAX_TORRENT_RETRIES = 2;

// Хостеры облаков, которые Hydra умеет качать напрямую (см. getDownloadersForUri
// в исходниках Hydra: gofile, pixeldrain, datanodes, mediafire, fuckingfast,
// vikingfile, rootz, archive.org + magnet). Всё остальное из блока
// «Альтернативные раздачи» (Buzzheavier, MixDrop, Google Drive и пр.)
// отфильтровываем: Hydra отбрасывает релиз целиком при неподдерживаемой ссылке.
const SUPPORTED_CLOUD_HOSTS = ["pixeldrain.com", "gofile.io", "datanodes.to", "www.mediafire.com", "fuckingfast.co", "vikingfile.com", "www.rootz.so"];

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const ALL = args.includes("--all");
const CHECK_UPDATES = args.includes("--check-updates");
const limitArgIdx = args.indexOf("--limit");
const ALL_LIMIT = limitArgIdx !== -1 ? parseInt(args[limitArgIdx + 1], 10) || 0 : 0;
const updArgIdx = args.indexOf("--updates-limit");
const UPDATE_LIMIT = updArgIdx !== -1 ? parseInt(args[updArgIdx + 1], 10) || 0 : 0;
const REFRESH = args.includes("--refresh");
const pagesArgIdx = args.indexOf("--pages");
const MAX_PAGES = pagesArgIdx !== -1 ? parseInt(args[pagesArgIdx + 1], 10) || 3 : 3;
const timeLimitArgIdx = args.indexOf("--time-limit");
const TIME_LIMIT_MIN = timeLimitArgIdx !== -1 ? parseInt(args[timeLimitArgIdx + 1], 10) || 0 : 0;
const DEADLINE_MS = TIME_LIMIT_MIN * 60000;
const STARTED_AT = Date.now();
let deadlineReported = false;

function timeExceeded() {
  if (DEADLINE_MS <= 0 || Date.now() - STARTED_AT < DEADLINE_MS) return false;
  if (!deadlineReported) {
    console.log(`[time] лимит ${TIME_LIMIT_MIN} мин достигнут, сохраняем результаты и останавливаемся`);
    deadlineReported = true;
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch с браузерным UA и таймаутом */
async function fetchText(url, { encoding = "utf-8", timeout = 30000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer()).toString(encoding);
  } finally {
    clearTimeout(t);
  }
}

/**
 * bencode-декодер + поиск info-словаря.
 * Не нужен полноценный парсер: достаточно найти ключ "4:info" и
 * прочитать ровно один bencode-объект с этой позиции.
 */
function decodeBencodeAt(buf, offset) {
  // Возвращает [значение, следующаяПозиция]
  const c = buf[offset];
  if (c === 0x64) {
    // 'd' — словарь
    const dict = {};
    let pos = offset + 1;
    while (buf[pos] !== 0x65) {
      const [key, nextPos] = decodeBencodeAt(buf, pos);
      const [val, afterVal] = decodeBencodeAt(buf, nextPos);
      dict[key.toString("latin1")] = val;
      pos = afterVal;
    }
    return [dict, pos + 1];
  }
  if (c === 0x6c) {
    // 'l' — список
    const list = [];
    let pos = offset + 1;
    while (buf[pos] !== 0x65) {
      const [val, nextPos] = decodeBencodeAt(buf, pos);
      list.push(val);
      pos = nextPos;
    }
    return [list, pos + 1];
  }
  if (c === 0x69) {
    // 'i' — число
    const end = buf.indexOf(0x65, offset);
    return [parseInt(buf.slice(offset + 1, end).toString(), 10), end + 1];
  }
  // строка: <длина>:<байты>
  const colon = buf.indexOf(0x3a, offset);
  const len = parseInt(buf.slice(offset, colon).toString(), 10);
  const start = colon + 1;
  return [buf.slice(start, start + len), start + len];
}

/** infohash v1 из .torrent (sha1 от bencode-словаря info) */
function computeInfohash(buf) {
  const colon = buf.indexOf(Buffer.from("4:info"));
  if (colon === -1) return null;
  const infoStart = colon + "4:info".length;
  try {
    const [, infoEnd] = decodeBencodeAt(buf, infoStart);
    return createHash("sha1").update(buf.subarray(infoStart, infoEnd)).digest("hex");
  } catch {
    return null;
  }
}

/** Вытащить список ссылок на страницы-игры со страницы новостей */
function extractGameLinks(html) {
  const links = new Set();
  // Ссылки вида https://byrutgame.org/1234-game-name.html
  const re = /https?:\/\/byrutgame\.org\/(\d+)-[a-z0-9-]+\.html/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.add(m[0]);
  }
  return [...links];
}

/** Вытащить заголовок игры из страницы */
function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  // "Название торрент на ПК (последняя версия X.Y)" -> чистим мусор
  return m[1]
    .replace(/торрент\s*на\s*ПК/gi, "")
    .replace(/\s*\(последняя версия[^)]*\)\s*/gi, " ")
    .replace(/\s*\(последняя\)\s*/gi, " ")
    .replace(/^(скачать)\s*/i, "")
    .replace(/\s*на ПК торрент.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([:!?,.;])/g, "$1")
    .trim();
}

/** Ссылка на скачивание .torrent со страницы игры */
function extractTorrentLink(html, pageUrl) {
  // Приоритет: кнопка «Скачать торрент» с download-атрибутом
  let m = html.match(/<a[^>]+class="itemtop_games"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]+class="itemtop_games"/i);
  if (!m) m = html.match(/<a[^>]+href="(https?:\/\/byrutgame\.org\/index\.php\?do=download&id=\d+)"/i);
  if (!m) return null;
  return new URL(m[1], pageUrl).href;
}

/**
 * Облачные ссылки из блока «Альтернативные раздачи» (файловое хранилище).
 *
 * На сайте блок data-ajax="features_storage" подгружается скриптом:
 *   POST engine/ajax/controller.php?mod=ajaxsp  c  block=features_storage&id=<newsId>
 * Ответ — HTML со ссылками вида <a link="https://...">Pixeldrain</a>
 * (атрибут link, не href). Оставляем только хостеров из SUPPORTED_CLOUD_HOSTS.
 */
function extractNewsId(pageUrl, html) {
  let m = html.match(/data-news-id="(\d+)"/i);
  if (m) return m[1];
  m = pageUrl.match(/\/(\d+)-[a-z0-9-]+\.html/i);
  return m ? m[1] : null;
}

async function fetchStorageLinks(pageUrl, newsId) {
  if (!newsId) return [];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${BASE}/engine/ajax/controller.php?mod=ajaxsp`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: pageUrl,
      },
      body: `block=features_storage&id=${newsId}`,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return [];
    const html = await res.text();
    const links = [...html.matchAll(/<a[^>]+link="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
    const supported = [];
    for (const url of links) {
      try {
        const host = new URL(url).hostname;
        if (SUPPORTED_CLOUD_HOSTS.includes(host)) supported.push(url);
        else console.log(`    [storage] пропуск неподдерживаемого Hydra хостера: ${host}`);
      } catch { /* мусорная ссылка */ }
    }
    return supported;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Размер из data-size или текста страницы ("546 МБ", "12.5 ГБ") */
function extractSize(html) {
  const m =
    html.match(/data-size="([^"]+)"/i) ||
    html.match(/(\d+(?:[.,]\d+)?\s*(?:МБ|ГБ|КБ|MB|GB|KB))/i);
  if (!m) return null;
  // Нормализуем кириллические юниты к латинице, чтобы отпечаток был стабильным
  return m[1]
    .replace(",", ".")
    .replace(/\u0413\u0411/g, "GB") // ГБ -> GB
    .replace(/\u041c\u0411/g, "MB") // МБ -> MB
    .replace(/\u041a\u0411/g, "KB") // КБ -> KB
    .trim();
}

/** Дата публикации/обновления из страницы ("10 сен. 2026", "1 апреля 2021") */
const MONTHS = {
  "января": "01", "февраля": "02", "марта": "03", "апреля": "04",
  "мая": "05", "июня": "06", "июля": "07", "августа": "08",
  "сентября": "09", "октября": "10", "ноября": "11", "декабря": "12",
  "янв": "01", "фев": "02", "мар": "03", "апр": "04", "май": "05",
  "июн": "06", "июл": "07", "авг": "08", "сен": "09", "окт": "10",
  "ноя": "11", "дек": "12",
};
function extractDate(html) {
  const m = html.match(
    /(\d{1,2})\s+([а-я]+\.?)\s+(\d{4})(?:,)?\s*(\d{1,2}:\d{2})?/i
  );
  if (!m) return null;
  const month = MONTHS[m[2].replace(".", "").toLowerCase()];
  if (!month) return null;
  const day = m[1].padStart(2, "0");
  const time = m[4] || "00:00";
  return `${m[3]}-${month}-${day} ${time}`;
}

async function downloadTorrent(url) {
  for (let attempt = 0; attempt <= MAX_TORRENT_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Referer: BASE + "/" },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Проверяем что это действительно bencode (начинается с d...e или цифры)
      const first = buf[0];
      if (buf.length < 50 || (first !== 0x64 && !(first >= 0x30 && first <= 0x39))) {
        throw new Error("not a torrent file");
      }
      return buf;
    } catch (e) {
      if (attempt === MAX_TORRENT_RETRIES) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Все страницы игр из sitemap'ов сайта (news_pages.xml + news_pages2.xml) */
async function loadSitemapGameUrls() {
  const urls = new Set();
  for (const sm of ["news_pages.xml", "news_pages2.xml"]) {
    process.stdout.write(`sitemap ${sm}... `);
    try {
      const xml = await fetchText(`${BASE}/${sm}`, { timeout: 120000 });
      const found = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
      const games = found.filter((u) => /\/\d+-[a-z0-9-]+\.html$/i.test(u));
      games.forEach((u) => urls.add(u));
      console.log(`+${games.length}`);
    } catch (e) {
      console.log(`ошибка: ${e.message}`);
    }
    await sleep(PAGE_DELAY_MS);
  }
  return [...urls];
}

/** Обработать одну страницу игры: скачал -> infohash -> magnet -> в кэш. Возвращает true если новая. */
async function processGamePage(link, cache, entries) {
  const alreadyHave = Boolean(cache[link]?.uris?.length);

  // В режиме --all кэшированные игры пропускаем мгновенно: их целостность
  // (актуальность magnet) проверяет отдельный цикл --check-updates.
  if (alreadyHave && ALL && !FULL) {
    entries.set(link, cache[link]);
    return false; // уже есть
  }

  // Обычный/news-режим: страницу всё равно читаем — она свежая; для кэшированной
  // игры это заодно проверка обновления (отпечаток ниже).
  await sleep(PAGE_DELAY_MS);
  let gameHtml;
  try {
    gameHtml = await fetchText(link);
  } catch (e) {
    console.warn(`  ${link}: ${e.message}`);
    return false;
  }

  const title = extractTitle(gameHtml);
  if (!title) return false;

  const uploadDate = extractDate(gameHtml) || cache[link]?.uploadDate || "";
  const fileSize = extractSize(gameHtml) || cache[link]?.fileSize || "";

  const cached = cache[link];

  // ===== Облачные ссылки «Альтернативных раздач» =====
  // Файлохранилище есть не у всех игр — внешний AJAX-запрос делаем только если
  // в разметке есть блок data-ajax="features_storage" (у остальных — 0 запросов,
  // поведение и скорость для обычных торрентов не меняются).
  let storageUris = [];
  if (/data-ajax="features_storage"/i.test(gameHtml)) {
    const newsId = extractNewsId(link, gameHtml);
    storageUris = await fetchStorageLinks(link, newsId);
  }

  // ===== Проверка обновления у уже известной игры =====
  if (cached?.uris?.length) {
    // Совместимость со старым кэшем: пустой список облаков не меняет отпечаток
    // (иначе после деплоя все старые игры были бы «обновлёнными»)
    const storagePart = (storageUris.length || cached._storageUris?.length) ? storageUris.join(",") : "";
    const fingerprint = `${fileSize}|${uploadDate}|${title}|${storagePart}`;
    const cachedStoragePart = (storageUris.length || cached._storageUris?.length) ? (cached._storageUris || []).join(",") : "";
    const cachedFingerprint = `${cached.fileSize}|${cached.uploadDate}|${cached.title}|${cachedStoragePart}`;
    if (fingerprint === cachedFingerprint) {
      // Ничего не изменилось
      entries.set(link, { ...cached, title, uploadDate, fileSize });
      return false;
    }

    if (!REFRESH) {
      // Изменение заметили, но перекачивать не разрешено — просто фиксируем метаданные
      entries.set(link, { ...cached, title, uploadDate, fileSize });
      cache[link] = entries.get(link);
      return false;
    }

    console.log(`  ~ ${title}: обновление на сайте (${cached.fileSize} -> ${fileSize}), перекачиваем ссылки...`);
    updatedTorrents++;
    // дальше — общий путь: скачиваем .torrent и/или облако, перезаписываем uris
  }

  const uris = [...storageUris];

  const torrentUrl = extractTorrentLink(gameHtml, link);
  if (torrentUrl) {
    await sleep(TORRENT_DELAY_MS);
    let buf;
    try {
      buf = await downloadTorrent(torrentUrl);
    } catch (e) {
      buf = null;
      console.warn(`  ${title}: .torrent не скачался (${e.message})`);
    }
    if (buf) {
      const infohash = computeInfohash(buf);
      if (!infohash) {
        console.warn(`  ${title}: не удалось вычислить infohash`);
      } else {
        uris.push(`magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title)}&tr=${encodeURIComponent("udp://opentor.org:2710")}&tr=${encodeURIComponent("udp://tracker.opentrackr.org:1337/announce")}&tr=${encodeURIComponent("udp://open.demonii.com:1337/announce")}&tr=${encodeURIComponent("udp://tracker.torrent.eu.org:451/announce")}&tr=${encodeURIComponent("udp://exodus.desync.com:6969/announce")}`);
      }
    }
  }

  if (!uris.length) {
    console.warn(`  ${title}: не найдено ни торрента, ни поддерживаемых облаков (пропуск)`);
    return false;
  }

  const entry = {
    title,
    uris,
    uploadDate,
    fileSize,
    _torrentUrl: torrentUrl || null, // внутреннее поле, удаляется перед записью
    _storageUris: storageUris, // внутреннее поле, удаляется перед записью
  };
  entries.set(link, entry);
  cache[link] = entry;
  if (cached?.uris?.length) {
    console.log(`  ~ ${title}: ссылки обновлены (${uris.length} шт.)`);
  } else {
    console.log(`  + ${title} [${uris.length === 1 && uris[0].startsWith("magnet:") ? uris[0].slice(23, 63) : uris.join(" | ")}]`);
  }
  return !cached?.uris?.length; // новая = true, обновление = false
}

let updatedTorrents = 0; // счётчик обновлённых magnet'ов (растёт при перекачке)

async function main() {
  const cache = await loadCache(); // { pageUrl: { title, uris, uploadDate, fileSize } }
  const entries = new Map();
  for (const [url, data] of Object.entries(cache)) {
    entries.set(url, data);
  }

  let pagesRead = 0;
  let newTorrents = 0;
  let skippedByCache = 0;

  if (ALL) {
    // ===== Режим --all: весь сайт через sitemap =====
    // Стратегия «сначала новые»: кэшированные пропускаются мгновенно,
    // поэтому за каждый запуск успеваем обработать BATCH игр из начала очереди.
    const gameUrls = await loadSitemapGameUrls();
    const uncachedCount = gameUrls.filter((u) => !cache[u]?.uris?.length || FULL).length;
    const batch = ALL_LIMIT > 0 ? Math.min(ALL_LIMIT, gameUrls.length) : gameUrls.length;
    console.log(`Режим --all: игр в sitemap: ${gameUrls.length}, без кэша: ${uncachedCount}, лимит за запуск: ${batch}`);
    console.log(
      `Оценка времени на новые игры: ~${Math.ceil((Math.min(batch, uncachedCount) * (PAGE_DELAY_MS + TORRENT_DELAY_MS)) / 3600000)} ч\n`
    );
    let done = 0;
    let processed = 0;
    for (const link of gameUrls) {
      // Ограничиваем работу за запуск: считаем только реально обработанные,
      // кэшированные пропускаем бесплатно и не тратим лимит
      if (ALL_LIMIT > 0 && processed >= ALL_LIMIT) {
        console.log(`[--all] лимит ${ALL_LIMIT} новых игр за запуск достигнут, останавливаемся`);
        break;
      }
      if (timeExceeded()) break;
      done++;
      if (done % 50 === 0) {
        console.log(`[--all] прогресс: ${done}/${gameUrls.length} (новых: ${newTorrents})`);
        // Периодически сохраняем кэш, чтобы прогресс не терялся при падении
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        const isNew = await processGamePage(link, cache, entries);
        if (isNew) {
          newTorrents++;
          processed++;
        } else {
          skippedByCache++;
        }
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
  }

  // ===== Обычный режим: страницы новостей =====
  if (!ALL && !CHECK_UPDATES) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (timeExceeded()) break;
    const pageUrl = page === 1 ? BASE + "/" : `${BASE}/page/${page}/`;
    console.log(`[page ${page}] ${pageUrl}`);
    let html;
    try {
      html = await fetchText(pageUrl);
    } catch (e) {
      console.warn(`  не удалось загрузить: ${e.message}`);
      if (page === 1) process.exit(1); // без главной делать нечего
      break; // вероятно, страницы кончились
    }
    pagesRead++;

    const gameLinks = extractGameLinks(html);
    console.log(`  найдено игр: ${gameLinks.length}`);

    for (const link of gameLinks) {
      if (timeExceeded()) break;
      if (!FULL && cache[link]?.uris?.length) {
        // Уже есть в кэше — берём без повторного скачивания
        entries.set(link, cache[link]);
        skippedByCache++;
        continue;
      }

      const isNew = await processGamePage(link, cache, entries);
      if (isNew) newTorrents++;
    }
  }
  } // end if (!ALL)

  // ===== Проверка обновлений (--check-updates): читаем страницы у кэшированных
  // игр, сравниваем отпечаток (размер|дата|название), при изменении перекачиваем
  // torrent и обновляем magnet. Обрабатываем порцию в начале списка (от свежих к
  // старым), чтобы лимит/таймаут не мешали регулярности проверки.
  if (CHECK_UPDATES) {
    const gameUrls = await loadSitemapGameUrls();
    // только игры, которые уже в кэше
    const cachedUrls = gameUrls.filter((u) => cache[u]?.uris?.length);
    const slice = UPDATE_LIMIT > 0 ? cachedUrls.slice(0, UPDATE_LIMIT) : cachedUrls;
    console.log(`\n[check-updates] игр в кэше: ${cachedUrls.length}, проверяем за запуск: ${slice.length}`);

    let checked = 0;
    let changed = 0;
    for (const link of slice) {
      if (timeExceeded()) break;
      checked++;
      if (checked % 50 === 0) {
        console.log(`[check-updates] прогресс: ${checked}/${slice.length} (обновлено: ${updatedTorrents})`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        await processGamePage(link, cache, entries);
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
    changed = updatedTorrents;
    console.log(`[check-updates] проверено: ${checked}, обновлено: ${changed}`);
  }

  // Собираем итоговый JSON (внутренние поля кэша вычищаем)
  const downloads = [...entries.values()]
    .map(({ _torrentUrl, _storageUris, ...rest }) => rest)
    .filter((d) => d.uris?.length)
    .sort((a, b) => (b.uploadDate || "").localeCompare(a.uploadDate || ""));

  const json = {
    name: "ByrutGame",
    downloads,
  };

  await writeFile(OUT_FILE, JSON.stringify(json, null, 2), "utf-8");
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");

  console.log(
    `\nГотово. Страниц прочитано: ${pagesRead}. В кэше: ${skippedByCache}. Новых торрентов: ${newTorrents}.`
  );
  console.log(`Записей в итоговом файле: ${downloads.length} -> ${OUT_FILE}`);
}

// Запуск только при прямом вызове (не при импорте из тестов)
const isMain = process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("scrape.mjs"));
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { extractNewsId, fetchStorageLinks, extractTorrentLink, extractTitle, extractSize, extractDate, computeInfohash };
