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
var MAX_PROBES = 8;
function titleSlugs(titles) {
  const out = [];
  for (const t2 of [titles && titles.esMX, titles && titles.esES, titles && titles.original, titles && titles.en]) {
    const s = slugify(t2);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
function pageSlugs(title) {
  const plain = titleSlugs(title && title.titles);
  const year = title && title.year;
  return year ? [...plain, ...plain.filter((s) => !s.endsWith("-" + year)).map((s) => s + "-" + year)] : plain;
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
  return firstHit(pageSlugs(title), async (slug) => {
    const r = await req(`${SITE}/pelicula/${slug}/`);
    if (!r.ok) return null;
    const html = r.text();
    return html.includes("trembed=") && accepted(html, title) ? html : null;
  });
}
async function episodeHit(title, req) {
  return firstHit(pageSlugs(title), async (slug) => {
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

// src/std/model.js
var MAX_SLIDES = 5;
var MAX_RAILS = 8;
var MAX_RAIL_ITEMS = 20;
var MAX_SLIDE_TEXT = 160;
var HTTPS = /^https:\/\//;
function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind };
  if (item.poster && HTTPS.test(item.poster)) out.poster = item.poster;
  if (item.backdrop && HTTPS.test(item.backdrop)) out.backdrop = item.backdrop;
  if (item.badges) out.badges = item.badges;
  if (item.rating !== void 0) out.rating = item.rating;
  if (item.year !== void 0) out.year = item.year;
  if (item.ids && item.ids.tmdb) out.ids = { tmdb: item.ids.tmdb };
  if (item.lang) out.lang = item.lang;
  if (item.adult === true) out.adult = true;
  return out;
}
var slidesOf = (rows) => pickSlides(rows, (item) => item.backdrop);
var posterSlidesOf = (rows) => pickSlides(rows, (item) => item.poster);
function slideText(overview, item = {}) {
  const text = typeof overview === "string" ? overview.trim() : "";
  if (text === "") return [item.year, item.rating ? "\u2605 " + item.rating : null].filter(Boolean).join(" \xB7 ");
  return text.length <= MAX_SLIDE_TEXT ? text : `${text.slice(0, MAX_SLIDE_TEXT - 1).trimEnd()}\u2026`;
}
function pickSlides(rows, pictureOf) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    for (const item of row.items || []) {
      if (out.length >= MAX_SLIDES) return out;
      const image = pictureOf(item);
      if (item.adult === true || seen.has(item.id) || !image || !HTTPS.test(image)) continue;
      seen.add(item.id);
      out.push({ id: item.id, ref: item.ref, kind: item.kind, title: item.title, image, text: slideText(item.overview, item) });
    }
  }
  return out;
}
var uniform = (items) => items.every((i) => i.backdrop) ? items : items.map(({ backdrop, ...rest }) => rest);
function railsOf(rows) {
  return rows.filter((r) => !r.hidden && r.items && r.items.length > 0).slice(0, MAX_RAILS).map((r) => ({
    id: r.id,
    title: r.title,
    ...r.titleEn ? { titleEn: r.titleEn } : {},
    ...r.ref ? { ref: r.ref } : {},
    items: uniform(r.items.slice(0, MAX_RAIL_ITEMS).map(cardOf))
  }));
}
function tabOf(page) {
  const rows = page && Array.isArray(page.rows) ? page.rows : [];
  const rails = railsOf(rows);
  if (rails.length === 0) return null;
  return { slides: slidesOf(rows), posterSlides: posterSlidesOf(rows), rails };
}
function playedKey(ref) {
  const m = /^(?:m|s|e):(\d{1,10})(?::|$)/.exec(String(ref || ""));
  return m ? `t:${m[1]}` : String(ref || "");
}
function recentOf(keys, tabs) {
  if (keys.length === 0) return [];
  const byKey = /* @__PURE__ */ new Map();
  for (const data of tabs) {
    for (const rail2 of data.rails) {
      for (const card of rail2.items) {
        const ks = [card.ref];
        if (card.ids && card.ids.tmdb) ks.push(`t:${card.ids.tmdb}`);
        for (const k of ks) if (!byKey.has(k)) byKey.set(k, card);
      }
    }
  }
  const out = [];
  const used = /* @__PURE__ */ new Set();
  for (const key of keys) {
    const card = byKey.get(key);
    if (card && !used.has(card.id)) {
      used.add(card.id);
      out.push(card);
    }
  }
  return out;
}

// src/std/strings.js
var WORDS = {
  watch: ["Ver", "Watch"],
  info: ["M\xE1s informaci\xF3n", "More info"],
  recent: ["Continuar viendo", "Continue watching"],
  search: ["Buscar", "Search"],
  searchHint: ["Buscar en {name}", "Search {name}"],
  failed: ["No se pudo cargar esta secci\xF3n. Revisa tu conexi\xF3n e int\xE9ntalo de nuevo.", "This section could not be loaded. Check your connection and try again."],
  retry: ["Reintentar", "Retry"],
  empty: ["A\xFAn no hay nada aqu\xED.", "Nothing here yet."],
  back: ["Atr\xE1s", "Back"],
  close: ["Cerrar", "Close"],
  settings: ["Ajustes", "Settings"],
  resultsTitle: ["Resultados: {q}", "Results: {q}"],
  resultsIn: ["En {name}", "In {name}"],
  resultsSearching: ["Buscando en {name}\u2026", "Searching {name}\u2026"],
  resultsFailed: ["{name} no respondi\xF3 esta vez.", "{name} did not answer this time."],
  noResults: ["No encontramos nada con esas palabras en tus plugins.", "Nothing in your plugins matched those words."],
  supportTv: ["Si te gusta mi trabajo, escan\xE9alo y ap\xF3yame", "If you like my work, scan it and support me"],
  support: ["Si te gusta mi trabajo, ap\xF3yame", "If you like my work, support me"],
  gateTitle: ["Necesitas el motor de reproducci\xF3n", "You need the playback engine"],
  gateText: [
    "{name} reproduce a trav\xE9s de Kino Resolver (gratis). Inst\xE1lalo una vez y sirve para este y para otros plugins de sitios.",
    "{name} plays through Kino Resolver (free). Install it once and it works here and in other site plugins."
  ],
  gateInstall: ["Instalar Kino Resolver", "Install Kino Resolver"]
};
var fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => vars && vars[k] != null ? String(vars[k]) : m);
function twin(key, field = "text", vars) {
  const [es, en] = WORDS[key];
  const pick = (i) => vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? v[i] : v]));
  return { [field]: fill(es, pick(0)), [field + "En"]: fill(en, pick(1)) };
}
var STRING_KEYS = Object.keys(WORDS);

