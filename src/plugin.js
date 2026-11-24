// @ts-check
// Kino plugin: SeriesMetro — movies and series in Latino, Castilian or subtitled, through www3.seriesmetro.net. The site has a page
// per movie and per episode with one player per language (Fastream); each is opened with its extractor and played as a stream.
// The catalog (home, search, browse, episodes) comes from TMDB through kino.tmdb, which needs no host.
//
// The same source the Latino plugin carries (src/sources/seriesmetro.js there); this one stands alone, with its own extractor.
//
// Declared hosts: the site and Fastream. `streamHosts: "any"` is for the CDN the player redirects to.

import { listCopies, SITE } from "./seriesmetro.js";
import { makeReq, UA } from "./util/http.js";
import { makeStandardScreen } from "./std/index.js";
import { LOGO, LOGO_ASPECT } from "./logo.js";
import { resolveViaHelper, resolverInstalled } from "./resolve-door.js";

/**
 * kino.tmdb in the person's language. Kino fills the language from the call's turn, and a call from the screen's timers has no
 * turn: TMDB then answered in English (the browse screen's hero read "On Halloween night…" on a Spanish Kino, Redmi 2026-11-22).
 */
const tmdb = (path, params = {}) => kino.tmdb(path, { language: String(kino.lang || "").toLowerCase().startsWith("en") ? "en-US" : "es-MX", ...params });

// Kino waits for every request a call left running before it delivers the call's answer; ask it to drop them once the call settles.
globalThis.__kinoDropPendingFetches = true;

// kino.meta and kino.tmdb exist from Kino 0.9.53; the guards are here for the SDK validator.
if (typeof kino.meta !== "function") throw kino.error("unavailable", "kino.meta not available");
if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "kino.tmdb not available");

const TMDB_IMG = "https://image.tmdb.org/t/p/";
const DAY_MS = 24 * 60 * 60 * 1000;
/** One resolve: the lookup of the title, the site's pages and a player, each bounded by its own request time. */
const RESOLVE_MS = 40000;
const MAX_COPIES = 8;

// ---- i18n ----

const STRINGS = {
  es: {
    unavailable: "El servicio no está disponible en este momento.",
    noStreams: "No se encontraron fuentes para este título.",
    needResolver: "Para reproducir, abre SeriesMetro desde el menú e instala el motor de reproducción que te pedirá.",
    noMeta: "No se encontró información de este título.",
    trendingMovies: "Películas populares",
    trendingSeries: "Series populares",
    nowPlaying: "En cines ahora",
    upcoming: "Próximos estrenos",
    topMovies: "Películas mejor valoradas",
    onTheAir: "Series en emisión",
    topSeries: "Series mejor valoradas",
    kids: "Para los niños",
    docs: "Documentales",
    anime: "Anime",
    gAction: "Acción",
    gComedy: "Comedia",
    gSciFi: "Ciencia ficción",
    gHorror: "Terror",
    gDrama: "Drama",
    cacheCleared: "Caché de títulos vaciada.",
    lat: "Latino",
    esp: "Castellano",
    sub: "Subtitulado",
  },
  en: {
    unavailable: "The service is not available right now.",
    noStreams: "No streams found for this title.",
    needResolver: "To play, open SeriesMetro from the menu and install the playback engine it asks for.",
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
    sub: "Subtitled",
  },
};

function t(key) {
  const lang = String(kino.lang || "es").startsWith("en") ? "en" : "es";
  return (STRINGS[lang] || STRINGS.es)[key] || key;
}

// ---- TMDB catalog helpers ----

// TMDB's genre ids as names Kino knows (movie and TV ids). The Home files every title by its genres, one row per genre across
// all plugins, so a title that carries none lands in the bare "Películas" / "Series" rows: that is why a Home with only the
// row's own `genre` showed two rows. Kids, news and talk are types for Kino, not genres: the "kids" row covers them.
const TMDB_GENRES = {
  28: "Acción", 12: "Aventura", 16: "Animación", 35: "Comedia", 80: "Crimen", 99: "Documentales", 18: "Drama", 10751: "Familia",
  14: "Fantasía", 36: "Historia", 27: "Terror", 9648: "Misterio", 10749: "Romance", 878: "Ciencia ficción", 53: "Suspenso",
  10752: "Bélica", 37: "Western", 10759: "Acción", 10765: "Ciencia ficción", 10766: "Drama", 10764: "Reality", 10768: "Bélica",
};

