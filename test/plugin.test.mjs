// node --test test/plugin.test.mjs
// Offline: a fake www3.seriesmetro.net (movie and episode pages, a season list by POST), a fake Fastream and a stub of `kino`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateManifest } from "../sdk/contract.mjs";

const calls = [];
let config = {};
const tmdbCalls = [];
let tmdbImpl = async () => ({ results: [] });
let metaImpl = async () => null;
let pages = {};
let logs = [];
let store = new Map();
globalThis.kino = {
  lang: "es",
  config: { get: (k) => config[k] },
  fetch: async (url, opts = {}) => {
    calls.push({ url, opts });
    const p = pages[url];
    if (!p) return { ok: false, status: 404, text: () => "", json: () => ({}) };
    const status = p.status ?? 200;
    return { ok: status < 400, status, text: () => p.body, json: () => JSON.parse(p.body) };
  },
  // like the real one: it keeps text, whatever it is given
  storage: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, String(v)), keys: () => [...store.keys()], remove: (k) => store.delete(k) },
  log: (...a) => logs.push(a.join(" ")),
  tmdb: async (path, params) => { tmdbCalls.push({ path, params }); return tmdbImpl(path, params); },
  meta: (q) => metaImpl(q), rank: {},
  error: (code, message, opts = {}) => Object.assign(new Error(message), { code, ...opts }),
};
const plugin = await import("../plugin.js");

beforeEach(() => { calls.length = 0; tmdbCalls.length = 0; logs = []; config = {}; pages = {}; store = new Map(); metaImpl = async () => null; tmdbImpl = async () => ({ results: [] }); });

const SITE = "https://www3.seriesmetro.net";
const FAST = (id) => `https://fastream.to/embed-${id}.html`;

/** TMDB's answers: a movie (titles in es-MX plus the es-ES and en translations) and a show. */
const MOVIE = (over = {}) => ({ id: 354912, title: "Coco", original_title: "Coco", release_date: "2017-10-27",
  translations: { translations: [{ iso_3166_1: "ES", data: { title: "Coco" } }, { iso_3166_1: "US", data: { title: "Coco" } }] }, ...over });
const SHOW = (over = {}) => ({ id: 1396, name: "Breaking Bad", original_name: "Breaking Bad", first_air_date: "2008-01-20", last_air_date: "2013-09-29", in_production: false,
  translations: { translations: [{ iso_3166_1: "ES", data: { name: "Breaking Bad" } }, { iso_3166_1: "US", data: { name: "Breaking Bad" } }] }, ...over });

/** A movie or episode page: the year, the option tabs with their labels, and one iframe per option. */
const mediaPage = (year, labels) => `<html><span class="year fa-calendar">${year}</span>
${labels.map((l, i) => `<a href="#options-${i + 1}"><span class="server">${l}</span></a>`).join("\n")}
${labels.map((l, i) => `<div id="options-${i + 1}"><iframe data-src="${SITE}/?trembed=${i}&#038;trid=9&amp;trtype=1"></iframe></div>`).join("\n")}</html>`;
const trembed = (i, embed) => ({ [`${SITE}/?trembed=${i}&trid=9&trtype=1`]: { body: `<iframe src="${embed}"></iframe>` } });
const fastPage = (name) => ({ body: `<script>jwplayer().setup({ file: "https://s1.fastream.to/hls/${name}/master.m3u8" })</script>` });

