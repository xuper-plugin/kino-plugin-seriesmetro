export function slugify(title) {
  return String(title || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function slugCandidates(titles, year) {
  titles = titles || {};
  const out = [];
  for (const t of [titles.esMX, titles.esES, titles.original, titles.en]) {
    const s = slugify(t);
    if (!s) continue;
    for (const v of year ? [s, `${s}-${year}`] : [s]) if (!out.includes(v)) out.push(v);
  }
  return out;
}