// src/std/view.js
var SUPPORT_URL = "https://ko-fi.com/xuperplugins";
var RESOLVER_REPO = "xuper-plugin/kino-plugin-kino-resolver";
var POLL_MS = 1500;
function brand(cfg) {
  return {
    type: "Row",
    key: "brand",
    gap: 12,
    crossAxisAlignment: "center",
    children: [
      ...cfg.logo ? [{ type: "Image", key: "logo", url: cfg.logo, aspect: cfg.logoAspect || "1:1", fit: "contain", h: 32, alt: cfg.name, altEn: cfg.nameEn || cfg.name }] : [],
      { type: "Text", key: "name", style: "h4", text: cfg.name, textEn: cfg.nameEn || cfg.name }
    ]
  };
}
var tabBar = (tabs, active) => ({
  type: "TabBar",
  key: "tabs",
  divider: false,
  value: active,
  onChanged: "tab",
  tabs: tabs.map((t2) => ({ value: t2.id, label: t2.label, labelEn: t2.labelEn || t2.label }))
});
var iconButton = (key, icon, word, onPressed) => ({ type: "IconButton", key, icon, ...twin(word, "labelText"), ...twin(word, "tooltip"), onPressed });
var searchOpenOps = (tabsInBar) => [
  { hide: "close" },
  { hide: "brand" },
  { hide: "searchButton" },
  { hide: "settingsButton" },
  ...tabsInBar ? [{ hide: "tabs" }] : [],
  { show: "closeSearch" },
  { show: "q" },
  { focus: "q" }
];
var searchClosedOps = (tabsInBar) => [
  { hide: "closeSearch" },
  { hide: "q" },
  { clear: "q" },
  { show: "close" },
  { show: "brand" },
  { show: "searchButton" },
  { show: "settingsButton" },
  ...tabsInBar ? [{ show: "tabs" }] : []
];
var leaveButton = (cfg) => cfg.backArrow ? iconButton("close", "arrow_back", "back", { go: { close: true } }) : iconButton("close", "close", "close", { go: { close: true } });
function supportNode(device) {
  if (device === "tv") return { type: "QrImage", key: "donate", value: SUPPORT_URL, size: "large", ...twin("supportTv", "labelText") };
  return { type: "ElevatedButton", key: "donate", icon: "heart", ...twin("support", "labelText"), onPressed: { go: { url: { href: SUPPORT_URL } } } };
}
var bar = ({ leading, title, actions = [] }) => ({ type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false, leading, title, actions });
var railSkeleton = (n) => ({
  type: "Column",
  key: "skel" + n,
  gap: 8,
  children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 12, sizes: ["compact"], children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}c${i}`, flex: 1 })) },
    { type: "Row", gap: 12, sizes: ["medium", "expanded"], children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}w${i}`, flex: 1 })) }
  ]
});
var heroSkeleton = () => ({ type: "Skeleton", key: "heroSkeleton", shape: "block", height: { compact: 200, expanded: 320 } });
var titleOf = (s) => ({ ref: s.ref, kind: s.kind, id: s.id, title: s.title });
var withHeaders = (headers) => headers ? { headers } : {};
var slideNode = (s, headers) => ({
  type: "heroCard",
  key: "slide-" + s.id,
  h: { compact: 200, expanded: 240 },
  ...s.logo ? { logo: s.logo } : {},
  title: s.title,
  text: s.text,
  image: s.image,
  ...withHeaders(headers),
  buttons: [
    { type: "ElevatedButton", key: "watch-" + s.id, ...twin("watch", "labelText"), icon: "play", onPressed: { go: { play: titleOf(s) } } },
    { type: "TextButton", key: "info-" + s.id, ...twin("info", "labelText"), onPressed: { go: { title: titleOf(s) } } }
  ]
});
var hero = (slides, headers) => slides.length === 1 ? slideNode(slides[0], headers) : {
  type: "PageView",
  key: "hero" + slides.length,
  autoPlayMs: 6e3,
  children: slides.map((s) => slideNode(s, headers))
};
var rail = (r, key, words, headers) => ({
  type: "titleRail",
  key,
  ...words || { title: r.title, titleEn: r.titleEn || r.title },
  ...r.ref ? { ref: r.ref } : {},
  items: r.items,
  ...withHeaders(headers)
});
function browseView(cfg, { tab, data, recent, pending, failed, searching = false, device = "phone", own = null }) {
  const tv = device === "tv";
  const tabs = own ? [cfg.tabs[0]] : cfg.tabs;
  const active = tabs.some((t2) => t2.id === tab) ? tab : tabs[0].id;
  const withTabs = tabs.length > 1;
  const body = [];
  if (own) {
    body.push(...own);
  } else if (data) {
    const h = cfg.imageHeaders;
    if (data.slides.length > 0) body.push(hero(data.slides, h));
    if (recent.length > 0) body.push(rail({ items: recent }, "recent", twin("recent", "title"), h));
    for (const r of data.rails) body.push(rail(r, "rail-" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "_"), null, h));
    if (data.rails.length === 0) body.push({ type: "Text", key: "empty", ...twin("empty"), color: "muted" });
  } else if (failed) {
    body.push({ type: "MaterialBanner", key: "loadFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "retry" } });
  } else {
    body.push(heroSkeleton(), railSkeleton(1), railSkeleton(2), railSkeleton(3));
  }
  const isBanner = (n) => !!n && (n.type === "heroCard" || n.key === "heroSkeleton" || n.type === "PageView" && String(n.key).startsWith("hero"));
  const banner = body.length > 0 && isBanner(body[0]) ? body.shift() : null;
  const tabsInBar = tv && withTabs;
  const appBar = bar({
    leading: leaveButton(cfg),
    title: { type: "Row", key: "titleRow", gap: tabsInBar ? 24 : 8, crossAxisAlignment: "center", children: [
      { ...iconButton("closeSearch", "arrow_back", "back", { ui: searchClosedOps(tabsInBar), event: "searchClosed" }), hidden: true },
      brand(cfg),
      ...tabsInBar ? [tabBar(tabs, active)] : [],
      {
        type: "TextField",
        key: "q",
        hidden: true,
        flex: 1,
        kind: "search",
        maxLength: 200,
        ...twin("searchHint", "hintText", { name: [cfg.name, cfg.nameEn || cfg.name] }),
        onSubmitted: "search",
        trailingIcon: "search",
        ...twin("search", "trailingLabel"),
        onTrailingTap: "search"
      }
    ] },
    actions: [
      // barSearch: false (std 1.7.0): the plugin draws its own search field in its page instead of the bar's icon.
      ...cfg.barSearch ? [iconButton("searchButton", "search", "search", { ui: searchOpenOps(tabsInBar), event: "searchOpened" })] : [],
      iconButton("settingsButton", "settings", "settings", "openSettings")
    ]
  });
  return {
    type: "Scaffold",
    ...searching ? { onBack: { ui: searchClosedOps(tabsInBar), event: "searchClosed" } } : {},
    appBar,
    body: { type: "Column", key: "page", children: [
      ...withTabs && !tv ? [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(tabs, active)] }] : [],
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [...banner ? [banner] : [], { type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] }
    ] },
    ...pending ? { every: { ms: POLL_MS, event: "tick" } } : {}
  };
}
function resultsView(cfg, { q, order, names, pending, found, device = "phone" }) {
  const body = [];
  let shown = 0;
  order.forEach((repo, i) => {
    const name = [names[repo] || repo, names[repo] || repo];
    if (pending.includes(repo)) {
      body.push({ type: "Column", key: "wait-" + i, gap: 8, children: [{ type: "Text", key: "waitText-" + i, color: "muted", ...twin("resultsSearching", "text", { name }) }, railSkeleton(i)] });
      return;
    }
    const r = found.get(repo);
    if (!r || !r.ok) {
      body.push({ type: "Text", key: "failed-" + i, color: "muted", ...twin("resultsFailed", "text", { name }) });
      return;
    }
    if (!r.items.length) return;
    shown++;
    body.push(rail({ items: r.items }, "found-" + i, twin("resultsIn", "title", { name }), cfg.imageHeaders));
  });
  if (!pending.length && shown === 0 && order.some((r) => {
    const x = found.get(r);
    return x && x.ok;
  })) body.unshift({ type: "Text", key: "noResults", ...twin("noResults") });
  return {
    type: "Scaffold",
    appBar: bar({ leading: iconButton("back", "arrow_back", "back", "back"), title: { type: "Text", key: "resultsTitle", style: "h4", ...twin("resultsTitle", "text", { q }) } }),
    body: { type: "SingleChildScrollView", key: "results-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...pending.length ? { every: { ms: 1500, event: "tick" } } : {}
  };
}
function settingsView(cfg, device = "phone") {
  return {
    type: "Scaffold",
    appBar: bar({ leading: iconButton("back", "arrow_back", "back", "back"), title: brand(cfg) }),
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [
      ...cfg.hasSettings ? [{ type: "settings", key: "form" }, { type: "Divider", key: "supportDivider" }] : [],
      supportNode(device)
    ] }] }
  };
}
function gateView(cfg, device = "phone") {
  const name = [cfg.name, cfg.nameEn || cfg.name];
  return {
    type: "Scaffold",
    appBar: bar({ leading: leaveButton(cfg), title: brand(cfg) }),
    body: { type: "Column", key: "gate", mainAxisAlignment: "center", crossAxisAlignment: "center", padding: 24, gap: 16, children: [
      { type: "Text", key: "gateTitle", style: "h3", ...twin("gateTitle") },
      { type: "Text", key: "gateText", style: "p", ...twin("gateText", "text", { name }) },
      { type: "ElevatedButton", key: "installResolver", ...twin("gateInstall", "labelText"), onPressed: { go: { installPlugin: { repo: RESOLVER_REPO } } } },
      supportNode(device)
    ] }
  };
}

