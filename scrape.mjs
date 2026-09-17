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
 *   node scrape.mjs --all           # ВЕСЬ сайт через sitemap (~55к игр; несколько дней работы!)
 *   node scrape.mjs --all --limit 500  # первые 500 игр из sitemap (для теста/дозаливки)
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

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const ALL = args.includes("--all");
const limitArgIdx = args.indexOf("--limit");
const ALL_LIMIT = limitArgIdx !== -1 ? parseInt(args[limitArgIdx + 1], 10) || 0 : 0;
const pagesArgIdx = args.indexOf("--pages");
const MAX_PAGES = pagesArgIdx !== -1 ? parseInt(args[pagesArgIdx + 1], 10) || 3 : 3;

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

/** Размер из data-size или текста страницы ("546 МБ", "12.5 ГБ") */
function extractSize(html) {
  const m =
    html.match(/data-size="([^"]+)"/i) ||
    html.match(/(\d+(?:[.,]\d+)?\s*(?:МБ|ГБ|КБ|MB|GB|KB))/i);
  return m ? m[1].replace(",", ".") : null;
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
  if (cache[link]?.uris?.length && !FULL) {
    entries.set(link, cache[link]);
    return false; // уже есть
  }

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

  // Если игра уже в кэше, но страница загрузилась — обновим дату/размер, magnet не трогаем
  const cached = cache[link];
  const uploadDate = extractDate(gameHtml) || cached?.uploadDate || "";
  const fileSize = extractSize(gameHtml) || cached?.fileSize || "";

  if (cached?.uris?.length) {
    entries.set(link, { ...cached, title, uploadDate, fileSize });
    cache[link] = entries.get(link);
    return false;
  }

  const torrentUrl = extractTorrentLink(gameHtml, link);
  if (!torrentUrl) {
    console.warn(`  ${title}: не найдена ссылка на .torrent (пропуск)`);
    return false;
  }

  await sleep(TORRENT_DELAY_MS);
  let buf;
  try {
    buf = await downloadTorrent(torrentUrl);
  } catch (e) {
    console.warn(`  ${title}: .torrent не скачался (${e.message})`);
    return false;
  }
  const infohash = computeInfohash(buf);
  if (!infohash) {
    console.warn(`  ${title}: не удалось вычислить infohash`);
    return false;
  }

  const magnet = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title)}&tr=${encodeURIComponent("udp://opentor.org:2710")}&tr=${encodeURIComponent("udp://tracker.opentrackr.org:1337/announce")}&tr=${encodeURIComponent("udp://open.demonii.com:1337/announce")}&tr=${encodeURIComponent("udp://tracker.torrent.eu.org:451/announce")}&tr=${encodeURIComponent("udp://exodus.desync.com:6969/announce")}`;

  const entry = {
    title,
    uris: [magnet],
    uploadDate,
    fileSize,
    _torrentUrl: torrentUrl, // внутреннее поле, удаляется перед записью
  };
  entries.set(link, entry);
  cache[link] = entry;
  console.log(`  + ${title} [${infohash}]`);
  return true;
}

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
    const gameUrls = await loadSitemapGameUrls();
    const queue = ALL_LIMIT > 0 ? gameUrls.slice(0, ALL_LIMIT) : gameUrls;
    console.log(`Режим --all: игр в очереди: ${queue.length}`);
    console.log(
      `Оценка времени: ~${Math.ceil((queue.length * (PAGE_DELAY_MS + TORRENT_DELAY_MS)) / 3600000)} ч (новых); кэшированные проходят мгновенно.\n`
    );
    let done = 0;
    for (const link of queue) {
      done++;
      if (done % 50 === 0) {
        console.log(`[--all] прогресс: ${done}/${queue.length}`);
        // Периодически сохраняем кэш, чтобы прогресс не терялся при падении
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        const isNew = await processGamePage(link, cache, entries);
        if (isNew) newTorrents++;
        else skippedByCache++;
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
  } else {
  // ===== Обычный режим: страницы новостей =====
  for (let page = 1; page <= MAX_PAGES; page++) {
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
      if (!FULL && cache[link]) {
        // Уже есть в кэше — берём без повторного скачивания
        entries.set(link, cache[link]);
        skippedByCache++;
        continue;
      }

      const isNew = await processGamePage(link, cache, entries);
      if (isNew) newTorrents++;
    }
  }
  }

  // Собираем итоговый JSON
  const downloads = [...entries.values()]
    .map(({ _torrentUrl, ...rest }) => rest)
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