/** The Kino genre names of a TMDB result (`genre_ids`), without repeats, at most 5. */
function genresOf(raw) {
  const names = new Set();
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
    year: (raw.release_date || raw.first_air_date || "").slice(0, 4) || undefined,
    poster: raw.poster_path ? TMDB_IMG + "w500" + raw.poster_path : undefined,
    backdrop: raw.backdrop_path ? TMDB_IMG + "w1280" + raw.backdrop_path : undefined,
    overview: raw.overview || undefined,
    rating: raw.vote_average > 0 ? Math.round(raw.vote_average * 10) / 10 : undefined,
    ids: { tmdb: tmdbId },
    genres: genresOf(raw).length ? genresOf(raw) : undefined,
  };
}

const titlesOf = (query) => [query.q, query.originalTitle, ...(query.altTitles || [])].filter(Boolean);

// ---- home ----

/**
 * The Home rows, in order. `genre` is one of Kino's ten ids (it lines the rows up with other plugins' in the Categorías tab) and
 * `ref` makes the row browsable ("Ver más"). `path` is the TMDB list behind it; `params` narrow it (a genre of /discover).
 */
const HOME_ROWS = [
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
  { id: "anime", title: "anime", genre: "anime", ref: "anime:tv", kind: "tv", path: "/discover/tv", airing: true, params: { with_genres: 16, with_origin_country: "JP" } },
];

// A discover list sorted by popularity is full of titles nobody has voted on: ask for some votes.
const DISCOVER = { sort_by: "popularity.desc", "vote_count.gte": 200 };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** What is new in anime: the Japanese animation with an episode aired in the last 3 weeks, the newest series first (no vote floor: a new show has none yet). */
const airingParams = (extra) => ({ ...extra, sort_by: "first_air_date.desc", "air_date.gte": isoDay(Date.now() - 21 * DAY_MS), "air_date.lte": isoDay(Date.now()) });

async function homeRow(row) {
  const res = await tmdb(row.path, row.airing ? airingParams(row.params) : { ...(row.path.startsWith("/discover") ? DISCOVER : {}), ...(row.params || {}) });
  // a row of posters: what has none looks broken
  const items = (res?.results || []).filter((r) => r.poster_path).slice(0, 20).map((r) => itemFromTmdb(r, row.kind));
  return items.length ? { id: row.id, title: t(row.title), genre: row.genre, ref: row.ref, items } : null;
}

/** Kino cuts a Home at 20 s: the rows still loading by then are left off and the ones that loaded are shown. */
const HOME_BUDGET_MS = 14000;

export async function home() {
  // Every row on its own: one that fails or comes back empty is left out, the rest of the Home is still shown.
  const out = HOME_ROWS.map(() => null);
  let done = false;
  const all = Promise.all(HOME_ROWS.map((row, i) => homeRow(row).then((r) => { out[i] = r; }, () => {}))).then(() => { done = true; });
  const end = Date.now() + HOME_BUDGET_MS;
  while (!done && Date.now() < end) await Promise.race([all, kino.sleep(Math.min(250, Math.max(1, end - Date.now())))]);
  const rows = out.filter(Boolean);
  if (!rows.length) throw kino.error("unavailable", "no home row could be loaded", { userMessage: t("unavailable") });
  return rows;
}

// ---- search ----

export async function search(query) {
  if (!String(query.q || "").trim()) return [];
  const type = query.type;

  if (type === "series") {
    const res = await tmdb("/search/tv", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "tv")), titlesOf(query));
  }
  if (type === "movie") {
    const res = await tmdb("/search/movie", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "movie")), titlesOf(query));
  }

  // "any", and the kinds this plugin has nothing for (anime, music, podcast): both catalogs, ranked by how they match
  const [movies, tv] = await Promise.all([
    tmdb("/search/movie", { query: query.q }),
    tmdb("/search/tv", { query: query.q }),
  ]);
  const all = [
    ...(movies?.results || []).map((r) => itemFromTmdb(r, "movie")),
    ...(tv?.results || []).map((r) => itemFromTmdb(r, "tv")),
  ];
  return kino.rank.sortBySimilarity(all, titlesOf(query));
}