const LABELS = ["Fastream -Latino", "Fastream -Castellano", "Fastream -Subtitulado"];
/** The site's movie page, its three players and their Fastream pages. */
function serveMovie(slug, year = 2017, labels = LABELS, extra = {}) {
  pages = {
    [`${SITE}/pelicula/${slug}/`]: { body: mediaPage(year, labels) },
    ...trembed(0, FAST("lat")), ...trembed(1, FAST("esp")), ...trembed(2, FAST("sub")),
    [FAST("lat")]: fastPage("lat"), [FAST("esp")]: fastPage("esp"), [FAST("sub")]: fastPage("sub"),
    ...extra,
  };
  tmdbImpl = async (path) => (path === "/movie/354912" ? MOVIE() : { results: [] });
}
/** The site's series page, its season list (a POST), the episode page and its players. */
function serveEpisode(slug, season, episode, year = 2008, labels = LABELS, extra = {}) {
  pages = {
    [`${SITE}/serie/${slug}/`]: { body: `<div data-post="77">` },
    [`${SITE}/wp-admin/admin-ajax.php`]: { body: `<a href="${SITE}/capitulo/${slug}-temporada-${season}-capitulo-${episode - 1}/">x</a><a href="${SITE}/capitulo/${slug}-temporada-${season}-capitulo-${episode}/">y</a><a href="${SITE}/capitulo/${slug}-temporada-${season + 1}-capitulo-${episode}/">z</a>` },
    [`${SITE}/capitulo/${slug}-temporada-${season}-capitulo-${episode}/`]: { body: mediaPage(year, labels) },
    ...trembed(0, FAST("lat")), ...trembed(1, FAST("esp")), ...trembed(2, FAST("sub")),
    [FAST("lat")]: fastPage("lat"), [FAST("esp")]: fastPage("esp"), [FAST("sub")]: fastPage("sub"),
    ...extra,
  };
  tmdbImpl = async (path) => (path === "/tv/1396" ? SHOW() : { results: [] });
}

const manifest = JSON.parse(readFileSync(new URL("../kino-plugin.json", import.meta.url), "utf8"));

test("the manifest is valid for Kino and declares only the site and Fastream", () => {
  const out = validateManifest(readFileSync(new URL("../kino-plugin.json", import.meta.url), "utf8"));
  assert.ok(!out.errors?.length, JSON.stringify(out.errors));
  assert.deepEqual(manifest.hosts, ["www3.seriesmetro.net", "fastream.to"]);
  assert.equal(manifest.streamHosts, "any");
  assert.ok(manifest.capabilities.includes("download"));
  assert.ok(!manifest.fetchHosts && !manifest.browser, "no broad permissions beyond the CDN");
});

test("a movie finds its page by title, plays Latino on Fastream and keeps the other languages as lazy copies", async () => {
  serveMovie("coco");
  const a = await plugin.resolve("m:354912");
  assert.ok(calls.some((c) => c.url === `${SITE}/pelicula/coco/`));
  assert.equal(a.url, "https://s1.fastream.to/hls/lat/master.m3u8");
  assert.equal(a.label, "Latino · Fastream");
  assert.equal(a.mime, "application/vnd.apple.mpegurl");
  assert.equal(a.headers.Referer, "https://fastream.to/");
  assert.match(a.headers["User-Agent"], /Mozilla/);
  assert.deepEqual(a.alternatives.map((x) => x.label), ["Castellano · Fastream", "Subtitulado · Fastream"]);
  assert.deepEqual(a.alternatives.map((x) => x.ref), ["cp:m:354912:esp:fastream", "cp:m:354912:sub:fastream"]);
  assert.ok(a.alternatives.every((x) => !x.url && x.ref.length <= 512));
});

test("the page's tab labels give server and language; an embed address is read from each trembed page", async () => {
  serveMovie("coco");
  await plugin.resolve("m:354912");
  const asked = calls.map((c) => c.url);
  assert.ok(asked.includes(`${SITE}/?trembed=0&trid=9&trtype=1`) && asked.includes(`${SITE}/?trembed=2&trid=9&trtype=1`));
  assert.ok(calls.filter((c) => c.url.includes("trembed")).every((c) => c.opts.headers.Referer === SITE + "/"));
});

test("the title's names come from TMDB and are kept as JSON; a value an older build left is asked again", async () => {
  serveMovie("coco");
  await plugin.resolve("m:354912");
  assert.equal(tmdbCalls[0].path, "/movie/354912");
  assert.equal(tmdbCalls[0].params.language, "es-MX");
  assert.equal(tmdbCalls[0].params.append_to_response, "translations");
  tmdbCalls.length = 0;
  assert.equal((await plugin.resolve("m:354912")).label, "Latino · Fastream");
  assert.equal(tmdbCalls.length, 0, "the second time the names come from the cache");
  store.set("movie:354912", "[object Object]");
  assert.equal((await plugin.resolve("m:354912")).label, "Latino · Fastream");
  assert.equal(tmdbCalls.length, 1);
});

