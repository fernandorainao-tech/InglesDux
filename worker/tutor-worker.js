/**
 * InglesDux · Tutor IA — Cloudflare Worker (proxy hacia Google Gemini)
 *
 * Por qué existe: la app es pública en GitHub Pages. Si la API key estuviera en index.html,
 * cualquiera podría copiarla y agotar tu cuota gratuita. Aquí la key vive como secreto del Worker.
 *
 * Variables del Worker (Settings → Variables and Secrets):
 *   GEMINI_API_KEY   (Secret)  → tu key de aistudio.google.com/apikey
 *   ALLOWED_ORIGIN   (Text)    → https://fernandorainao-tech.github.io
 */
const MODEL = "gemini-3.5-flash-lite";   // rápido y económico (gemini-1.5-flash ya no existe). Alternativa: "gemini-3.5-flash"
const MAX_OUTPUT_TOKENS = 2048;          // holgado: en los modelos actuales el "razonamiento" interno también consume salida
const MAX_TURNS = 12;                    // solo se envían los últimos 12 mensajes
const MAX_CHARS = 1200;                  // límite por mensaje del alumno

// Las instrucciones viven en el servidor: el alumno no puede modificarlas desde el navegador.
const SYSTEM = `Eres "Dux", el tutor de inglés de la app InglesDux. Tus alumnos son hispanohablantes de Chile, principiantes, que estudian con el libro "Inglés Básico" de C. K. Ogden y Augusto Ghio (Basic English de 850 palabras).

Cómo enseñas:
- Eres amable, paciente y motivador. Celebra los avances con naturalidad, sin exagerar.
- Explica en español sencillo y usa ejemplos cortos en inglés, preferentemente con vocabulario básico.
- Cuando des una palabra o frase en inglés, agrega su pronunciación figurada entre paréntesis, como en el libro. Ej.: "house (jáus)".
- Si el alumno escribe en inglés con errores, primero reconoce lo que hizo bien, luego muestra la versión correcta y explica el error en una línea.
- Para practicar conversación: escribe en inglés simple, una o dos frases por turno, y agrega la traducción entre paréntesis si el alumno parece perdido. Termina con una pregunta para que siga la conversación.
- Respuestas breves (máximo ~120 palabras) salvo que pidan más detalle. Usa listas solo si ayudan.
- Formato permitido: **negritas**, *cursivas* y saltos de línea. No uses tablas ni encabezados.

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

    // Sanear historial (la app manda roles user/assistant) y convertir al formato de Gemini (user/model)
    const msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-MAX_TURNS);
    while (msgs.length && msgs[0].role !== "user") msgs.shift();   // la conversación debe empezar con el alumno
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Falta el mensaje del alumno" }, 400, h);
    const contents = msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content.slice(0, MAX_CHARS) }] }));

    const name = typeof body.name === "string" ? body.name.slice(0, 40).replace(/[^\p{L}\p{N} .'-]/gu, "") : "";
    const system = name ? `${SYSTEM}\n\nEl alumno se llama ${name}.` : SYSTEM;

    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
        }),
      });
    } catch {
      return json({ error: "No se pudo contactar al tutor" }, 502, h);
    }
    if (r.status === 429) return json({ error: "Se alcanzó el límite gratuito por ahora" }, 429, h);   // cuota de la capa gratis
    if (!r.ok) return json({ error: "El tutor no está disponible ahora", status: r.status }, 502, h);

    const data = await r.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("").trim();
    return json({ text: text || "Perdona, no alcancé a responder. ¿Me lo preguntas de nuevo?" }, 200, h);
  },
};