// ---- browse ----

export async function browse(ref, cursor) {
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
    // Japanese animation airing now (TMDB has no anime flag, but animation from Japan is what the row means)
    kind = "tv";
    path = "/discover/tv";
    params = { ...airingParams({ with_genres: 16, with_origin_country: "JP" }), page };
  } else if (parts[0] === "genre" && (parts[1] === "movie" || parts[1] === "tv") && /^\d+$/.test(parts[2] || "")) {
    kind = parts[1];
    path = `/discover/${kind}`;
    params = { ...DISCOVER, with_genres: parts[2], page };
  } else {
    return { items: [] };
  }

  const res = await tmdb(path, params);
  const items = (res?.results || []).filter((r) => r.poster_path).map((r) => itemFromTmdb(r, kind));
  const next = res?.page < res?.total_pages ? String(page + 1) : undefined;
  return { items, next };
}

// ---- categories ----

/**
 * One backdrop per genre tile: a well-known title of the genre, its TMDB image path at w780 (each checked with a
 * request to image.tmdb.org: 200, image/jpeg). Static on purpose: no extra TMDB request at runtime. Keys are TMDB genre
 * ids; a genre not listed gets no art (Kino draws its plain tile). Kino draws a tile's picture from `art`.
 */
const TILE_ART_SIZE = "w780";
const MOVIE_ART = {
  28: "/gqrnQA6Xppdl8vIb2eJc58VC1tW.jpg", // Action: Mad Max: Fury Road
  12: "/zPACwR32amTNvzId9qyapCWXYDJ.jpg", // Adventure: Raiders of the Lost Ark
  16: "/g7CHF8gTLGooTbP4GznIGwaqAGL.jpg", // Animation: Coco
  35: "/jK65srQczOKTpW62wPxwwKztGgE.jpg", // Comedy: The Grand Budapest Hotel
  80: "/ejdD20cdHNFAYAN2DlqPToXKyzx.jpg", // Crime: The Godfather
  99: "/sW7VOrkHKYIeV9PaYc5IqGU2XK8.jpg", // Documentary: My Octopus Teacher
  18: "/pNjh59JSxChQktamG3LMp9ZoQzp.jpg", // Drama: The Shawshank Redemption
  10751: "/iJgNOTSBNrC90U2xyYq9ln0b35o.jpg", // Family: Paddington 2
  14: "/oiwc338EoBgS4sEI2ixAny4KQKg.jpg", // Fantasy: The Fellowship of the Ring
  36: "/m4MGxxEgAMqIX9x8MCg5pYeyYjU.jpg", // History: The King's Speech
  27: "/nHRUtBwFNnNN70vcQ7lAsjc2T6S.jpg", // Horror: A Quiet Place
  10402: "/dcvbs8z0GEXslC1kCT77x19XDeR.jpg", // Music: Bohemian Rhapsody
  9648: "/4HWAQu28e2yaWrtupFPGFkdNU7V.jpg", // Mystery: Knives Out
  10749: "/zdXnJqBaGFVtLoPNuMeKfEYUViZ.jpg", // Romance: The Notebook
  878: "/xJHokMbljvjADYdit5fK5VQsXEG.jpg", // Science Fiction: Interstellar
  53: "/iWak7wT0j6ycCc8lKr4NBz9c7n5.jpg", // Thriller: Gone Girl
  10752: "/bdD39MpSVhKjxarTxLSfX6baoMP.jpg", // War: Saving Private Ryan
  37: "/x4biAVdPVCghBlsVIzB6NmbghIz.jpg", // Western: The Good, the Bad and the Ugly
};
const TV_ART = {
  10759: "/yUOFocKDW7MCC5isx4FK8A68QFp.jpg", // Action & Adventure: Lost
  16: "/qcSHGC5BfoqBoP99PzDIERYG5Qm.jpg", // Animation: The Simpsons
  35: "/l0qVZIpXtIo7km9u5Yqh0nKPOr5.jpg", // Comedy: Friends
  80: "/xGexTKCJDkl12dTW4YCBDXWb1AD.jpg", // Crime: Money Heist
  99: "/sW7VOrkHKYIeV9PaYc5IqGU2XK8.jpg", // Documentary: My Octopus Teacher
  18: "/jP0Rhj9OTPDAwQlHQwOLFDdeE8t.jpg", // Drama: Grey's Anatomy
  10751: "/iJgNOTSBNrC90U2xyYq9ln0b35o.jpg", // Family: Paddington 2
  10762: "/f3f5OzzYd8m3zN47DAjKs0sbx00.jpg", // Kids: SpongeBob SquarePants
  9648: "/4HWAQu28e2yaWrtupFPGFkdNU7V.jpg", // Mystery: Knives Out
  10764: "/qnTBxxv7q4xVwgZBLb0vtILLelh.jpg", // Reality: Keeping Up with the Kardashians
  10765: "/9P4IIMYY3HifqeruZq0ZZ9g7YUi.jpg", // Sci-Fi & Fantasy: Stranger Things
  10768: "/bdD39MpSVhKjxarTxLSfX6baoMP.jpg", // War & Politics: Saving Private Ryan
  37: "/x4biAVdPVCghBlsVIzB6NmbghIz.jpg", // Western: The Good, the Bad and the Ugly
};
const tileArt = (table, genreId) => (table[genreId] ? TMDB_IMG + TILE_ART_SIZE + table[genreId] : undefined);
const withArt = (tile, art) => (art ? { ...tile, art } : tile);

