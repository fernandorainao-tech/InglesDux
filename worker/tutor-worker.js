/**
 * InglesDux · Tutor IA — Cloudflare Worker (proxy hacia la API de Anthropic)
 *
 * Por qué existe: la app es pública en GitHub Pages. Si la API key estuviera en index.html,
 * cualquiera podría copiarla y gastar tu saldo. Aquí la key vive como secreto del Worker.
 *
 * Variables del Worker (Settings → Variables):
 *   ANTHROPIC_API_KEY  (Secret)  → tu key de console.anthropic.com
 *   ALLOWED_ORIGIN     (Text)    → https://fernandorainao-tech.github.io
 */
const MODEL = "claude-haiku-5-5";       // Haiku vigente (claude-3-5-haiku ya no está disponible)
const MAX_TOKENS = 700;                  // respuestas cortas = rápidas y baratas
const MAX_TURNS = 12;                    // solo se envían los últimos 12 mensajes
const MAX_CHARS = 1200;                  // límite por mensaje del alumno

// El system prompt vive en el servidor: el alumno no puede modificarlo desde el navegador.
const SYSTEM = `Eres "Dux", el tutor de inglés de la app InglesDux. Tus alumnos son hispanohablantes de Chile, principiantes, que estudian con el libro "Inglés Básico" de C. K. Ogden y Augusto Ghio (Basic English de 850 palabras).

Cómo enseñas:
- Eres amable, paciente y motivador. Celebra los avances con naturalidad, sin exagerar.
- Explica en español sencillo y usa ejemplos cortos en inglés, preferentemente con vocabulario básico.
- Cuando des una palabra o frase en inglés, agrega su pronunciación figurada entre paréntesis, como en el libro. Ej.: "house (jáus)".
- Si el alumno escribe en inglés con errores, primero reconoce lo que hizo bien, luego muestra la versión correcta y explica el error en una línea.
- Para practicar conversación: escribe en inglés simple, una o dos frases por turno, y agrega la traducción entre paréntesis si el alumno parece perdido. Termina con una pregunta para que siga la conversación.
- Respuestas breves (máximo ~120 palabras) salvo que pidan más detalle. Usa listas solo si ayudan.
- Formato permitido: **negritas** y saltos de línea. No uses tablas ni encabezados.

Límites:
- Mantente en temas de aprendizaje del inglés. Si piden otra cosa, redirige con amabilidad a practicar inglés.
- Contenido siempre apropiado para todas las edades.
- No inventes reglas: si algo tiene excepciones, dilo.`;

function cors(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": origin === allowed ? origin : allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "https://fernandorainao-tech.github.io";
    const h = cors(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, h);
    if (origin !== allowed) return json({ error: "Origen no permitido" }, 403, h);   // solo tu app puede usarlo

    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400, h); }

    // Sanear historial: solo user/assistant, texto, recortado y alternado
    const msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-MAX_TURNS)
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();   // la API exige empezar con "user"
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Falta el mensaje del alumno" }, 400, h);

    const name = typeof body.name === "string" ? body.name.slice(0, 40).replace(/[^\p{L}\p{N} .'-]/gu, "") : "";
    const system = name ? `${SYSTEM}\n\nEl alumno se llama ${name}.` : SYSTEM;

    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: msgs }),
      });
    } catch {
      return json({ error: "No se pudo contactar al tutor" }, 502, h);
    }
    if (!r.ok) return json({ error: "El tutor no está disponible ahora", status: r.status }, 502, h);

    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return json({ text: text || "Perdona, no alcancé a responder. ¿Me lo preguntas de nuevo?" }, 200, h);
  },
};
