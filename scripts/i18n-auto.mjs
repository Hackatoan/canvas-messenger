#!/usr/bin/env node
// Reusable auto-localizer for content-heavy static pages.
// Translates visible text nodes + SEO meta/attrs IN PLACE via Gemini, protecting
// <script>/<style>/<code>/<pre> and never touching tags, ids, classes or scripts.
// Injects hreflang + a language switcher, fixes relative asset paths for
// /<locale>/ subdirs, and writes a hreflang sitemap. Config: i18n.config.json.
//   Usage: GEMINI_API_KEY=... node scripts/i18n-auto.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'i18n.config.json'), 'utf8'));
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const ORIGIN = cfg.origin;
const SRC = cfg.srcDir || 'public';
const LOCALES = cfg.locales;
const HREFLANG = { en: 'en', 'pt-br': 'pt-BR', es: 'es', fr: 'fr', de: 'de', vi: 'vi', th: 'th' };
const LABEL = { en: 'EN', es: 'ES', 'pt-br': 'PT', fr: 'FR', de: 'DE', vi: 'VI', th: 'TH' };
const LANGNAME = { es: 'Spanish', 'pt-br': 'Brazilian Portuguese', fr: 'French', de: 'German', vi: 'Vietnamese', th: 'Thai' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROTECT = /<(script|style|code|pre)\b[\s\S]*?<\/\1>/gi;   // never translate these
const hasLetter = (s) => /[A-Za-z]/.test(s);
const protect = (html) => { const blocks = []; const out = html.replace(PROTECT, (m) => `%%${blocks.push(m) - 1}%%`); return { out, blocks }; };
const restore = (html, blocks) => html.replace(/%%(\d+)%%/g, (m, i) => blocks[+i]);

async function translateBatch(strings, langName, code) {
  if (!strings.length) return [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const prompt = `Translate each string in this JSON array from English into ${langName} (locale "${code}").
Return ONLY a JSON array of the same length and order — exactly one translation per input string.
Rules:
- Natural, idiomatic for native speakers. This is a video-game website.
- Preserve leading/trailing whitespace of each string.
- Keep emoji, symbols (↓ ⬇ · — ✕ etc.), HTML entities (&nbsp; &amp; …) and any %%N%% tokens EXACTLY.
- Do NOT translate brand/proper names or technical tokens: ${(cfg.keepTerms || []).join(', ')}.
- If a string is only a number/symbol/token, return it unchanged.
Input:
${JSON.stringify(strings)}`;
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }) });
    const data = await res.json().catch(() => ({}));
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (txt) { try { const arr = JSON.parse(txt); if (Array.isArray(arr) && arr.length === strings.length) return arr; } catch {} }
    const s = data?.error?.status || res.status;
    console.warn(`    batch retry ${a} (${s})`);
    await sleep(s === 'RESOURCE_EXHAUSTED' ? 20000 : 2000 * a);
  }
  throw new Error('translateBatch failed');
}

// collect unique translatable English strings from a page
function collect(html) {
  const { out } = protect(html);
  const set = new Set();
  out.replace(/>([^<>]+)</g, (m, t) => { if (hasLetter(t)) set.add(t); return m; });
  const tm = out.match(/<title>([^<]+)<\/title>/i); if (tm && hasLetter(tm[1])) set.add(tm[1]);
  out.replace(/<meta\s+name="(?:description|keywords|twitter:title|twitter:description)"\s+content="([^"]*)"/gi, (m, c) => { if (hasLetter(c)) set.add(c); return m; });
  out.replace(/<meta\s+property="(?:og:title|og:description)"\s+content="([^"]*)"/gi, (m, c) => { if (hasLetter(c)) set.add(c); return m; });
  out.replace(/(?:placeholder|alt|aria-label)="([^"]*)"/gi, (m, v) => { if (hasLetter(v)) set.add(v); return m; });
  return [...set];
}