// src/std/metaCache.js
var KEY = "meta3";
var MAX = 160;
var CONCURRENCY = 3;
var OVERVIEW_MAX = 160;
var HTTPS2 = /^https:\/\//;
function makeMetaCache({ kino: kino2, titleOf: titleOf3 = (c) => c.title, typeOf = (c) => c.kind === "series" ? "series" : "movie", tmdbPictures = false, clock = { now: () => Date.now() } }) {
  const usable = () => {
    try {
      return typeof kino2.meta === "function" && kino2.meta.byTitle === true;
    } catch (_) {
      return false;
    }
  };
  let book = null;
  function read() {
    if (book) return book;
    try {
      const o = JSON.parse(kino2.storage.get(KEY) || "null");
      book = o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch (_) {
      book = {};
    }
    return book;
  }
  function write() {
    try {
      const ids = Object.keys(book);
      if (ids.length > MAX) for (const id of ids.slice(0, ids.length - MAX)) delete book[id];
      kino2.storage.set(KEY, JSON.stringify(book));
    } catch (_) {
    }
  }
  function known(id) {
    const e = read()[id];
    if (!e) return {};
    return {
      ...e.t > 0 ? { tmdb: e.t } : {},
      ...e.l && HTTPS2.test(e.l) ? { logo: e.l } : {},
      ...e.p && HTTPS2.test(e.p) ? { poster: e.p } : {},
      ...e.b && HTTPS2.test(e.b) ? { backdrop: e.b } : {},
      ...typeof e.o === "string" && e.o ? { overview: e.o } : {}
    };
  }
  const asked = (id) => Object.hasOwn(read(), id);
  function dress(cards) {
    return cards.map((c) => {
      const k = known(c.id);
      const poster = tmdbPictures && k.poster ? k.poster : null;
      if (!k.tmdb && !poster) return c;
      return { ...c, ...k.tmdb && !(c.ids && c.ids.tmdb) ? { ids: { ...c.ids || {}, tmdb: k.tmdb } } : {}, ...poster ? { poster } : {} };
    });
  }
  async function fill2(cards, budgetMs) {
    if (!usable()) return 0;
    const b = read();
    const end = clock.now() + budgetMs;
    let count = 0;
    let stop = false;
    const seen = /* @__PURE__ */ new Set();
    const todo = cards.filter((c) => {
      if (!c || typeof c.id !== "string" || seen.has(c.id) || Object.hasOwn(b, c.id) || c.ids && c.ids.tmdb && c.noLogo) return false;
      seen.add(c.id);
      return true;
    });
    let next = 0;
    const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
    const worker = async () => {
      while (!stop && next < todo.length && clock.now() < end) {
        const c = todo[next++];
        const year = c.year !== void 0 ? { year: c.year } : {};
        try {
          const a = await kino2.meta({ type: typeOf(c), title: titleOf3(c), ...year });
          b[c.id] = {
            t: a && a.ids && Number.isInteger(a.ids.tmdb) ? a.ids.tmdb : 0,
            l: str(a && a.logo, 2048),
            p: str(a && a.poster, 2048),
            b: str(a && a.backdrop, 2048),
            o: str(a && a.overview, OVERVIEW_MAX)
          };
          count++;
        } catch (e) {
          if (e && e.code === "rate_limited") stop = true;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (count > 0) write();
    return count;
  }
  return { known, asked, dress, fill: fill2, usable, tmdbPictures };
}

// src/std/index.js
var TAB_KEY = "browseTab";
var SNAP_PREFIX = "browse1:";
var SNAP_TTL_MS = 7 * 24 * 3600 * 1e3;
var SNAP_MAX = 20 * 1024;
var SNAPS_TOTAL = 96 * 1024;
var RECENT_KEY = "recent1";
var RECENT_MAX = 12;
var Q_MAX = 200;
var META_TICK_MS = 3e3;
var META_TICK_CARDS = 24;
var INFLIGHT_KEY = "std:inflight";
var INFLIGHT_STALE_MS = 18e3;
var MAX_META_TICKS = 10;
var DEFAULT_TABS = [{ id: "inicio", label: "Inicio", labelEn: "Home" }];
function makeStandardScreen({ kino: kino2, name, nameEn, logo = null, logoAspect = "1:1", needsResolver, hasSettings, tabs, loadTab, homeKey = null, titleOf: titleOf3, typeOf, tmdbPictures = false, imageHeaders = null, searchHere = null, page = null, barSearch = true, backArrow = true }) {
  const cfg = { name, nameEn, logo, logoAspect, imageHeaders, hasSettings: !!hasSettings, barSearch: barSearch !== false, backArrow: backArrow !== false, tabs: Array.isArray(tabs) && tabs.length > 0 ? tabs : DEFAULT_TABS };
  const TAB_IDS = cfg.tabs.map((t2) => t2.id);
  const meta = makeMetaCache({ kino: kino2, titleOf: titleOf3, typeOf, tmdbPictures });
  function slidesFromMeta(rails) {
    const out = [];
    for (const r of rails) {
      for (const c of r.items) {
        if (out.length >= MAX_SLIDES) return out;
        const k = meta.known(c.id);
        if (!k.backdrop || c.adult === true || out.some((x) => x.id === c.id)) continue;
        out.push({ id: c.id, ref: c.ref, kind: c.kind, title: c.title, image: k.backdrop, text: slideText(k.overview, c), ...k.logo ? { logo: k.logo } : {} });
      }
    }
    return out;
  }
  const enrich = (data) => {
    if (!data) return data;
    const own = data.slides.map((s) => {
      const k = meta.known(s.id);
      const image = tmdbPictures && k.backdrop ? k.backdrop : null;
      return k.logo || image ? { ...s, ...k.logo ? { logo: k.logo } : {}, ...image ? { image } : {} } : s;
    });
    const learned = own.length > 0 ? [] : slidesFromMeta(data.rails);
    return {
      // The site's own backdrops, else TMDB's, else the posters: every plugin has a hero.
      slides: own.length > 0 ? own : learned.length > 0 ? learned : data.posterSlides || [],
      rails: data.rails.map((r) => ({ ...r, items: meta.dress(r.items) }))
    };
  };
  const metaTicks = /* @__PURE__ */ new Map();
  const found = /* @__PURE__ */ new Map();
  const SOURCES_PER_TICK = 3;
  const asFound = (a, index) => ({
    ok: !!(a && a.ok),
    items: a && a.ok && Array.isArray(a.items) ? a.items.filter((x) => x && x.id && x.ref && x.title).slice(0, 40).map((x) => ({ ...x, id: ("p" + index + "~" + x.id).slice(0, 128), origin: a.repo })) : []
  });
  const memo = /* @__PURE__ */ new Map();
  const log = (...a) => {
    try {
      kino2.log("[std]", ...a);
    } catch (_) {
    }
  };
  const get = (k) => {
    try {
      return kino2.storage.get(k);
    } catch (_) {
      return null;
    }
  };
  const set = (k, v, opts) => {
    try {
      kino2.storage.set(k, v, opts);
    } catch (_) {
    }
  };
  function readSnap(tab) {
    try {
      const o = JSON.parse(get(SNAP_PREFIX + tab) || "null");
      return o && Date.now() - o.at < SNAP_TTL_MS && o.data && Array.isArray(o.data.rails) ? o.data : null;
    } catch (_) {
      return null;
    }
  }
  const snapMax = Math.min(SNAP_MAX, Math.floor(SNAPS_TOTAL / TAB_IDS.length));
  function writeSnap(tab, data) {
    for (let per = 10; per >= 3; per -= 2) {
      const slim = { slides: data.slides, posterSlides: data.posterSlides || [], rails: data.rails.map((r) => ({ ...r, items: r.items.slice(0, per) })) };
      const text = JSON.stringify({ at: Date.now(), data: slim });
      if (text.length <= snapMax) {
        set(SNAP_PREFIX + tab, text, { ttlMs: SNAP_TTL_MS });
        return;
      }
    }
  }
  function homeSeed(tab) {
    if (!homeKey || tab !== TAB_IDS[0]) return null;
    try {
      const o = JSON.parse(get(homeKey) || "null");
      return o && Array.isArray(o.rows) && o.rows.length ? tabOf({ rows: o.rows }) : null;
    } catch (_) {
      return null;
    }
  }
  const stored = () => {
    const t2 = get(TAB_KEY);
    return TAB_IDS.includes(t2) ? t2 : null;
  };
  function dataOf(tab) {
    if (memo.has(tab)) return memo.get(tab).data;
    const snap = readSnap(tab) || homeSeed(tab);
    if (snap) {
      memo.set(tab, { data: snap, whole: false });
      return snap;
    }
    return null;
  }
  const readKeys = () => {
    try {
      const a = JSON.parse(get(RECENT_KEY) || "[]");
      return Array.isArray(a) ? a.filter((k) => typeof k === "string") : [];
    } catch (_) {
      return [];
    }
  };
  function notePlayed(ref) {
    try {
      const key = playedKey(ref);
      if (key === "" || key.startsWith("x|")) return;
      const keys = readKeys();
      if (keys[0] === key) return;
      set(RECENT_KEY, JSON.stringify([key, ...keys.filter((k) => k !== key)].slice(0, RECENT_MAX)));
    } catch (_) {
    }
  }
  const tabFromArgs = (route) => {
    const a = route && route.args && typeof route.args === "object" ? route.args : {};
    return TAB_IDS.includes(a.tab) ? a.tab : null;
  };
  function needed(tab) {
    return memo.get(tab) && memo.get(tab).whole ? [] : [tab];
  }
  function screen2(ctx) {
    const c = ctx || {};
    const device = c.device || "phone";
    if (needsResolver && !(c.installed && c.installed[RESOLVER_REPO])) return gateView(cfg, device);
    if (c.route && c.route.name === "settings") return settingsView(cfg, device);
    if (searchHere && c.route && c.route.name === "results") {
      const st0 = c.state && typeof c.state === "object" ? c.state : {};
      return resultsView(cfg, {
        q: String(st0.rq || ""),
        order: Array.isArray(st0.rorder) ? st0.rorder : [],
        names: st0.rnames || {},
        pending: Array.isArray(st0.rpending) ? st0.rpending : [],
        found,
        device
      });
    }
    const st = c.state && typeof c.state === "object" ? c.state : {};
    const tab = TAB_IDS.includes(st.tab) ? st.tab : tabFromArgs(c.route) ?? stored() ?? TAB_IDS[0];
    const data = enrich(dataOf(tab));
    const loaded = TAB_IDS.map((t2) => memo.get(t2)).filter(Boolean).map((m) => m.data);
    const pending = Array.isArray(st.pending) && st.pending.length > 0;
    const searching = st.searching === true;
    if (page) {
      const tree = browseView(cfg, { tab: TAB_IDS[0], data: null, recent: [], pending: false, failed: false, searching, device, own: page.view({ ...c, state: st }) || [] });
      const every = page.every ? page.every({ ...c, state: st }) : null;
      return every ? { ...tree, every } : tree;
    }
    return browseView(cfg, { tab, data, recent: meta.dress(recentOf(readKeys(), loaded)), pending, failed: !!(st.failed && st.failed[tab]), searching, device });
  }
  function cutShort() {
    try {
      const o = JSON.parse(get(INFLIGHT_KEY) || "null");
      if (!o || typeof o.tab !== "string") return null;
      if (Date.now() - Number(o.at) < INFLIGHT_STALE_MS) return null;
      kino2.storage.remove(INFLIGHT_KEY);
      return o.tab;
    } catch (_) {
      return null;
    }
  }
  async function load(tab) {
    set(INFLIGHT_KEY, JSON.stringify({ tab, at: Date.now() }));
    let page2;
    try {
      page2 = await loadTab(tab);
    } finally {
      try {
        kino2.storage.remove(INFLIGHT_KEY);
      } catch (_) {
      }
    }
    const data = tabOf(page2);
    if (data) {
      memo.set(tab, { data, whole: true });
      writeSnap(tab, data);
    }
    return data !== null;
  }
  const events = {
    async open(ev) {
      if (page) {
        let patch = {};
        try {
          patch = (page.open ? await page.open(ev) : {}) || {};
        } catch (e) {
          log("page open", e && e.code || "error");
        }
        return { state: { ...patch, tab: TAB_IDS[0], pending: [], failed: null } };
      }
      return events.openTabs(ev);
    },
    openTabs({ route, state, device }) {
      const tab = tabFromArgs(route) ?? (TAB_IDS.includes(state.tab) ? state.tab : stored() ?? TAB_IDS[0]);
      for (const t2 of TAB_IDS) dataOf(t2);
      return { state: { tab, pending: needed(tab), failed: null } };
    },
    tab({ value, arg, state }) {
      const tab = TAB_IDS.includes(value) ? value : TAB_IDS.includes(arg) ? arg : null;
      if (!tab) return null;
      set(TAB_KEY, tab);
      dataOf(tab);
      const failed = { ...state.failed || {} };
      delete failed[tab];
      const pending = [tab, ...Array.isArray(state.pending) ? state.pending.filter((t2) => t2 !== tab) : []];
      return { state: { tab, pending: memo.get(tab) && memo.get(tab).whole ? pending.slice(1) : pending, failed } };
    },
    retry({ state }) {
      const tab = TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS[0];
      const queued = Array.isArray(state.pending) ? state.pending.filter((t2) => t2 !== tab) : [];
      return { state: { failed: null, pending: [tab, ...queued] } };
    },
    async tick({ state, route }) {
      if (searchHere && route && route.name === "results") {
        const rp = Array.isArray(state.rpending) ? state.rpending : [];
        if (rp.length === 0) return null;
        const batch = rp.slice(0, SOURCES_PER_TICK);
        const order = Array.isArray(state.rorder) ? state.rorder : [];
        let answers2 = [];
        try {
          answers2 = await searchHere.searchIn(String(state.rq || ""), batch);
        } catch (e) {
          log("results", (e && e.code || "error") + " " + String(e && e.message || "").slice(0, 200));
        }
        for (const repo of batch) {
          const a = (Array.isArray(answers2) ? answers2 : []).find((x) => x && x.repo === repo);
          found.set(repo, asFound(a, order.indexOf(repo)));
        }
        return { state: { rpending: rp.slice(SOURCES_PER_TICK) } };
      }
      const pending = Array.isArray(state.pending) ? state.pending : [];
      if (pending.length === 0) return null;
      const [next, ...rest] = pending;
      const failed = { ...state.failed || {} };
      if (next.startsWith("meta:")) {
        const tab = next.slice(5);
        const m = memo.get(tab);
        if (!m) return { state: { pending: rest } };
        const ask = (x) => ({ id: x.id, title: x.title, kind: x.kind, ...x.year !== void 0 ? { year: x.year } : {} });
        const noOwnSlides = m.data.slides.length === 0;
        const cards = [...m.data.slides.map(ask), ...m.data.rails.flatMap((r) => r.items.slice(0, noOwnSlides ? MAX_SLIDES * 3 : 6).map(ask))].filter((c) => !meta.asked(c.id)).slice(0, META_TICK_CARDS);
        const count = await meta.fill(cards, META_TICK_MS);
        const ticks = (metaTicks.get(tab) || 0) + 1;
        metaTicks.set(tab, ticks);
        const again = noOwnSlides && count > 0 && ticks < MAX_META_TICKS && slidesFromMeta(m.data.rails).length < MAX_SLIDES && cards.some((c) => !meta.asked(c.id));
        return { state: { pending: again ? [next, ...rest] : rest } };
      }
      if (cutShort() === next) {
        log("tab", next, "cut short by Kino last time");
        failed[next] = true;
        return { state: { pending: rest, failed } };
      }
      try {
        const ok = await load(next);
        if (!ok) failed[next] = true;
        else delete failed[next];
        if (ok && meta.usable()) rest.unshift("meta:" + next);
      } catch (e) {
        log("tab", e && e.code || "error");
        failed[next] = true;
      }
      return { state: { pending: rest, failed } };
    },
    // The words go to Kino's own search, with this plugin as the source; the bar is put back as it was, locally.
    // The search button's own event (after its local ops): while searching, the tree declares onBack, so Back closes the box.
    searchOpened() {
      return { state: { searching: true } };
    },
    // The box was closed (its arrow, or Back through onBack, already ran the local ops): the flag and the ops go, so the next
    // tree declares no onBack and draws the bar's defaults.
    searchClosed() {
      return { state: { searching: false, ui: null } };
    },
    async search({ value, state, device }) {
      const typed = value && typeof value === "object" ? value.q : value;
      const raw = typed != null && String(typed).trim() !== "" ? typed : state.inputs && state.inputs.q;
      const q = String(raw == null ? "" : raw).trim().slice(0, Q_MAX);
      if (!q) return null;
      const closed = searchClosedOps(device === "tv" && TAB_IDS.length > 1);
      if (searchHere) {
        let sources = [];
        try {
          sources = await searchHere.sources() || [];
        } catch (e) {
          log("sources", e && e.code || "error");
        }
        const order = sources.map((x) => x.repo).filter((r) => typeof r === "string");
        found.clear();
        return { route: { push: "results" }, ui: closed, state: {
          searching: false,
          ui: null,
          rq: q,
          rorder: order,
          rnames: Object.fromEntries(sources.map((x) => [x.repo, String(x.name || x.repo)])),
          rpending: order
        } };
      }
      return { go: { search: { q } }, ui: closed, state: { searching: false, ui: null } };
    },
    openSettings() {
      return { route: { push: "settings" }, state: { fromBrowse: true } };
    },
    back({ state, route }) {
      if (route && route.name === "settings" && !state.fromBrowse) return { close: true };
      return { route: { pop: true }, state: { fromBrowse: false } };
    }
  };
  async function screenEvent2(ev) {
    const e = ev || {};
    const name2 = e.name != null ? e.name : e.event;
    const own = page && page.events && typeof name2 === "string" && Object.hasOwn(page.events, name2) && !Object.hasOwn(events, name2) ? page.events[name2] : null;
    if (own) return await own({ ...e, state: e.state || {} }) ?? null;
    const handler = typeof name2 === "string" && name2 !== "openTabs" && Object.hasOwn(events, name2) ? events[name2] : null;
    return handler ? await handler({ ...e, state: e.state || {} }) ?? null : null;
  }
  return { screen: screen2, screenEvent: screenEvent2, notePlayed };
}

// src/logo.js
var LOGO = "data:image/png;base64,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";
var LOGO_ASPECT = "1:1";

// src/resolve-door.js
var HLS_MIME = "application/vnd.apple.mpegurl";
var RESOLVER_ALIAS = "resolver";
var CAPTURE_MS = 2e4;
function headersOf(s) {
  const out = {};
  if (s.referer) out.Referer = s.referer;
  const h = s.headers;
  if (Array.isArray(h)) for (const x of h) {
    if (x && x.name) out[x.name] = String(x.value);
  }
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) {
    if (v != null) out[k] = String(v);
  }
  return out;
}
function pickBest(streams) {
  return streams.find((s) => s && s.url && (s.kind === "hls" || /\.m3u8(\?|$)/i.test(s.url))) || streams.find((s) => s && s.url) || null;
}
async function captureStreams(kino2, embedUrl, referer) {
  const b = kino2 && kino2.browser;
  if (!b || typeof b.capture !== "function") return [];
  const opts = { timeoutMs: CAPTURE_MS, match: "\\.m3u8|\\.mp4" };
  if (referer) opts.headers = { Referer: referer };
  let cap;
  try {
    cap = await b.capture(embedUrl, opts);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const m of cap && cap.media || []) {
    if (!m || !m.url) continue;
    out.push({ url: m.url, kind: /\.m3u8(\?|$)/i.test(m.url) ? "hls" : "mp4", server: "browser", headers: m.headers || {} });
  }
  return out;
}
async function resolveViaHelper(embedUrl, kino2, referer, allowCapture = true) {
  let res = null;
  try {
    res = await kino2.plugins.call(RESOLVER_ALIAS, "resolve", { url: embedUrl, referer });
  } catch (err) {
    try {
      kino2.log("[seriesmetro]", "resolver", err && err.code || "call_failed");
    } catch (_) {
    }
  }
  let streams = res && Array.isArray(res.streams) ? res.streams.slice() : [];
  const subtitles = res && Array.isArray(res.subtitles) ? res.subtitles.filter((x) => x && x.lang && x.url) : [];
  let captured = false;
  const dead = !streams.length && res && res.error === "dead";
  if (!streams.length && !dead && (typeof allowCapture === "function" ? allowCapture() : allowCapture)) {
    streams = await captureStreams(kino2, embedUrl, referer);
    captured = streams.length > 0;
  }
  const s = pickBest(streams);
  if (!s) return null;
  const headers = headersOf(s);
  const isHls = s.kind === "hls" || /\.m3u8(\?|$)/i.test(s.url);
  return {
    url: s.url,
    mime: isHls ? HLS_MIME : /\.mp4(\?|$)/i.test(s.url) ? "video/mp4" : void 0,
    ...Object.keys(headers).length ? { headers } : {},
    ...captured ? { captured: true } : {},
    ...subtitles.length ? { subtitles } : {}
  };
}
async function resolverInstalled(kino2) {
  try {
    await kino2.plugins.call(RESOLVER_ALIAS, "normalizeHost", { url: "https://probe.invalid/" });
    return true;
  } catch (err) {
    return (err && err.code) !== "provider_missing";
  }
}

// src/std/catalog.js
var CATALOG_MAX = 40;
var OVERVIEW_MAX2 = 300;
var HTTPS3 = /^https:\/\//;
function catalogItems(found) {
  const out = [];
  const list = Array.isArray(found) ? found : found && Array.isArray(found.items) ? found.items : [];
  for (const it of list) {
    if (out.length >= CATALOG_MAX) break;
    if (!it || typeof it.id !== "string" || !it.id || typeof it.ref !== "string" || !it.ref || typeof it.title !== "string" || !it.title) continue;
    const item = { id: it.id, ref: it.ref, title: it.title, kind: typeof it.kind === "string" && it.kind ? it.kind : "movie" };
    if (typeof it.poster === "string" && HTTPS3.test(it.poster)) item.poster = it.poster;
    if (typeof it.backdrop === "string" && HTTPS3.test(it.backdrop)) item.backdrop = it.backdrop;
    if (it.year !== void 0 && it.year !== null && String(it.year)) item.year = String(it.year);
    if (typeof it.overview === "string" && it.overview.trim()) item.overview = it.overview.trim().slice(0, OVERVIEW_MAX2);
    const tmdb2 = it.ids && Number.isInteger(it.ids.tmdb) ? it.ids.tmdb : Number.isInteger(it.tmdb) ? it.tmdb : 0;
    if (tmdb2 > 0) item.tmdb = tmdb2;
    out.push(item);
  }
  return out;
}
function catalogQuery(arg) {
  const q = String(arg && arg.q || "").trim().slice(0, 200);
  const type = arg && (arg.type === "movie" || arg.type === "series") ? arg.type : "any";
  return { q, type, season: 0, episode: 0, tmdbId: 0, year: 0, originalTitle: "", altTitles: [], cursor: null };
}
function catalogDoor(search2) {
  return async (arg) => {
    const query = catalogQuery(arg);
    if (!query.q) return [];
    return catalogItems(await search2(query));
  };
}

// src/plugin.js
var tmdb = (path, params = {}) => kino.tmdb(path, { language: String(kino.lang || "").toLowerCase().startsWith("en") ? "en-US" : "es-MX", ...params });
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
    needResolver: "Para reproducir, abre SeriesMetro desde el men\xFA e instala el motor de reproducci\xF3n que te pedir\xE1.",
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
  const res = await tmdb(row.path, { ...row.path.startsWith("/discover") ? DISCOVER : {}, ...row.params || {} });
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
    const res = await tmdb("/search/tv", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "tv")), titlesOf(query));
  }
  if (type === "movie") {
    const res = await tmdb("/search/movie", { query: query.q });
    return kino.rank.filterRelevant((res?.results || []).map((r) => itemFromTmdb(r, "movie")), titlesOf(query));
  }
  const [movies, tv] = await Promise.all([
    tmdb("/search/movie", { query: query.q }),
    tmdb("/search/tv", { query: query.q })
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
  const res = await tmdb(path, params);
  const items = (res?.results || []).filter((r) => r.poster_path).map((r) => itemFromTmdb(r, kind));
  const next = res?.page < res?.total_pages ? String(page + 1) : void 0;
  return { items, next };
}
async function categories() {
  const [mg, tg] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
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
async function titleOf2(what) {
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
var MAX_CAPTURES = 1;
var CAPTURE_PAGE_MS = 23e3;
function takeCapture(budget) {
  if (!budget || budget.captures <= 0 || budget.deadline - Date.now() < CAPTURE_PAGE_MS) return false;
  budget.captures -= 1;
  return true;
}
async function answers(stream) {
  try {
    const r = await kino.fetch(stream.url, { headers: { ...stream.headers, Range: "bytes=0-2047" }, timeoutMs: 5e3, maxBytes: 2048 });
    if (r.status === 401 || r.status === 403) return true;
    if (!r.ok) return false;
    return !/\.m3u8(\?|$)/i.test(stream.url) || /^\s*#EXTM3U/.test(r.text() || "");
  } catch (e) {
    return !!(e && (e.code === "host_not_allowed" || e.code === "too_large" || e.code === "timeout"));
  }
}
async function open(c, budget) {
  try {
    const out = await resolveViaHelper(c.embedUrl, kino, SITE + "/", () => takeCapture(budget));
    if (!out || typeof out.url !== "string" || !out.url) {
      kino.log("[seriesmetro]", c.server, "no_stream");
      return null;
    }
    const stream = toStream(out, c);
    return out.captured || await answers(stream) ? stream : null;
  } catch (e) {
    kino.log("[seriesmetro]", c.server, e && e.code || "resolve_failed");
    return null;
  }
}
async function resolve(ref) {
  if (!await resolverInstalled(kino)) throw kino.error("unavailable", "resolver missing", { userMessage: t("needResolver") });
  const req = makeReq(kino, { deadline: Date.now() + RESOLVE_MS });
  const budget = { captures: MAX_CAPTURES, deadline: Date.now() + RESOLVE_MS };
  if (ref.startsWith("cp:")) {
    const want = parseCopyRef(ref);
    if (!want) throw kino.error("not_found", "bad copy ref");
    const copy = (await listCopies(await titleOf2(want.what), { req })).find((c) => c.lang === want.lang && c.server === want.server);
    const stream = copy ? await open(copy, budget) : null;
    if (!stream) throw kino.error("not_found", "copy not available: " + want.lang + "/" + want.server, { userMessage: t("noStreams") });
    return stream;
  }
  const what = parseRef(ref);
  if (!what) throw kino.error("not_found", "unknown ref: " + ref.slice(0, 40));
  const copies = ordered(await listCopies(await titleOf2(what), { req }));
  if (!copies.length) throw kino.error("not_found", "no copies for tmdb " + what.tmdbId, { userMessage: t("noStreams") });
  let main = null;
  let tried = 0;
  for (const c of copies) {
    tried++;
    main = await open(c, budget);
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
var std = null;
var standard = () => std ?? (std = makeStandardScreen({
  kino,
  name: "SeriesMetro",
  logo: LOGO,
  logoAspect: LOGO_ASPECT,
  needsResolver: true,
  hasSettings: true,
  tabs: [
    { id: "inicio", label: "Pel\xEDculas y series", labelEn: "Movies & series" }
  ],
  loadTab: async () => ({ rows: await home() })
}));
async function screen(ctx) {
  await null;
  return standard().screen(ctx && typeof ctx === "object" ? ctx : {});
}
async function screenEvent(ev) {
  await null;
  return standard().screenEvent(ev && typeof ev === "object" ? ev : {});
}
var proto_catalog_search = catalogDoor(search);
export {
  action,
  browse,
  categories,
  episodes,
  home,
  proto_catalog_search,
  resolve,
  screen,
  screenEvent,
  search
};
