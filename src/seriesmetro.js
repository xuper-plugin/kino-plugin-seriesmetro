// SeriesMetro: movies and series. /pelicula|serie/<slug>/; a series season list is an admin-ajax POST, an episode is its own
// page; every option is an iframe (?trembed=N) wrapping a player, its language in the option's label ("Fastream -Latino").
import { extractorFor } from "./extractors/index.js";
import { normLang } from "./util/lang.js";
import { slugify } from "./util/slug.js";

export const SITE = "https://www3.seriesmetro.net";
const MAX_OPTIONS = 8;
const AT_ONCE = 3; // Kino runs at most 6 fetches at once per plugin
/** Most candidate pages one lookup may try before giving up on the title. */
const MAX_PROBES = 4;

/** Distinct slugs of the title's names, in priority order (es-MX, es-ES, original, en). */
export function titleSlugs(titles) {
  const out = [];
  for (const t of [titles && titles.esMX, titles && titles.esES, titles && titles.original, titles && titles.en]) {
    const s = slugify(t);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Page years differ by one between the site and TMDB now and then; that much is tolerated. */
export function yearMatches(found, wanted) {
  if (!wanted || !found) return true;
  return Math.abs(Number(found) - Number(wanted)) <= 1;
}

/** An episode page's year against its show's run: anything from a year before the first season to a year after the last one. */
export function episodeYearOk(found, show) {
  if (!show || !show.year || found == null) return true;
  const first = Number(show.year);
  const last = Number(show.lastYear) || new Date().getFullYear();
  const y = Number(found);
  return y >= first - 1 && y <= Math.max(first, last) + 1;
}

const yearOnPage = (html) => {
  const m = /<span class="year[^"]*fa-calendar[^"]*">(\d{4})<\/span>/.exec(html);
  return m ? Number(m[1]) : null;
};

// A movie page shows its year (+-1); an episode page may show the episode's air year, so it is "inside the show's run".
const accepted = (html, title, episode = false) => {
  const found = yearOnPage(html);
  if (found == null) return !title.year;
  return episode ? episodeYearOk(found, title) : yearMatches(found, title.year);
};

/** The player options of a movie or episode page: [{ url (absolute trembed), label }]. */
export function options(html) {
  const labels = {};
  for (const m of html.matchAll(/href="#options-(\d+)"[\s\S]*?<span class="server">([\s\S]*?)<\/span>/g)) labels[m[1]] = m[2].replace(/\s+/g, " ").trim();
  const out = [];
  for (const m of html.matchAll(/<div id="options-(\d+)"[\s\S]*?<iframe[^>]*?(?:data-src|src)="([^"]*trembed=[^"]*)"/g)) {
    const url = m[2].replace(/&#0?38;|&amp;/g, "&");
    if (url.startsWith(SITE + "/") && labels[m[1]] != null) out.push({ url, label: labels[m[1]] });
  }
  return out;
}

// "Fastream -Castellano" -> server "Fastream", language "Castellano"; "-Latino" alone has no server name.
export const splitLabel = (label) => {
  const i = label.lastIndexOf("-");
  return i < 0 ? { server: "", lang: label } : { server: label.slice(0, i).trim(), lang: label.slice(i + 1).trim() };
};

/** The embed address behind each option: [{ url, server, lang }]. Network errors propagate only when every option failed. */
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
  // In batches of AT_ONCE, one batch after the other.
  const rows = [];
  for (let i = 0; i < opts.length; i += AT_ONCE) rows.push(...(await Promise.all(opts.slice(i, i + AT_ONCE).map(one))));
  const ok = rows.filter(Boolean);
  if (!ok.length && opts.length && failures.length === opts.length) throw failures[0]; // every option failed on the network
  return ok;
}

/** The first of [candidates] that [probe] answers with something; a spent deadline ends the hunt as "not found". */
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

// A series page shows no year, so the year is judged on the episode page it leads to.
async function episodeHit(title, req) {
  return firstHit(titleSlugs(title.titles), async (slug) => {
    const r = await req(`${SITE}/serie/${slug}/`);
    if (!r.ok) return null;
    const post = /data-post="(\d+)"/.exec(r.text());
    if (!post) return null;
    const list = await req(`${SITE}/wp-admin/admin-ajax.php`, {
      method: "POST", headers: { Referer: `${SITE}/serie/${slug}/` },
      body: { form: { action: "action_select_season", season: String(title.season), post: post[1] } },
    });
    if (!list.ok) return null;
    const wantS = Number(title.season), wantE = Number(title.episode);
    let href = null;
    for (const m of list.text().matchAll(/href="([^"]+\/capitulo\/[^"]+)"/g)) {
      const n = /temporada-(\d+)-capitulo-(\d+)/i.exec(m[1]);
      if (n && Number(n[1]) === wantS && Number(n[2]) === wantE) { href = m[1]; break; }
    }
    if (!href) return null;
    const ep = await req(href, { headers: { Referer: `${SITE}/serie/${slug}/` } });
    if (!ep.ok) return null;
    const html = ep.text();
    return html.includes("trembed=") && accepted(html, title, true) ? html : null;
  });
}

/**
 * The copies of a movie or an episode this plugin can open: `{ lang: "lat"|"esp"|"sub", server, embedUrl }` for every option on
 * a host an extractor knows. [title] is `{ kind: "movie"|"tv", titles: {esMX, esES, original, en}, year, lastYear, season,
 * episode }`. Empty when the site has no such page.
 */
export async function listCopies(title, { req }) {
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
    const known = lang ? extractorFor(row.url) : null;
    if (known && !out.some((c) => c.embedUrl === row.url)) out.push({ lang, server: known.name, embedUrl: row.url });
  }
  return out;
}
