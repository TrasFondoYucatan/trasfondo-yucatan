/* Trasfondo Yucatán: API del administrador en Netlify Functions + Netlify Blobs.
   Rutas: /.netlify/functions/api?r=state|login|password|media|stats|track|ai
   IA: Google Gemini (plan gratuito). Variable de entorno GEMINI_API_KEY (y opcional GEMINI_MODEL). */
import { getStore } from "@netlify/blobs";
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash, randomUUID } from "node:crypto";

const DEFAULT_PASSWORD = process.env.ADMIN_PASSWORD || "TrasFondo2026";
const MAX_STATE = 4_000_000, MAX_MEDIA = 5_500_000, WEEK = 7 * 864e5;
const TYPES = /^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm|quicktime))$/;
const STAT_KEYS = ["views", "clicks", "imp", "time", "reads", "adimp", "adclk", "daily"];

const ORDER = ["merida", "yucatan", "politica", "seguridad", "nacional", "deportes", "entretenimiento", "opinion"];
const CATS = {merida:"Mérida", yucatan:"Yucatán", politica:"Política", seguridad:"Seguridad", nacional:"Nacional", deportes:"Deportes", entretenimiento:"Entretenimiento", opinion:"Opinión"};
const xe = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const iso = d => { const t = new Date(d); return isNaN(t) ? new Date().toISOString() : t.toISOString(); };
const text = (body, type) => new Response(body, { headers: { "Content-Type": type + "; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=600" } });
function baseOf(state, url) {
  const u = (state?.cfg?.site?.url || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/]+\.[^/]+/.test(u) ? u : url.origin;
}
function sitemap(state, base) {
  const arts = (state?.arts || []).filter(a => a.slug && a.c), rows = [], last = l => l.reduce((m, a) => { const d = a.mod || a.pub || ""; return d > m ? d : m; }, "");
  rows.push([base + "/", last(arts)]);
  ORDER.forEach(k => { const l = arts.filter(a => a.c === k); if (l.length) rows.push([`${base}/${k}`, last(l)]); });
  arts.forEach(a => rows.push([`${base}/${a.c}/${a.slug}`, a.mod || a.pub]));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    rows.map(([u, d]) => `  <url>\n    <loc>${xe(u)}</loc>\n    <lastmod>${iso(d)}</lastmod>\n  </url>`).join("\n") + "\n</urlset>\n";
}
function rss(state, base) {
  const name = String(state?.cfg?.site?.name || "Trasfondo Yucatán").replace(/Tras Fondo/g, "Trasfondo"), cats = { ...CATS, ...(state?.cfg?.cats || {}) };
  const items = [...(state?.arts || [])].filter(a => a.slug).sort((x, y) => new Date(y.pub) - new Date(x.pub)).slice(0, 30);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n<title>${xe(name)}</title>\n<link>${xe(base)}/</link>\n<description>${xe(state?.cfg?.seoDesc || "")}</description>\n<language>es-mx</language>\n<atom:link href="${xe(base)}/rss.xml" rel="self" type="application/rss+xml"/>\n` +
    items.map(a => { const u = `${base}/${a.c}/${a.slug}`; return `<item>\n<title>${xe(a.t)}</title>\n<link>${xe(u)}</link>\n<guid isPermaLink="true">${xe(u)}</guid>\n<pubDate>${new Date(a.pub || Date.now()).toUTCString()}</pubDate>\n<category>${xe(cats[a.c] || a.c)}</category>\n<description>${xe(a.l)}</description>\n</item>`; }).join("\n") + "\n</channel>\n</rss>\n";
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const store = () => getStore({ name: "trasfondo", consistency: "strong" });
const sha = s => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));
const hashPw = (pw, salt) => scryptSync(String(pw), salt, 64).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function secret(st) {
  let s = await st.get("secret");
  if (!s) { s = randomBytes(32).toString("hex"); await st.set("secret", s); }
  return s;
}
async function sign(st, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + createHmac("sha256", await secret(st)).update(body).digest("base64url");
}
async function authed(st, req) {
  const h = req.headers.get("authorization") || "", t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const good = createHmac("sha256", await secret(st)).update(body).digest("base64url");
  if (!same(sig, good)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.exp < Date.now()) return null;
    const auth = await st.get("auth", { type: "json" });
    if ((auth ? auth.v : 0) !== p.v) return null;
    return p;
  } catch { return null; }
}
async function checkPassword(st, pw) {
  const auth = await st.get("auth", { type: "json" });
  return { ok: auth ? same(hashPw(pw, auth.salt), auth.hash) : same(pw, DEFAULT_PASSWORD), auth };
}
async function readBody(req, max) {
  const len = +req.headers.get("content-length") || 0;
  if (len > max) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength > max ? null : buf;
}

/* ---------- IA: Google Gemini ---------- */
const GEMINI_KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODELS = () => [...new Set([process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"].filter(Boolean))];
const SYS_CHAT = "Eres el asistente del administrador del portal de noticias Trasfondo Yucatán (Mérida, Yucatán). Respondes en español de México, claro y breve (máximo 180 palabras), con recomendaciones concretas. Basa tus respuestas en las estadísticas del sitio que vienen en el contexto (lecturas, clics, tiempo de lectura, SEO, banners). Si un dato no está en el contexto, dilo; no inventes cifras. Puedes usar **negritas** y listas con guion. El nombre del medio es Trasfondo, siempre junto.";
const SYS_NOTA = "Eres redactor del portal de noticias Trasfondo Yucatán (Mérida, Yucatán). Redactas en español de México, con tono informativo y cercano, sin clickbait ni adjetivos exagerados. Usa EXCLUSIVAMENTE los datos que te dan: no inventes nombres, cifras, fechas, cargos ni declaraciones entre comillas. El nombre del medio es Trasfondo, siempre junto. Responde solo con el JSON pedido.";
async function gemini(sys, prompt, asJson) {
  const key = GEMINI_KEY(); if (!key) return { error: "sin_clave" };
  let last = "";
  for (const model of MODELS()) {
    /* primero sin "pensar" (más rápido y no corta la respuesta); si el modelo no lo acepta, sin esa opción */
    for (const think of [true, false]) {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 50000);
      try {
        const gc = { temperature: asJson ? 0.5 : 0.6, maxOutputTokens: 8192, ...(asJson ? { responseMimeType: "application/json" } : {}) };
        if (think) gc.thinkingConfig = /gemini-3/i.test(model) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gc })
        });
        clearTimeout(tm);
        if (res.status === 400 && think) { last = "modelo"; continue; }
        if (res.status === 404 || res.status === 400) { last = "modelo"; break; }
        if (res.status === 429) { last = "limite"; break; }
        if (res.status === 401 || res.status === 403) return { error: "clave" };
        if (!res.ok) { last = "http " + res.status; break; }
        const j = await res.json(), cand = j.candidates?.[0] || {};
        const out = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
        if (out && !(asJson && cand.finishReason === "MAX_TOKENS")) return { answer: out, model, cut: cand.finishReason === "MAX_TOKENS" };
        last = cand.finishReason === "MAX_TOKENS" ? "corto" : "vacio";
        if (think) continue; else break;
      } catch (e) { clearTimeout(tm); last = e.name === "AbortError" ? "tiempo" : "red"; break; }
    }
  }
  return { error: last || "error" };
}

export default async (req, context) => {
  const url = new URL(req.url), m = req.method, st = store(), p = url.pathname;
  const r = url.searchParams.get("r") || (p.endsWith("/sitemap.xml") ? "sitemap" : p.endsWith("/robots.txt") ? "robots" : p.endsWith("/rss.xml") ? "rss" : "");
  try {
    if (["sitemap", "robots", "rss"].includes(r) && m === "GET") {
      const state = await st.get("state", { type: "json" }), base = baseOf(state, url);
      const live = !!state?.cfg?.site?.live;
      if (r === "robots") return text(live ? `User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${base}/sitemap.xml\n` : "# Modo demostración: el sitio aún no se indexa\nUser-agent: *\nDisallow: /\n", "text/plain");
      if (r === "sitemap" && !live) return text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n', "application/xml");
      return r === "rss" ? text(rss(state, base), "application/rss+xml") : text(sitemap(state, base), "application/xml");
    }
    /* datos de una nota para la vista previa al compartir (WhatsApp, Facebook, X) */
    if (r === "og" && m === "GET") {
      const c = url.searchParams.get("c") || "", s = url.searchParams.get("s") || "";
      const state = await st.get("state", { type: "json" }), base = baseOf(state, url);
      const a = (state?.arts || []).find(x => x.c === c && x.slug === s);
      if (!a) return json({ ok: false }, 404);
      let img = String(a.img || "");
      if (!img || /^(idb:|data:)/i.test(img)) img = base + "/og.jpg";
      else if (img.startsWith("/")) img = base + img;
      else if (!/^https?:\/\//i.test(img)) img = base + "/og.jpg";
      const name = String(state?.cfg?.site?.name || "Trasfondo Yucatán").replace(/Tras Fondo/g, "Trasfondo");
      return new Response(JSON.stringify({ ok: true, t: a.seoT || a.t || "", d: a.seoD || a.l || "", img, alt: a.alt || a.t || "", url: `${base}/${a.c}/${a.slug}`, name, pub: a.pub || "", au: a.au || "" }),
        { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    }
    if (r === "state") {
      if (m === "GET") return json({ ok: true, state: (await st.get("state", { type: "json" })) || null });
      if (m === "PUT") {
        if (!(await authed(st, req))) return json({ error: "Sesión no válida" }, 401);
        const buf = await readBody(req, MAX_STATE); if (!buf) return json({ error: "Contenido demasiado grande" }, 413);
        const o = JSON.parse(Buffer.from(buf).toString("utf8"));
        if (!o || !Array.isArray(o.arts) || !o.cfg) return json({ error: "Formato no válido" }, 400);
        delete o.stats;
        /* si otra persona guardó mientras tanto, se avisa para combinar los cambios */
        const cur = await st.get("state", { type: "json" });
        const curRev = (cur && cur._rev) || 0;
        if (o._rev !== undefined && curRev && o._rev !== curRev) return json({ error: "conflicto", state: cur }, 409);
        o._rev = curRev + 1;
        await st.setJSON("state", o);
        return json({ ok: true, rev: o._rev });
      }
    }
    if (r === "login" && m === "POST") {
      const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "x", now = Date.now();
      const fails = (await st.get("fails", { type: "json" })) || {};
      for (const k in fails) { fails[k] = fails[k].filter(t => now - t < 15 * 60e3); if (!fails[k].length) delete fails[k]; }
      if ((fails[ip] || []).length >= 8) return json({ error: "Demasiados intentos. Espera 15 minutos." }, 429);
      const { password = "" } = await req.json().catch(() => ({}));
      const { ok, auth } = await checkPassword(st, password);
      if (!ok) { (fails[ip] = fails[ip] || []).push(now); await st.setJSON("fails", fails); await sleep(600); return json({ error: "Contraseña incorrecta" }, 401); }
      return json({ ok: true, token: await sign(st, { exp: now + WEEK, v: auth ? auth.v : 0 }), def: !auth });
    }
    if (r === "password" && m === "POST") {
      if (!(await authed(st, req))) return json({ error: "Sesión no válida" }, 401);
      const { current = "", next = "" } = await req.json().catch(() => ({}));
      const { ok, auth } = await checkPassword(st, current);
      if (!ok) { await sleep(600); return json({ error: "La contraseña actual no es correcta" }, 403); }
      if (String(next).length < 8 || String(next).length > 128) return json({ error: "La nueva contraseña debe tener al menos 8 caracteres" }, 400);
      const salt = randomBytes(16).toString("hex"), v = (auth ? auth.v : 0) + 1;
      await st.setJSON("auth", { salt, hash: hashPw(next, salt), v });
      return json({ ok: true, token: await sign(st, { exp: Date.now() + WEEK, v }) });
    }
    if (r === "media") {
      const id = url.searchParams.get("id") || "";
      if (m === "GET") {
        if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "No encontrado" }, 404);
        const f = await st.getWithMetadata("m/" + id, { type: "arrayBuffer" });
        if (!f) return json({ error: "No encontrado" }, 404);
        return new Response(f.data, { headers: { "Content-Type": f.metadata?.type || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "Netlify-CDN-Cache-Control": "public, durable, max-age=31536000, immutable" } });
      }
      if (!(await authed(st, req))) return json({ error: "Sesión no válida" }, 401);
      if (m === "POST") {
        const type = (req.headers.get("content-type") || "").split(";")[0].trim();
        if (!TYPES.test(type)) return json({ error: "Tipo de archivo no permitido" }, 415);
        const buf = await readBody(req, MAX_MEDIA); if (!buf) return json({ error: "El archivo pesa más de 5 MB" }, 413);
        const nid = randomUUID();
        await st.set("m/" + nid, buf, { metadata: { type } });
        return json({ ok: true, url: "/.netlify/functions/api?r=media&id=" + nid });
      }
      if (m === "DELETE" && /^[0-9a-f-]{36}$/.test(id)) { await st.delete("m/" + id); return json({ ok: true }); }
    }
    if (r === "stats" && m === "GET") {
      if (!(await authed(st, req))) return json({ error: "Sesión no válida" }, 401);
      return json({ ok: true, stats: (await st.get("stats", { type: "json" })) || {} });
    }
    if (r === "track" && m === "POST") {
      const buf = await readBody(req, 20_000); if (!buf) return json({ error: "Demasiado grande" }, 413);
      const ev = JSON.parse(Buffer.from(buf).toString("utf8")), stats = (await st.get("stats", { type: "json" })) || {};
      let n = 0;
      for (const k of STAT_KEYS) {
        const o = ev[k]; if (!o || typeof o !== "object") continue;
        stats[k] = stats[k] || {};
        for (const [key, val] of Object.entries(o)) {
          if (++n > 400 || !/^[\w-]{1,20}$/.test(key)) continue;
          const v = Math.max(0, Math.min(k === "time" ? 3600 : 200, Math.round(+val || 0)));
          if (v) stats[k][key] = (stats[k][key] || 0) + v;
        }
      }
      await st.setJSON("stats", stats);
      return json({ ok: true });
    }
    if (r === "ai") {
      if (!(await authed(st, req))) return json({ error: "Sesión no válida" }, 401);
      if (m === "GET") return json({ ok: true, ready: !!GEMINI_KEY(), provider: "Google Gemini" });
      if (m !== "POST") return json({ error: "Método no permitido" }, 405);
      const buf = await readBody(req, 60_000); if (!buf) return json({ error: "Demasiado grande" }, 413);
      const b = JSON.parse(Buffer.from(buf).toString("utf8")), mode = b.mode === "nota" ? "nota" : "chat";
      const q = String(b.question || "").slice(0, 8000);
      if (!q) return json({ error: "Falta la pregunta" }, 400);
      const prompt = mode === "nota" ? q : `Contexto del sitio (JSON):\n${JSON.stringify(b.context || {}).slice(0, 20000)}\n\nPregunta del editor: ${q}`;
      const out = await gemini(mode === "nota" ? SYS_NOTA : SYS_CHAT, prompt, mode === "nota");
      if (out.error) return json({ error: out.error }, out.error === "sin_clave" ? 503 : 502);
      return json({ ok: true, answer: out.answer, model: out.model, cut: !!out.cut });
    }
    return json({ error: "Ruta no encontrada" }, 404);
  } catch (e) {
    return json({ error: "Error del servidor" }, 500);
  }
};
