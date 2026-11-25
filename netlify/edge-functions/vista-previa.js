/* Trasfondo Yucatán · vista previa al compartir
   Cuando WhatsApp, Facebook, X o Google piden una nota, se les entrega
   el título, el resumen y la foto de ESA nota (no la imagen general).
   A los visitantes normales no se les cambia nada. */
const BOTS = /facebookexternalhit|facebot|meta-externalagent|whatsapp|twitterbot|telegrambot|slackbot|linkedinbot|discordbot|pinterest|skypeuripreview|googlebot|google-inspectiontool|bingbot|applebot|embedly|redditbot|iframely|vkshare|yandex|duckduckbot|tumblr|viber|line-poker|snapchat|instagram/i;
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default async (request, context) => {
  try {
    const ua = request.headers.get("user-agent") || "";
    if (!BOTS.test(ua)) return;
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return;
    const api = `${url.origin}/.netlify/functions/api?r=og&c=${encodeURIComponent(parts[0])}&s=${encodeURIComponent(parts[1])}`;
    const r = await fetch(api, { headers: { "user-agent": "trasfondo-vista-previa" } });
    if (!r.ok) return;
    const n = await r.json();
    if (!n || !n.ok) return;
    const res = await context.next();
    if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
    const html = await res.text();
    const cut = html.indexOf("</head>");
    if (cut < 0) return new Response(html, res);
    let head = html.slice(0, cut);
    head = head
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(n.t)} · ${esc(n.name)}</title>`)
      .replace(/<meta\s+(?:property|name)="(?:description|og:[^"]+|twitter:[^"]+|article:[^"]+)"[^>]*>\s*/gi, "")
      .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");
    const tags = [
      `<meta name="description" content="${esc(n.d)}">`,
      `<link rel="canonical" href="${esc(n.url)}">`,
      `<meta property="og:type" content="article">`,
      `<meta property="og:site_name" content="${esc(n.name)}">`,
      `<meta property="og:locale" content="es_MX">`,
      `<meta property="og:title" content="${esc(n.t)}">`,
      `<meta property="og:description" content="${esc(n.d)}">`,
      `<meta property="og:url" content="${esc(n.url)}">`,
      `<meta property="og:image" content="${esc(n.img)}">`,
      `<meta property="og:image:alt" content="${esc(n.alt)}">`,
      n.pub ? `<meta property="article:published_time" content="${esc(n.pub)}">` : "",
      n.au ? `<meta property="article:author" content="${esc(n.au)}">` : "",
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${esc(n.t)}">`,
      `<meta name="twitter:description" content="${esc(n.d)}">`,
      `<meta name="twitter:image" content="${esc(n.img)}">`
    ].filter(Boolean).join("\n");
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    return new Response(head + tags + "\n" + html.slice(cut), { status: res.status, headers });
  } catch (e) {
    return;
  }
};

export const config = { path: "/:seccion/:nota" };