export async function categories() {
  const [mg, tg] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
  const cats = [];
  for (const g of (mg?.genres || []).slice(0, 12)) cats.push(withArt({ id: "gm" + g.id, title: g.name, ref: "genre:movie:" + g.id }, tileArt(MOVIE_ART, g.id)));
  for (const g of (tg?.genres || []).slice(0, 8)) cats.push(withArt({ id: "gt" + g.id, title: g.name + " (series)", ref: "genre:tv:" + g.id }, tileArt(TV_ART, g.id)));
  return cats.slice(0, 24);
}

// ---- episodes ----

export async function episodes(ref) {
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
      runtimeMinutes: meta.runtimeMinutes,
    },
    episodes: (meta.episodes || []).map((ep) => ({
      season: ep.season,
      number: ep.number,
      // the TMDB id rides in the ref: resolve() needs the show's names and years to find its page on the site
      ref: "ep:" + tmdbId + ":" + ep.season + ":" + ep.number,
      title: ep.title,
      still: ep.still,
      overview: ep.overview,
      airDate: ep.airDate,
    })),
  };
}

// ---- resolve ----

const SERVER_LABEL = { fastream: "Fastream" };

/** The languages in the order the person prefers them (the "language" setting), the other two after it. */
function languageOrder() {
  const pref = String(kino.config.get("language") || "lat");
  return pref === "esp" ? ["esp", "lat", "sub"] : pref === "sub" ? ["sub", "lat", "esp"] : ["lat", "esp", "sub"];
}

/** The copies, preferred language first. */
function ordered(copies) {
  const langs = languageOrder();
  return [...copies].sort((a, b) => langs.indexOf(a.lang) - langs.indexOf(b.lang));
}

const labelOf = (c) => `${t(c.lang)} · ${SERVER_LABEL[c.server] || c.server}`;

/** What a ref names: "m:<tmdb>" a movie, "ep:<tmdb>:<season>:<episode>" an episode. */
function parseRef(ref) {
  let m = /^m:(\d+)$/.exec(ref);
  if (m) return { kind: "movie", tmdbId: m[1] };
  m = /^ep:(\d+):(\d+):(\d+)$/.exec(ref);
  return m ? { kind: "tv", tmdbId: m[1], season: Number(m[2]), episode: Number(m[3]) } : null;
}