test("a movie page whose year is off by one is the movie; two years off is another one", async () => {
  serveMovie("coco", 2018);
  assert.equal((await plugin.resolve("m:354912")).label, "Latino · Fastream");
  serveMovie("coco", 2015);
  await assert.rejects(() => plugin.resolve("m:354912"), (e) => e.code === "not_found" && e.userMessage === "No se encontraron fuentes para este título.");
});

test("titles are tried in order (es-MX, es-ES, original, en), one slug per distinct title", async () => {
  tmdbImpl = async () => MOVIE({ title: "Una película", original_title: "A Movie", translations: { translations: [{ iso_3166_1: "ES", data: { title: "Una peli" } }, { iso_3166_1: "US", data: { title: "A Movie" } }] } });
  pages = { [`${SITE}/pelicula/a-movie/`]: { body: mediaPage(2017, LABELS) }, ...trembed(0, FAST("lat")), [FAST("lat")]: fastPage("lat") };
  assert.equal((await plugin.resolve("m:354912")).label, "Latino · Fastream");
  assert.deepEqual(calls.filter((c) => c.url.includes("/pelicula/")).map((c) => c.url.split("/pelicula/")[1]), ["una-pelicula/", "una-peli/", "a-movie/"]);
});

test("the language setting puts Castellano or Subtitulado first", async () => {
  serveMovie("coco");
  config = { language: "esp" };
  const a = await plugin.resolve("m:354912");
  assert.equal(a.label, "Castellano · Fastream");
  assert.equal(a.alternatives[0].label, "Latino · Fastream");
  config = { language: "sub" };
  assert.equal((await plugin.resolve("m:354912")).label, "Subtitulado · Fastream");
});

test("a lazy copy opens just that language; one the page no longer lists is not_found", async () => {
  serveMovie("coco", 2017, [LABELS[0]]);
  assert.equal((await plugin.resolve("cp:m:354912:lat:fastream")).label, "Latino · Fastream");
  await assert.rejects(() => plugin.resolve("cp:m:354912:sub:fastream"), (e) => e.code === "not_found" && e.userMessage === "No se encontraron fuentes para este título.");
  await assert.rejects(() => plugin.resolve("cp:garbage"), (e) => e.code === "not_found");
});

test("an episode goes through the series page, the season list (a POST) and the episode page", async () => {
  serveEpisode("breaking-bad", 1, 3);
  const a = await plugin.resolve("ep:1396:1:3");
  const post = calls.find((c) => c.url === `${SITE}/wp-admin/admin-ajax.php`);
  assert.equal(post.opts.method, "POST");
  assert.deepEqual(post.opts.body.form, { action: "action_select_season", season: "1", post: "77" });
  assert.ok(calls.some((c) => c.url === `${SITE}/capitulo/breaking-bad-temporada-1-capitulo-3/`));
  assert.equal(a.label, "Latino · Fastream");
  assert.deepEqual(a.alternatives.map((x) => x.ref), ["cp:ep:1396:1:3:esp:fastream", "cp:ep:1396:1:3:sub:fastream"]);
  assert.equal((await plugin.resolve("cp:ep:1396:1:3:esp:fastream")).url, "https://s1.fastream.to/hls/esp/master.m3u8");
});

test("an episode the season list lacks, another season's, or a show of another run are not_found", async () => {
  serveEpisode("breaking-bad", 1, 3);
  await assert.rejects(() => plugin.resolve("ep:1396:1:9"), (e) => e.code === "not_found" && e.userMessage === "No se encontraron fuentes para este título.");
  serveEpisode("breaking-bad", 1, 3, 1985);
  await assert.rejects(() => plugin.resolve("ep:1396:1:3"), (e) => e.code === "not_found");
  serveEpisode("breaking-bad", 1, 3, 2007); // an episode year inside the run, from one year before
  assert.equal((await plugin.resolve("ep:1396:1:3")).label, "Latino · Fastream");
});