// apply value->translation map back to the page
function apply(html, map) {
  const { out, blocks } = protect(html);
  const tr = (v) => (map.has(v) && map.get(v) != null ? map.get(v) : v);
  let s = out
    .replace(/>([^<>]+)</g, (m, t) => (hasLetter(t) ? `>${tr(t)}<` : m))
    .replace(/<title>([^<]+)<\/title>/i, (m, t) => (hasLetter(t) ? `<title>${tr(t)}</title>` : m))
    .replace(/(<meta\s+name="(?:description|keywords|twitter:title|twitter:description)"\s+content=")([^"]*)(")/gi, (m, p, c, q) => `${p}${tr(c)}${q}`)
    .replace(/(<meta\s+property="(?:og:title|og:description)"\s+content=")([^"]*)(")/gi, (m, p, c, q) => `${p}${tr(c)}${q}`)
    .replace(/((?:placeholder|alt|aria-label)=")([^"]*)(")/gi, (m, p, v, q) => (hasLetter(v) ? `${p}${tr(v)}${q}` : m));
  return restore(s, blocks);
}

const pageUrl = (page, l) => `${ORIGIN}${l === 'en' ? '' : '/' + l}${page.urlPath}`;
const hreflangBlock = (page) => {
  const links = LOCALES.map((l) => `  <link rel="alternate" hreflang="${HREFLANG[l]}" href="${pageUrl(page, l)}" />`);
  links.push(`  <link rel="alternate" hreflang="x-default" href="${pageUrl(page, 'en')}" />`);
  return `\n  <!-- i18n:hreflang:start -->\n${links.join('\n')}\n  <!-- i18n:hreflang:end -->`;
};
const switcher = (page, cur) => {
  const items = LOCALES.map((l) => {
    const a = l === cur; const path = l === 'en' ? (page.urlPath || '/') : `/${l}${page.urlPath}`;
    return `<a href="${path}" hreflang="${HREFLANG[l]}" role="menuitem"${a ? ' aria-current="true"' : ''} style="${a ? 'color:#fff;font-weight:700;' : 'color:#8a8;'}text-decoration:none;">${LABEL[l]}</a>`;
  });
  return `\n<!-- i18n:switcher:start -->\n<div id="lang-switch" style="position:fixed;top:8px;right:10px;z-index:99999;font-family:system-ui,-apple-system,sans-serif"><button id="lang-btn" type="button" aria-label="Language" aria-haspopup="true" aria-expanded="false" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;background:rgba(6,10,6,.92);border:1px solid #1a3d1a;border-radius:999px;color:#8a8;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.5)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><ellipse cx="12" cy="12" rx="4" ry="9"/></svg></button><div id="lang-pop" role="menu" style="display:none;position:absolute;top:calc(100% + 8px);right:0;flex-direction:column;gap:8px;background:rgba(6,10,6,.95);border:1px solid #1a3d1a;border-radius:10px;padding:9px 12px;box-shadow:0 4px 16px rgba(0,0,0,.6);font-size:12px;white-space:nowrap">\n  ${items.join('\n  ')}\n</div></div>\n<script src="/assets/lang-switcher.js" defer></script>\n<!-- i18n:switcher:end -->`;
};
const strip = (h) => h
  .replace(/\s*<!-- i18n:hreflang:start -->[\s\S]*?<!-- i18n:hreflang:end -->/g, '')
  .replace(/\s*<!-- i18n:switcher:start -->[\s\S]*?<!-- i18n:switcher:end -->/g, '');
const inject = (html, page, cur) => html
  .replace('</head>', `${hreflangBlock(page)}\n</head>`)
  .replace(/(<body[^>]*>)/, `$1${switcher(page, cur)}`);

const tagCount = (h) => (h.match(/<[a-zA-Z!\/][^>]*>/g) || []).length;
const idList = (h) => JSON.stringify([...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// ---- run ----
const bases = {};
for (const page of cfg.pages) bases[page.file] = strip(readFileSync(join(ROOT, SRC, page.file), 'utf8'));

for (const page of cfg.pages) writeFileSync(join(ROOT, SRC, page.file), inject(bases[page.file], page, 'en'));
console.log('en    -> hreflang + switcher injected into source pages');

let drift = 0;
for (const loc of LOCALES.filter((l) => l !== 'en')) {
  for (const page of cfg.pages) {
    const src = bases[page.file];
    const map = new Map();
    const uniq = collect(src);
    const tr = await translateBatch(uniq, LANGNAME[loc], loc);
    uniq.forEach((v, i) => map.set(v, tr[i]));
    let out = apply(src, map);
    out = out.replace(/<html lang="en">/i, `<html lang="${loc}">`);
    if (cfg.baseHref) out = out.replace(/<head>/i, '<head>\n<base href="/">');
    out = out.replace(/\b(href|src)="(?!https?:|\/|#|data:|mailto:)([^"]+)"/g, (m, a, p) => `${a}="/${p}"`);
    // self-referential canonical + og:url for the localized page (both attr orders)
    const locUrl = pageUrl(page, loc);
    out = out.replace(/(<link\b[^>]*\brel="canonical"[^>]*\bhref=")[^"]*(")/i, `$1${locUrl}$2`)
             .replace(/(<link\b[^>]*\bhref=")[^"]*("[^>]*\brel="canonical")/i, `$1${locUrl}$2`)
             .replace(/(<meta\b[^>]*\bproperty="og:url"[^>]*\bcontent=")[^"]*(")/i, `$1${locUrl}$2`);
    // keep internal links in-locale (e.g. /play -> /<loc>/game.html)
    for (const [from, to] of Object.entries(cfg.internalLinks || {}))
      out = out.split(`href="${from}"`).join(`href="/${loc}${to}"`);
    if (tagCount(out) !== tagCount(src) || idList(out) !== idList(src)) { console.warn(`  ⚠ ${loc}/${page.file}: STRUCTURE DRIFT`); drift++; }
    out = inject(out, page, loc);
    const outPath = page.file === cfg.rootFile ? join(ROOT, `${SRC}/${loc}/index.html`) : join(ROOT, `${SRC}/${loc}/${page.file}`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out);
  }
  console.log(`${loc.padEnd(5)} -> ${cfg.pages.length} page(s)`);
  await sleep(1200);
}

const today = new Date().toISOString().slice(0, 10);
const urls = cfg.pages.flatMap((page) => LOCALES.map((l) => {
  const alts = LOCALES.map((x) => `    <xhtml:link rel="alternate" hreflang="${HREFLANG[x]}" href="${pageUrl(page, x)}"/>`).join('\n')
    + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(page, 'en')}"/>`;
  return `  <url>\n    <loc>${pageUrl(page, l)}</loc>\n    <lastmod>${today}</lastmod>\n${alts}\n  </url>`;
})).join('\n');
if (cfg.sitemap !== false) writeFileSync(join(ROOT, SRC, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`);
console.log(`sitemap -> ${cfg.sitemap === false ? 'skipped' : SRC + '/sitemap.xml'}\n${drift ? drift + ' page(s) drifted — inspect!' : 'Done. No structure drift.'}`);
