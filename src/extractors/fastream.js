import { miss, fileM3u8, findIn, pageText, pageExtras, HLS_MIME } from "./shared.js";

export const HOSTS = ["fastream.to"];

export async function extract(embedUrl, req, kino) {
  const html = await pageText(req, embedUrl, { Referer: "https://fastream.to/" }, kino, "fastream");
  if (html == null) return null;
  const url = findIn(html, (t) => fileM3u8(t, embedUrl));
  if (!url) return miss(kino, "fastream", "no playlist in page");
  return { url, mime: HLS_MIME, headers: { Referer: "https://fastream.to/" }, ...pageExtras(html, embedUrl) };
}