/** A lazy copy's ref: "cp:m:<tmdb>:<lang>:<server>" or "cp:ep:<tmdb>:<season>:<episode>:<lang>:<server>". */
const copyRef = (w, c) => (w.kind === "movie" ? `cp:m:${w.tmdbId}:${c.lang}:${c.server}` : `cp:ep:${w.tmdbId}:${w.season}:${w.episode}:${c.lang}:${c.server}`);

/** The wanted title and copy out of a lazy ref, or null. */
function parseCopyRef(ref) {
  let m = /^cp:m:(\d+):(lat|esp|sub):([a-z]+)$/.exec(ref);
  if (m) return { what: { kind: "movie", tmdbId: m[1] }, lang: m[2], server: m[3] };
  m = /^cp:ep:(\d+):(\d+):(\d+):(lat|esp|sub):([a-z]+)$/.exec(ref);
  return m ? { what: { kind: "tv", tmdbId: m[1], season: Number(m[2]), episode: Number(m[3]) }, lang: m[4], server: m[5] } : null;
}

/**
 * What the site needs to find a title's page: its names in the languages it uses and its years (to turn away another title with
 * the same name). Kept 7 days. kino.storage keeps text only, so it rides as JSON.
 */
async function titleOf(what) {
  const tv = what.kind === "tv";
  const key = (tv ? "show:" : "movie:") + what.tmdbId;
  let info = null;
  try { info = JSON.parse(kino.storage.get(key) || "null"); } catch (_) { info = null; }
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
      lastYear: tv && !d.in_production ? year(d.last_air_date) : null,
    };
    kino.storage.set(key, JSON.stringify(info), { ttlMs: 7 * DAY_MS });
  }
  return { ...info, kind: what.kind, season: what.season, episode: what.episode };
}

/** A Stream from an extractor's answer; the player sends okhttp's User-Agent unless told otherwise and the CDNs answer 403 to it. */
function toStream(s, c) {
  const out = { url: s.url, label: labelOf(c), headers: { "User-Agent": UA, ...(s.headers && typeof s.headers === "object" ? s.headers : {}) } };
  if (s.mime) out.mime = s.mime;
  const subs = Array.isArray(s.subtitles) ? s.subtitles.filter((x) => x && x.lang && x.url) : [];
  if (subs.length) out.subtitles = subs;
  if (Number.isFinite(s.durationMs) && s.durationMs > 0) out.durationMs = Math.round(s.durationMs);
  return out;
}

// A hidden-browser capture costs up to 20 s whether or not it finds the video, so the budget is spent on the ATTEMPT, and a
// capture only starts if a whole page still fits before this resolve's deadline.
const MAX_CAPTURES = 1;
const CAPTURE_PAGE_MS = 23000;
function takeCapture(budget) {
  if (!budget || budget.captures <= 0 || budget.deadline - Date.now() < CAPTURE_PAGE_MS) return false;
  budget.captures -= 1;
  return true;
}

/** Whether a stream answers: a 2 KB peek (maxBytes + Range); a playlist must read like one; a 401/403 (a token) is trusted. */
async function answers(stream) {
  try {
    const r = await kino.fetch(stream.url, { headers: { ...stream.headers, Range: "bytes=0-2047" }, timeoutMs: 5000, maxBytes: 2048 });
    if (r.status === 401 || r.status === 403) return true;
    if (!r.ok) return false;
    return !/\.m3u8(\?|$)/i.test(stream.url) || /^\s*#EXTM3U/.test(r.text() || "");
  } catch (e) {
    // A timeout is a slow CDN, not a dead one (a Redmi took 4.3 s for the TLS handshake of acek-cdn.com, then played): the
    // player gets it. Only an answer that says "dead" (an error status, a non-playlist) passes the stream over.
    return !!(e && (e.code === "host_not_allowed" || e.code === "too_large" || e.code === "timeout"));
  }
}

/**
 * One copy opened through the shared kino-resolver (its provider door), which reads the player page (fastream and any other host the
 * site lists); a host it can't open inline is captured in SeriesMetro's own hidden WebView while the budget allows. A stream the
 * resolver found is peeked at first (its CDN can be down for one file). Null when nothing plays.
 */