test("a player Fastream shows nothing for is skipped: the next one plays and the failed one is not offered again", async () => {
  serveMovie("coco", 2017, LABELS, { [FAST("lat")]: { body: "<html>no player here</html>" } });
  const a = await plugin.resolve("m:354912");
  assert.equal(a.label, "Castellano · Fastream");
  assert.ok(!a.alternatives.some((x) => x.label === "Latino · Fastream"));
});

test("options on hosts no extractor knows are left out; with only those, the person reads a readable error", async () => {
  serveMovie("coco", 2017, ["Waaw -Latino"], { ...trembed(0, "https://waaw.example/e/1") });
  await assert.rejects(() => plugin.resolve("m:354912"), (e) => e.code === "not_found" && e.userMessage === "No se encontraron fuentes para este título.");
});

test("a title TMDB does not know or an unknown ref are not_found", async () => {
  tmdbImpl = async () => null;
  await assert.rejects(() => plugin.resolve("m:5"), (e) => e.code === "not_found" && e.userMessage === "No se encontró información de este título.");
  await assert.rejects(() => plugin.resolve("nonsense"), (e) => e.code === "not_found");
  await assert.rejects(() => plugin.resolve("ep:1:2"), (e) => e.code === "not_found");
});

// ---- home and browse ----

const GENRES = ["peliculas", "series", "anime", "infantil", "documentales", "deportes", "noticias", "musica", "entretenimiento", "otros"];
const titles = (n, withPoster = true) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, title: "T" + i, name: "T" + i, release_date: "2024-01-01", ...(withPoster ? { poster_path: "/p" + i + ".jpg" } : {}) }));

test("home has many rows, each with a genre Kino knows, a ref to browse and at most 20 titles", async () => {
  tmdbImpl = async () => ({ results: titles(40), page: 1, total_pages: 5 });
  const rows = await plugin.home();
  assert.ok(rows.length >= 10 && rows.length <= 20, "rows: " + rows.length);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  for (const r of rows) {
    assert.ok(GENRES.includes(r.genre), r.id + " genre " + r.genre);
    assert.ok(r.ref && r.title && r.items.length > 0 && r.items.length <= 20, r.id);
    assert.ok(r.items.every((i) => i.poster && i.ref && i.kind));
  }
  assert.ok(rows.some((r) => r.genre === "series") && rows.some((r) => r.genre === "infantil") && rows.some((r) => r.genre === "documentales"));
  assert.ok(tmdbCalls.length <= 20, "one TMDB call per row, within Kino's 20 per 10 s: " + tmdbCalls.length);
});

test("every title carries its genres, so the Home can file it in a row per genre (not only 'Películas' and 'Series')", async () => {
  tmdbImpl = async () => ({ results: [{ id: 1, title: "A", poster_path: "/a.jpg", genre_ids: [28, 878, 12, 99999], release_date: "2024-01-01" }, { id: 2, title: "B", poster_path: "/b.jpg", genre_ids: [10759, 10765, 18] }, { id: 3, title: "C", poster_path: "/c.jpg" }] });
  const items = (await plugin.home())[0].items;
  assert.deepEqual(items[0].genres, ["Acción", "Ciencia ficción", "Aventura"]);
  assert.deepEqual(items[1].genres, ["Acción", "Ciencia ficción", "Drama"]);
  assert.equal(items[2].genres, undefined);
  assert.ok((await plugin.browse("list:movie:top_rated", null)).items[0].genres.length > 0);
});

test("the genre rows are discover lists with some votes behind them", async () => {
  tmdbImpl = async () => ({ results: titles(5) });
  await plugin.home();
  const action = tmdbCalls.find((c) => c.params?.with_genres === 28);
  assert.equal(action.path, "/discover/movie");
  assert.equal(action.params["vote_count.gte"], 200);
});

