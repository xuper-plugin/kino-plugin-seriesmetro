// src/util/lang.js
function normLang(text) {
  const s = String(text || "").toLowerCase();
  if (/\b(sub|subs|vose|subtitulado|subtitulada)\b/.test(s)) return "sub";
  if (/\b(lat|latino|latam|mx|mex|col|es-mx)\b/.test(s)) return "lat";
  if (/\b(cast|castellano|esp|español|espanol|es-es|spain)\b/.test(s)) return "esp";
  if (/(?:^|[^a-z0-9ñ])(españa|espana)(?:$|[^a-z0-9ñ])/.test(s)) return "esp";
  return null;
}

// src/util/slug.js
function slugify(title) {
  return String(title || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// src/seriesmetro.js
var SITE = "https://www3.seriesmetro.net";
var MAX_OPTIONS = 8;
var AT_ONCE = 3;
var MAX_PROBES = 4;
function titleSlugs(titles) {
  const out = [];
  for (const t2 of [titles && titles.esMX, titles && titles.esES, titles && titles.original, titles && titles.en]) {
    const s = slugify(t2);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
function yearMatches(found, wanted) {
  if (!wanted || !found) return true;
  return Math.abs(Number(found) - Number(wanted)) <= 1;
}
function episodeYearOk(found, show) {
  if (!show || !show.year || found == null) return true;
  const first = Number(show.year);
  const last = Number(show.lastYear) || (/* @__PURE__ */ new Date()).getFullYear();
  const y = Number(found);
  return y >= first - 1 && y <= Math.max(first, last) + 1;
}
var yearOnPage = (html) => {
  const m = /<span class="year[^"]*fa-calendar[^"]*">(\d{4})<\/span>/.exec(html);
  return m ? Number(m[1]) : null;
};
var accepted = (html, title, episode = false) => {
  const found = yearOnPage(html);
  if (found == null) return !title.year;
  return episode ? episodeYearOk(found, title) : yearMatches(found, title.year);
};
function options(html) {
  const labels = {};
  for (const m of html.matchAll(/href="#options-(\d+)"[\s\S]*?<span class="server">([\s\S]*?)<\/span>/g)) labels[m[1]] = m[2].replace(/\s+/g, " ").trim();
  const out = [];
  for (const m of html.matchAll(/<div id="options-(\d+)"[\s\S]*?<iframe[^>]*?(?:data-src|src)="([^"]*trembed=[^"]*)"/g)) {
    const url = m[2].replace(/&#0?38;|&amp;/g, "&");
    if (url.startsWith(SITE + "/") && labels[m[1]] != null) out.push({ url, label: labels[m[1]] });
  }
  return out;
}
var splitLabel = (label) => {
  const i = label.lastIndexOf("-");
  return i < 0 ? { server: "", lang: label } : { server: label.slice(0, i).trim(), lang: label.slice(i + 1).trim() };
};
async function embedRows(page, req) {
  const opts = options(page).slice(0, MAX_OPTIONS);
  const failures = [];
  const one = async (o) => {
    try {
      const r = await req(o.url, { headers: { Referer: SITE + "/" } });
      if (!r.ok) return null;
      const m = /<iframe[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/i.exec(r.text());
      return m ? { url: m[1], ...splitLabel(o.label) } : null;
    } catch (e) {
      if (e && e.code === "timeout") return null;
      failures.push(e);
      return null;
    }
  };
  const rows = [];
  for (let i = 0; i < opts.length; i += AT_ONCE) rows.push(...await Promise.all(opts.slice(i, i + AT_ONCE).map(one)));
  const ok = rows.filter(Boolean);
  if (!ok.length && opts.length && failures.length === opts.length) throw failures[0];
  return ok;
}
async function firstHit(candidates, probe) {
  for (const c of candidates.slice(0, MAX_PROBES)) {
    try {
      const hit = await probe(c);
      if (hit) return hit;
    } catch (e) {
      if (e && e.code === "timeout") return null;
      throw e;
    }
  }
  return null;
}
async function movieHit(title, req) {
  return firstHit(titleSlugs(title.titles), async (slug) => {
    const r = await req(`${SITE}/pelicula/${slug}/`);
    if (!r.ok) return null;
    const html = r.text();
    return html.includes("trembed=") && accepted(html, title) ? html : null;
  });
}
async function episodeHit(title, req) {
  return firstHit(titleSlugs(title.titles), async (slug) => {
    const r = await req(`${SITE}/serie/${slug}/`);
    if (!r.ok) return null;
    const post = /data-post="(\d+)"/.exec(r.text());
    if (!post) return null;
    const list = await req(`${SITE}/wp-admin/admin-ajax.php`, {
      method: "POST",
      headers: { Referer: `${SITE}/serie/${slug}/` },
      body: { form: { action: "action_select_season", season: String(title.season), post: post[1] } }
    });
    if (!list.ok) return null;
    const wantS = Number(title.season), wantE = Number(title.episode);
    let href = null;
    for (const m of list.text().matchAll(/href="([^"]+\/capitulo\/[^"]+)"/g)) {
      const n = /temporada-(\d+)-capitulo-(\d+)/i.exec(m[1]);
      if (n && Number(n[1]) === wantS && Number(n[2]) === wantE) {
        href = m[1];
        break;
      }
    }
    if (!href) return null;
    const ep = await req(href, { headers: { Referer: `${SITE}/serie/${slug}/` } });
    if (!ep.ok) return null;
    const html = ep.text();
    return html.includes("trembed=") && accepted(html, title, true) ? html : null;
  });
}
function serverOf(url) {
  try {
    return new URL(url).hostname.replace(/^www./, "").split(".")[0].toLowerCase().replace(/[^a-z]/g, "").slice(0, 30);
  } catch (_) {
    return "";
  }
}
async function listCopies(title, { req }) {
  const tv = title.kind === "tv";
  if (tv && (title.season == null || title.episode == null)) return [];
  let page;
  try {
    page = await (tv ? episodeHit(title, req) : movieHit(title, req));
  } catch (e) {
    if (e && e.code === "timeout") return [];
    throw e;
  }
  if (!page) return [];
  const out = [];
  for (const row of await embedRows(page, req)) {
    const lang = normLang(row.lang);
    const server = serverOf(row.url);
    if (lang && server && !out.some((c) => c.embedUrl === row.url)) out.push({ lang, server, embedUrl: row.url });
  }
  return out;
}

// src/util/http.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var REQUEST_MS = 8e3;
var MIN_MS = 1500;
function makeReq(kino2, { deadline }) {
  const req = async (url, opts = {}) => {
    const left = deadline - Date.now();
    if (left < MIN_MS) throw kino2.error("timeout", "no time left for " + new URL(url).hostname);
    return kino2.fetch(url, { headers: { "User-Agent": UA, ...opts.headers || {} }, method: opts.method, body: opts.body, timeoutMs: Math.min(REQUEST_MS, left) });
  };
  req.left = () => Math.max(0, deadline - Date.now());
  return req;
}

// src/plugin.js
globalThis.__kinoDropPendingFetches = true;
if (typeof kino.meta !== "function") throw kino.error("unavailable", "kino.meta not available");
if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "kino.tmdb not available");
var TMDB_IMG = "https://image.tmdb.org/t/p/";
var DAY_MS = 24 * 60 * 60 * 1e3;
var RESOLVE_MS = 4e4;
var MAX_COPIES = 8;
var STRINGS = {
  es: {
    unavailable: "El servicio no est\xE1 disponible en este momento.",
    noStreams: "No se encontraron fuentes para este t\xEDtulo.",
    needResolver: "Para reproducir, instala el motor de reproducci\xF3n desde la tienda de plugins (es gratis).",
    noMeta: "No se encontr\xF3 informaci\xF3n de este t\xEDtulo.",
    trendingMovies: "Pel\xEDculas populares",
    trendingSeries: "Series populares",
    nowPlaying: "En cines ahora",
    upcoming: "Pr\xF3ximos estrenos",
    topMovies: "Pel\xEDculas mejor valoradas",
    onTheAir: "Series en emisi\xF3n",
    topSeries: "Series mejor valoradas",
    kids: "Para los ni\xF1os",
    docs: "Documentales",
    anime: "Anime",
    gAction: "Acci\xF3n",
    gComedy: "Comedia",
    gSciFi: "Ciencia ficci\xF3n",
    gHorror: "Terror",
    gDrama: "Drama",
    cacheCleared: "Cach\xE9 de t\xEDtulos vaciada.",
    lat: "Latino",
    esp: "Castellano",
    sub: "Subtitulado"
  },
  en: {
    unavailable: "The service is not available right now.",
    noStreams: "No streams found for this title.",
    needResolver: "To play, install the playback engine from the plugin store (it is free).",
    noMeta: "No metadata found for this title.",
    trendingMovies: "Trending movies",
    trendingSeries: "Trending series",
    nowPlaying: "In theaters now",
    upcoming: "Coming soon",
    topMovies: "Top rated movies",
    onTheAir: "Series on the air",
    topSeries: "Top rated series",
    kids: "For kids",
    docs: "Documentaries",
    anime: "Anime",
    gAction: "Action",
    gComedy: "Comedy",
    gSciFi: "Science fiction",
    gHorror: "Horror",
    gDrama: "Drama",
    cacheCleared: "Title cache cleared.",
    lat: "Latin",
    esp: "Castilian",
    sub: "Subtitled"
  }
};
function t(key) {
  const lang = String(kino.lang || "es").startsWith("en") ? "en" : "es";
  return (STRINGS[lang] || STRINGS.es)[key] || key;
}
var TMDB_GENRES = {
  28: "Acci\xF3n",
  12: "Aventura",
  16: "Animaci\xF3n",
  35: "Comedia",
  80: "Crimen",
  99: "Documentales",
  18: "Drama",
  10751: "Familia",
  14: "Fantas\xEDa",
  36: "Historia",
  27: "Terror",
  9648: "Misterio",
  10749: "Romance",
  878: "Ciencia ficci\xF3n",
  53: "Suspenso",
  10752: "B\xE9lica",
  37: "Western",
  10759: "Acci\xF3n",
  10765: "Ciencia ficci\xF3n",
  10766: "Drama",
  10764: "Reality",
  10768: "B\xE9lica"
};
function genresOf(raw) {
  const names = /* @__PURE__ */ new Set();
  for (const id of Array.isArray(raw.genre_ids) ? raw.genre_ids : []) if (TMDB_GENRES[id]) names.add(TMDB_GENRES[id]);
  return [...names].slice(0, 5);
}
function itemFromTmdb(raw, kind) {
  const isMovie = kind === "movie";
  const tmdbId = raw.id;
  return {
    id: (isMovie ? "m" : "s") + tmdbId,
    ref: (isMovie ? "m:" : "s:") + tmdbId,
    title: String(raw.title || raw.name || ""),
    kind: isMovie ? "movie" : "series",
    year: (raw.release_date || raw.first_air_date || "").slice(0, 4) || void 0,
    poster: raw.poster_path ? TMDB_IMG + "w500" + raw.poster_path : void 0,
    backdrop: raw.backdrop_path ? TMDB_IMG + "w1280" + raw.backdrop_path : void 0,
    overview: raw.overview || void 0,
    rating: raw.vote_average > 0 ? Math.round(raw.vote_average * 10) / 10 : void 0,
    ids: { tmdb: tmdbId },
    genres: genresOf(raw).length ? genresOf(raw) : void 0
  };
}
var titlesOf = (query) => [query.q, query.originalTitle, ...query.altTitles || []].filter(Boolean);
var HOME_ROWS = [
  { id: "trending-movies", title: "trendingMovies", genre: "peliculas", ref: "trend:movie", kind: "movie", path: "/trending/movie/week" },
  { id: "now-playing", title: "nowPlaying", genre: "peliculas", ref: "list:movie:now_playing", kind: "movie", path: "/movie/now_playing" },
  { id: "upcoming", title: "upcoming", genre: "peliculas", ref: "list:movie:upcoming", kind: "movie", path: "/movie/upcoming" },
  { id: "top-movies", title: "topMovies", genre: "peliculas", ref: "list:movie:top_rated", kind: "movie", path: "/movie/top_rated" },
  { id: "trending-series", title: "trendingSeries", genre: "series", ref: "trend:tv", kind: "tv", path: "/trending/tv/week" },
  { id: "on-the-air", title: "onTheAir", genre: "series", ref: "list:tv:on_the_air", kind: "tv", path: "/tv/on_the_air" },
  { id: "top-series", title: "topSeries", genre: "series", ref: "list:tv:top_rated", kind: "tv", path: "/tv/top_rated" },
  { id: "g-action", title: "gAction", genre: "peliculas", ref: "genre:movie:28", kind: "movie", path: "/discover/movie", params: { with_genres: 28 } },
  { id: "g-comedy", title: "gComedy", genre: "peliculas", ref: "genre:movie:35", kind: "movie", path: "/discover/movie", params: { with_genres: 35 } },
  { id: "g-scifi", title: "gSciFi", genre: "peliculas", ref: "genre:movie:878", kind: "movie", path: "/discover/movie", params: { with_genres: 878 } },
  { id: "g-horror", title: "gHorror", genre: "peliculas", ref: "genre:movie:27", kind: "movie", path: "/discover/movie", params: { with_genres: 27 } },
  { id: "g-drama", title: "gDrama", genre: "peliculas", ref: "genre:movie:18", kind: "movie", path: "/discover/movie", params: { with_genres: 18 } },
  { id: "kids", title: "kids", genre: "infantil", ref: "genre:movie:10751", kind: "movie", path: "/discover/movie", params: { with_genres: 10751 } },
  { id: "docs", title: "docs", genre: "documentales", ref: "genre:movie:99", kind: "movie", path: "/discover/movie", params: { with_genres: 99 } },
  { id: "anime", title: "anime", genre: "anime", ref: "anime:tv", kind: "tv", path: "/discover/tv", params: { with_genres: 16, with_origin_country: "JP" } }
];
var DISCOVER = { sort_by: "popularity.desc", "vote_count.gte": 200 };
async function homeRow(row) {
  const res = await kino.tmdb(row.path, { ...row.path.startsWith("/discover") ? DISCOVER : {}, ...row.params || {} });
  const items = (res?.results || []).filter((r) => r.poster_path).slice(0, 20).map((r) => itemFromTmdb(r, row.kind));
  return items.length ? { id: row.id, title: t(row.title), genre: row.genre, ref: row.ref, items } : null;
}
var HOME_BUDGET_MS = 14e3;
async function home() {
  const out = HOME_ROWS.map(() => null);
  let done = false;
  const all = Promise.all(HOME_ROWS.map((row, i) => homeRow(row).then((r) => {
    out[i] = r;
  }, () => {
  }))).then(() => {
    done = true;
  });
  const end = Date.now() + HOME_BUDGET_MS;
  while (!done && Date.now() < end) await Promise.race([all, kino.sleep(Math.min(250, Math.max(1, end - Date.now())))]);
  const rows = out.filter(Boolean);
  if (!rows.length) throw kino.error("unavailable", "no home row could be loaded", { userMessage: t("unavailable") });
  return rows;
}
async function search(query) {
  if (!String(query.q || "").trim()) return [];
  const type = query.type;
  if (type === "series") {
    const res = await kino.tmdb("/search/tv", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "tv")), titlesOf(query));
  }
  if (type === "movie") {
    const res = await kino.tmdb("/search/movie", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "movie")), titlesOf(query));
  }
  const [movies, tv] = await Promise.all([
    kino.tmdb("/search/movie", { query: query.q }),
    kino.tmdb("/search/tv", { query: query.q })
  ]);
  const all = [
    ...(movies?.results || []).map((r) => itemFromTmdb(r, "movie")),
    ...(tv?.results || []).map((r) => itemFromTmdb(r, "tv"))
  ];
  return kino.rank.sortBySimilarity(all, titlesOf(query));
}
async function browse(ref, cursor) {
  const page = cursor ? Number(cursor) : 1;
  let path, params = { page }, kind;
  const parts = String(ref).split(":");
  if (parts[0] === "trend" && (parts[1] === "movie" || parts[1] === "tv")) {
    kind = parts[1];
    path = `/trending/${kind}/week`;
  } else if (parts[0] === "list" && (parts[1] === "movie" || parts[1] === "tv") && /^[a-z_]+$/.test(parts[2] || "")) {
    kind = parts[1];
    path = `/${kind}/${parts[2]}`;
  } else if (parts[0] === "popular" && (parts[1] === "movie" || parts[1] === "tv")) {
    kind = parts[1];
    path = `/${kind}/popular`;
  } else if (parts[0] === "anime" && parts[1] === "tv") {
    kind = "tv";
    path = "/discover/tv";
    params = { ...DISCOVER, with_genres: 16, with_origin_country: "JP", page };
  } else if (parts[0] === "genre" && (parts[1] === "movie" || parts[1] === "tv") && /^\d+$/.test(parts[2] || "")) {
    kind = parts[1];
    path = `/discover/${kind}`;
    params = { ...DISCOVER, with_genres: parts[2], page };
  } else {
    return { items: [] };
  }
  const res = await kino.tmdb(path, params);
  const items = (res?.results || []).filter((r) => r.poster_path).map((r) => itemFromTmdb(r, kind));
  const next = res?.page < res?.total_pages ? String(page + 1) : void 0;
  return { items, next };
}
async function categories() {
  const [mg, tg] = await Promise.all([kino.tmdb("/genre/movie/list"), kino.tmdb("/genre/tv/list")]);
  const cats = [];
  for (const g of (mg?.genres || []).slice(0, 12)) cats.push({ id: "gm" + g.id, title: g.name, ref: "genre:movie:" + g.id });
  for (const g of (tg?.genres || []).slice(0, 8)) cats.push({ id: "gt" + g.id, title: g.name + " (series)", ref: "genre:tv:" + g.id });
  return cats.slice(0, 24);
}
async function episodes(ref) {
  const tmdbId = ref.startsWith("s:") ? ref.slice(2) : ref;
  const meta = await kino.meta({ type: "series", ids: { tmdb: Number(tmdbId) } });
  if (!meta) throw kino.error("not_found", "series not found: tmdb " + tmdbId, { userMessage: t("noMeta") });
  return {
    series: {
      title: meta.title,
      poster: meta.poster,
      backdrop: meta.backdrop,
      overview: meta.overview,
      genres: meta.genres,
      year: meta.year,
      ids: meta.ids,
      runtimeMinutes: meta.runtimeMinutes
    },
    episodes: (meta.episodes || []).map((ep) => ({
      season: ep.season,
      number: ep.number,
      // the TMDB id rides in the ref: resolve() needs the show's names and years to find its page on the site
      ref: "ep:" + tmdbId + ":" + ep.season + ":" + ep.number,
      title: ep.title,
      still: ep.still,
      overview: ep.overview,
      airDate: ep.airDate
    }))
  };
}
var SERVER_LABEL = { fastream: "Fastream" };
function languageOrder() {
  const pref = String(kino.config.get("language") || "lat");
  return pref === "esp" ? ["esp", "lat", "sub"] : pref === "sub" ? ["sub", "lat", "esp"] : ["lat", "esp", "sub"];
}
function ordered(copies) {
  const langs = languageOrder();
  return [...copies].sort((a, b) => langs.indexOf(a.lang) - langs.indexOf(b.lang));
}
var labelOf = (c) => `${t(c.lang)} \xB7 ${SERVER_LABEL[c.server] || c.server}`;
function parseRef(ref) {
  let m = /^m:(\d+)$/.exec(ref);
  if (m) return { kind: "movie", tmdbId: m[1] };
  m = /^ep:(\d+):(\d+):(\d+)$/.exec(ref);
  return m ? { kind: "tv", tmdbId: m[1], season: Number(m[2]), episode: Number(m[3]) } : null;
}
var copyRef = (w, c) => w.kind === "movie" ? `cp:m:${w.tmdbId}:${c.lang}:${c.server}` : `cp:ep:${w.tmdbId}:${w.season}:${w.episode}:${c.lang}:${c.server}`;
function parseCopyRef(ref) {
  let m = /^cp:m:(\d+):(lat|esp|sub):([a-z]+)$/.exec(ref);
  if (m) return { what: { kind: "movie", tmdbId: m[1] }, lang: m[2], server: m[3] };
  m = /^cp:ep:(\d+):(\d+):(\d+):(lat|esp|sub):([a-z]+)$/.exec(ref);
  return m ? { what: { kind: "tv", tmdbId: m[1], season: Number(m[2]), episode: Number(m[3]) }, lang: m[4], server: m[5] } : null;
}
async function titleOf(what) {
  const tv = what.kind === "tv";
  const key = (tv ? "show:" : "movie:") + what.tmdbId;
  let info = null;
  try {
    info = JSON.parse(kino.storage.get(key) || "null");
  } catch (_) {
    info = null;
  }
  if (!info || !info.titles) {
    const d = await kino.tmdb(`/${tv ? "tv" : "movie"}/${what.tmdbId}`, { language: "es-MX", append_to_response: "translations" });
    if (!d || !d.id) throw kino.error("not_found", "title not found: tmdb " + what.tmdbId, { userMessage: t("noMeta") });
    const translated = (country) => {
      const x = (d.translations?.translations || []).find((y) => y.iso_3166_1 === country)?.data;
      return (tv ? x?.name : x?.title) || "";
    };
    const year = (date) => Number(String(date || "").slice(0, 4)) || null;
    info = {
      titles: { esMX: (tv ? d.name : d.title) || "", esES: translated("ES"), original: (tv ? d.original_name : d.original_title) || (tv ? d.name : d.title) || "", en: translated("US") },
      year: year(tv ? d.first_air_date : d.release_date),
      lastYear: tv && !d.in_production ? year(d.last_air_date) : null
    };
    kino.storage.set(key, JSON.stringify(info), { ttlMs: 7 * DAY_MS });
  }
  return { ...info, kind: what.kind, season: what.season, episode: what.episode };
}
function toStream(s, c) {
  const out = { url: s.url, label: labelOf(c), headers: { "User-Agent": UA, ...s.headers && typeof s.headers === "object" ? s.headers : {} } };
  if (s.mime) out.mime = s.mime;
  const subs = Array.isArray(s.subtitles) ? s.subtitles.filter((x) => x && x.lang && x.url) : [];
  if (subs.length) out.subtitles = subs;
  if (Number.isFinite(s.durationMs) && s.durationMs > 0) out.durationMs = Math.round(s.durationMs);
  return out;
}
var HLS = "application/vnd.apple.mpegurl";
async function resolverInstalled() {
  try {
    await kino.plugins.call("resolver", "normalizeHost", { url: "https://probe.invalid/" });
    return true;
  } catch (e) {
    return (e && e.code) !== "provider_missing";
  }
}
async function answers(stream) {
  try {
    const r = await kino.fetch(stream.url, { headers: { ...stream.headers, Range: "bytes=0-2047" }, timeoutMs: 5e3, maxBytes: 2048 });
    if (r.status === 401 || r.status === 403) return true;
    if (!r.ok) return false;
    return !/\.m3u8(\?|$)/i.test(stream.url) || /^\s*#EXTM3U/.test(r.text() || "");
  } catch (e) {
    return !!(e && (e.code === "host_not_allowed" || e.code === "too_large"));
  }
}
async function open(c) {
  try {
    const res = await kino.plugins.call("resolver", "resolve", { url: c.embedUrl, referer: SITE + "/" });
    const st = (res && Array.isArray(res.streams) ? res.streams : []).find((x) => x && x.url);
    if (!st) {
      kino.log("[seriesmetro]", c.server, res && res.error || "no_stream");
      return null;
    }
    const headers = {};
    if (st.referer) headers.Referer = st.referer;
    if (Array.isArray(st.headers)) for (const h of st.headers) {
      if (h && h.name) headers[h.name] = String(h.value);
    }
    const stream = toStream({ url: st.url, headers, mime: st.kind === "hls" || /\.m3u8(\?|$)/i.test(st.url) ? HLS : /\.mp4(\?|$)/i.test(st.url) ? "video/mp4" : void 0, subtitles: res.subtitles }, c);
    return await answers(stream) ? stream : null;
  } catch (e) {
    kino.log("[seriesmetro]", c.server, e && e.code || "resolve_failed");
    return null;
  }
}
async function resolve(ref) {
  if (!await resolverInstalled()) throw kino.error("unavailable", "resolver missing", { userMessage: t("needResolver") });
  const req = makeReq(kino, { deadline: Date.now() + RESOLVE_MS });
  if (ref.startsWith("cp:")) {
    const want = parseCopyRef(ref);
    if (!want) throw kino.error("not_found", "bad copy ref");
    const copy = (await listCopies(await titleOf(want.what), { req })).find((c) => c.lang === want.lang && c.server === want.server);
    const stream = copy ? await open(copy) : null;
    if (!stream) throw kino.error("not_found", "copy not available: " + want.lang + "/" + want.server, { userMessage: t("noStreams") });
    return stream;
  }
  const what = parseRef(ref);
  if (!what) throw kino.error("not_found", "unknown ref: " + ref.slice(0, 40));
  const copies = ordered(await listCopies(await titleOf(what), { req }));
  if (!copies.length) throw kino.error("not_found", "no copies for tmdb " + what.tmdbId, { userMessage: t("noStreams") });
  let main = null;
  let tried = 0;
  for (const c of copies) {
    tried++;
    main = await open(c);
    if (main) break;
  }
  if (!main) throw kino.error("not_found", "no copy opened for tmdb " + what.tmdbId, { userMessage: t("noStreams") });
  const alternatives = copies.slice(tried).slice(0, MAX_COPIES).map((c) => ({ label: labelOf(c), ref: copyRef(what, c) }));
  return { ...main, ...alternatives.length ? { alternatives } : {} };
}
async function action(key) {
  if (key === "clearCache") {
    for (const k of kino.storage.keys()) {
      if (k.startsWith("show:") || k.startsWith("movie:")) kino.storage.remove(k);
    }
    return { message: t("cacheCleared") };
  }
}
export {
  action,
  browse,
  categories,
  episodes,
  home,
  resolve,
  search
};