async function open(c, budget) {
  try {
    const out = await resolveViaHelper(c.embedUrl, kino, SITE + "/", () => takeCapture(budget));
    if (!out || typeof out.url !== "string" || !out.url) { kino.log("[seriesmetro]", c.server, "no_stream"); return null; }
    const stream = toStream(out, c);
    return out.captured || (await answers(stream)) ? stream : null;
  } catch (e) {
    kino.log("[seriesmetro]", c.server, (e && e.code) || "resolve_failed");
    return null;
  }
}

export async function resolve(ref) {
  // SeriesMetro plays nothing on its own: the shared kino-resolver opens the players.
  if (!(await resolverInstalled(kino))) throw kino.error("unavailable", "resolver missing", { userMessage: t("needResolver") });
  const req = makeReq(kino, { deadline: Date.now() + RESOLVE_MS });
  const budget = { captures: MAX_CAPTURES, deadline: Date.now() + RESOLVE_MS };

  // One copy picked from the Servidor menu (or reached by the automatic fallback): just that one
  if (ref.startsWith("cp:")) {
    const want = parseCopyRef(ref);
    if (!want) throw kino.error("not_found", "bad copy ref");
    const copy = (await listCopies(await titleOf(want.what), { req })).find((c) => c.lang === want.lang && c.server === want.server);
    const stream = copy ? await open(copy, budget) : null;
    if (!stream) throw kino.error("not_found", "copy not available: " + want.lang + "/" + want.server, { userMessage: t("noStreams") });
    return stream;
  }

  const what = parseRef(ref);
  if (!what) throw kino.error("not_found", "unknown ref: " + ref.slice(0, 40));
  const copies = ordered(await listCopies(await titleOf(what), { req }));
  if (!copies.length) throw kino.error("not_found", "no copies for tmdb " + what.tmdbId, { userMessage: t("noStreams") });

  // The first copy that opens plays; the rest are lazy copies, opened only if the person (or the fallback) reaches them
  let main = null;
  let tried = 0;
  for (const c of copies) {
    tried++;
    main = await open(c, budget);
    if (main) break;
  }
  if (!main) throw kino.error("not_found", "no copy opened for tmdb " + what.tmdbId, { userMessage: t("noStreams") });
  const alternatives = copies.slice(tried).slice(0, MAX_COPIES).map((c) => ({ label: labelOf(c), ref: copyRef(what, c) }));
  return { ...main, ...(alternatives.length ? { alternatives } : {}) };
}

// ---- settings actions ----

export async function action(key) {
  if (key === "clearCache") {
    for (const k of kino.storage.keys()) {
      if (k.startsWith("show:") || k.startsWith("movie:")) kino.storage.remove(k);
    }
    return { message: t("cacheCleared") };
  }
}

// ---- the screen: the standard xuper-plugin screen (src/std) ----

// SeriesMetro delegates every hoster to kino-resolver (resolve() refuses with needResolver while it is missing), so the screen is the install gate until it is installed.
let std = null;
const standard = () => (std ??= makeStandardScreen({ snapshot: "xuper-plugin/kino-plugin-seriesmetro",
  kino, name: "SeriesMetro", logo: LOGO, logoAspect: LOGO_ASPECT, needsResolver: true, hasSettings: true,
  tabs: [
    { id: "inicio", label: "Películas y series", labelEn: "Movies & series" },
  ],
  loadTab: async () => ({ rows: await home() }),
}));

export async function screen(ctx) {
  await null;
  return standard().screen(ctx && typeof ctx === "object" ? ctx : {});
}

export async function screenEvent(ev) {
  await null;
  return standard().screenEvent(ev && typeof ev === "object" ? ev : {});
}

// std 1.7.0: the catalog door -- the author's other plugins (Da-Video) find titles here through Kino, and Kino opens and
// plays what they find in this plugin, with its own resolve.
import { catalogDoor } from "./std/catalog.js";
export const proto_catalog_search = catalogDoor(search);