test("a row that fails or has no posters is left out, the others are still shown", async () => {
  tmdbImpl = async (path) => {
    if (path === "/movie/upcoming") throw new Error("boom");
    if (path === "/movie/top_rated") return { results: titles(5, false) };
    return { results: titles(5) };
  };
  const rows = await plugin.home();
  assert.ok(!rows.some((r) => r.id === "upcoming" || r.id === "top-movies"));
  assert.ok(rows.length >= 10);
});

test("when no row can be loaded the person gets a readable error", async () => {
  tmdbImpl = async () => { throw new Error("down"); };
  await assert.rejects(() => plugin.home(), (e) => e.code === "unavailable" && e.userMessage === "El servicio no está disponible en este momento.");
});

test("rows are named in the person's language", async () => {
  tmdbImpl = async () => ({ results: titles(3) });
  globalThis.kino.lang = "en";
  try { assert.equal((await plugin.home())[0].title, "Trending movies"); } finally { globalThis.kino.lang = "es"; }
});

test("every home row's ref opens its own list in Ver más, page after page", async () => {
  tmdbImpl = async (path, params) => ({ results: titles(30), page: params.page, total_pages: 3 });
  const rows = await plugin.home();
  for (const row of rows) {
    tmdbCalls.length = 0;
    const first = await plugin.browse(row.ref, null);
    assert.ok(first.items.length > 0, row.ref);
    assert.equal(first.next, "2", row.ref);
    assert.equal(tmdbCalls[0].path, HOME_PATHS[row.id], row.ref + " -> " + tmdbCalls[0].path);
    const last = await plugin.browse(row.ref, "3");
    assert.equal(last.next, undefined);
  }
  assert.deepEqual(await plugin.browse("nonsense", null), { items: [] });
  assert.deepEqual(await plugin.browse("list:movie:../account", null), { items: [] });
});

const HOME_PATHS = {
  "trending-movies": "/trending/movie/week", "now-playing": "/movie/now_playing", upcoming: "/movie/upcoming", "top-movies": "/movie/top_rated",
  "trending-series": "/trending/tv/week", "on-the-air": "/tv/on_the_air", "top-series": "/tv/top_rated",
  "g-action": "/discover/movie", "g-comedy": "/discover/movie", "g-scifi": "/discover/movie", "g-horror": "/discover/movie",
  "g-drama": "/discover/movie", kids: "/discover/movie", docs: "/discover/movie", anime: "/discover/tv",
};

// ---- categories, episodes, cache ----

test("the categories are TMDB's genres, movies first, each browsable as genre:<kind>:<id>", async () => {
  tmdbImpl = async (path) => path === "/genre/movie/list" ? { genres: [{ id: 28, name: "Acción" }] } : { genres: [{ id: 10759, name: "Action & Adventure" }] };
  const cats = await plugin.categories();
  assert.deepEqual(cats.map((c) => c.ref), ["genre:movie:28", "genre:tv:10759"]);
  assert.equal(new Set(cats.map((c) => c.id)).size, cats.length);
});

test("the episodes carry the TMDB id in their refs, which is what resolve needs", async () => {
  metaImpl = async (q) => (q.ids.tmdb === 1396 ? { title: "Breaking Bad", ids: { tmdb: 1396 }, episodes: [{ season: 1, number: 1, title: "Pilot" }, { season: 2, number: 5, title: "Breakage" }] } : null);
  const out = await plugin.episodes("s:1396");
  assert.deepEqual(out.episodes.map((e) => e.ref), ["ep:1396:1:1", "ep:1396:2:5"]);
  await assert.rejects(() => plugin.episodes("s:5"), (e) => e.code === "not_found");
});

test("the cache action empties only the cached titles", async () => {
  kino.storage.set("show:1", "{}"); kino.storage.set("movie:2", "{}"); kino.storage.set("other", "{}");
  assert.equal((await plugin.action("clearCache")).message, "Caché de títulos vaciada.");
  assert.deepEqual([...store.keys()], ["other"]);
});
