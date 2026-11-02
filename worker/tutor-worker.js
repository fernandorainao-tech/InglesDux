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
const MAX_AUDIO_B64 = 3_000_000;         // ~70 s de WAV 16 kHz mono en base64 (la app corta a 60 s)
const AUDIO_TYPES = ["audio/wav", "audio/mp3", "audio/aac", "audio/ogg", "audio/flac"];   // formatos que acepta Gemini
// Instrucción que acompaña cada nota de voz: transcribir primero (para mostrarla en el chat) y luego responder
const VOICE_HINT = `[El alumno envió una nota de voz.]
1) En la primera línea escribe exactamente lo que dijo, así: "TRANSCRIPCIÓN: <lo que dijo>". Si no se entiende nada, escribe "TRANSCRIPCIÓN: (no se entendió)" y pídele con cariño que lo repita.
2) Luego responde como tutor. Si habló en inglés, comenta en una o dos líneas su pronunciación: qué sonó bien y qué sonido mejorar, con la pronunciación figurada.`;

// Las instrucciones viven en el servidor: el alumno no puede modificarlas desde el navegador.
const SYSTEM = `Eres "Dux", el tutor de inglés de la app InglesDux. Tus alumnos son hispanohablantes de Chile, principiantes, que estudian con el libro "Inglés Básico" de C. K. Ogden y Augusto Ghio (Basic English de 850 palabras).

Cómo enseñas:
- Eres amable, paciente y motivador. Celebra los avances con naturalidad, sin exagerar.
- Explica en español sencillo y usa ejemplos cortos en inglés, preferentemente con vocabulario básico.
- Cuando des una palabra o frase en inglés, agrega su pronunciación figurada entre paréntesis, como en el libro. Ej.: "house (jáus)".
- Si el alumno escribe en inglés con errores, primero reconoce lo que hizo bien, luego muestra la versión correcta y explica el error en una línea.
- Para practicar conversación: escribe en inglés simple, una o dos frases por turno, y agrega la traducción entre paréntesis si el alumno parece perdido. Termina con una pregunta para que siga la conversación.
- Respuestas breves (máximo ~120 palabras) salvo que pidan más detalle. Usa listas solo si ayudan.
- Escribe SIEMPRE cada palabra o frase en inglés entre *asteriscos simples* (cursiva), y nunca pongas español dentro: la app lee en voz alta lo que está en cursiva con voz en inglés.
- Formato permitido: **negritas**, *cursivas* y saltos de línea. No uses tablas ni encabezados.

Límites:
- Mantente en temas de aprendizaje del inglés. Si piden otra cosa, redirige con amabilidad a practicar inglés.
- Contenido siempre apropiado para todas las edades.
- No inventes reglas: si algo tiene excepciones, dilo.`;

// ---------- Charlas cotidianas (roleplay) ----------
// Los escenarios viven aquí (no en la app) para que nadie pueda inyectar instrucciones propias.
const RP_TURNS = 5;   // intercambios por misión: corto = pocos tokens
const SCENARIOS = {
  cafe:        { scene: "a small coffee shop called Sunny Café", role: "Sam, a friendly barista", goal: "order a drink (and maybe something to eat) and pay", opening: "Hi there! Welcome to Sunny Café. What can I get for you today?" },
  vecino:      { scene: "the hallway of an apartment building", role: "Ana, a friendly new neighbor", goal: "greet the neighbor, say their name, say where they live and make small talk", opening: "Oh, hello! I am Ana, your new neighbor. I live in apartment 5. And you?" },
  tienda:      { scene: "a clothes shop", role: "Leo, a helpful shop assistant", goal: "ask for a shirt, say the size and color, and ask the price", opening: "Good morning! Can I help you find something today?" },
  indicaciones:{ scene: "a street in a city center", role: "a kind local person walking by", goal: "ask how to get to the train station and understand the directions", opening: "Hello! You look a little lost. Can I help you?" },
  restaurante: { scene: "a family restaurant", role: "Mia, a friendly waiter", goal: "order food and a drink, and ask for the bill", opening: "Good evening! Here is the menu. Are you ready to order?" },
  hotel:       { scene: "the front desk of a hotel", role: "Tom, a hotel receptionist", goal: "check in with a reservation: give their name, number of nights and ask about breakfast", opening: "Good afternoon and welcome to the Blue Sea Hotel! Do you have a reservation?" },
  farmacia:    { scene: "a pharmacy", role: "Dr. Lee, a kind pharmacist", goal: "explain they have a headache and buy medicine, asking how to take it", opening: "Hello! How can I help you today?" },
  aeropuerto:  { scene: "an airport check-in desk", role: "Kate, an airline agent", goal: "check in for a flight: show the passport, check a bag and ask for a window seat", opening: "Good morning! Where are you flying today? May I see your passport, please?" },
};
function rpSystem(sc, name) {
  return `You are role-playing inside InglesDux, an English practice app for Spanish-speaking beginners from Chile.
Scene: ${sc.scene}. You are ${sc.role}. The learner${name ? " (" + name + ")" : ""} must: ${sc.goal}.
Rules:
- Stay in character at all times. Speak ONLY simple English (beginner level, Basic English words), 1 or 2 short sentences per turn.
- End each turn with a short question that moves the scene toward the learner's goal.
- After your English line, write a new line that starts with "ES: " and the Spanish translation of what you said.
- If the learner writes in Spanish or makes mistakes, stay in character, understand them and naturally use the correct English phrase in your reply.
- If the learner goes off topic, gently bring them back to the scene. Content must be appropriate for all ages.
- No markdown, no lists, no emojis.`;
}
const RP_FINAL = `[This is the learner's LAST turn of the mission.]
1) Reply in character with ONE short closing line, then the "ES: " line.
2) Then write a line that starts with "FEEDBACK:" followed by feedback IN SPANISH for the learner (max 70 words): congratulate them, say 1 or 2 things they did well and 1 or 2 corrections, writing the correct English in *asterisks*.
3) Finally write a line "ESTRELLAS: n" where n is 1, 2 or 3 depending on how well they communicated and reached the goal.`;

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

    // Charla cotidiana: escenario elegido por id, saludo inicial del personaje y tope de turnos
    const sc = typeof body.scenario === "string" ? SCENARIOS[body.scenario] : null;
    if (body.scenario && !sc) return json({ error: "Escenario desconocido" }, 400, h);
    let rpFinal = false;
    if (sc) {
      const turns = msgs.filter(m => m.role === "user").length;
      if (turns > RP_TURNS) return json({ error: "La misión ya terminó" }, 400, h);
      rpFinal = turns === RP_TURNS;
      contents.unshift({ role: "user", parts: [{ text: "(Start the scene.)" }] }, { role: "model", parts: [{ text: sc.opening }] });
      if (rpFinal) contents[contents.length - 1].parts.push({ text: RP_FINAL });
    }

    // Nota de voz: reemplaza el texto del último mensaje del alumno por el audio + la instrucción
    const audio = body.audio;
    if (audio) {
      if (!AUDIO_TYPES.includes(audio.mime) || typeof audio.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(audio.data.slice(0, 200)))
        return json({ error: "Formato de audio no válido" }, 400, h);
      if (audio.data.length > MAX_AUDIO_B64) return json({ error: "La nota de voz es muy larga" }, 413, h);
      contents[contents.length - 1].parts = [{ inline_data: { mime_type: audio.mime, data: audio.data } }, { text: VOICE_HINT }];
    }

    const name = typeof body.name === "string" ? body.name.slice(0, 40).replace(/[^\p{L}\p{N} .'-]/gu, "") : "";
    const system = sc ? null : (name ? `${SYSTEM}\n\nEl alumno se llama ${name}.` : SYSTEM);

    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system || rpSystem(sc, name) }] },
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
    let text = parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("").trim();
    let heard = "";
    if (audio) {   // separar la transcripción de la respuesta
      const m = text.match(/^\s*\**TRANSCRIPCI[ÓO]N\**\s*:\s*(.*)$/im);
      if (m) { heard = m[1].replace(/^["“”*]+|["“”*]+$/g, "").trim(); text = text.replace(m[0], "").trim(); }
    }
    if (sc) {   // separar la línea final, la retroalimentación y las estrellas
      let feedback = "", stars = 0;
      if (rpFinal) {
        const st = text.match(/^\s*\**ESTRELLAS\**\s*:\s*(\d)/im); if (st) { stars = Math.min(3, Math.max(1, +st[1])); text = text.replace(st[0], ""); }
        const fb = text.search(/^\s*\**FEEDBACK\**\s*:/im);
        if (fb >= 0) { feedback = text.slice(fb).replace(/^\s*\**FEEDBACK\**\s*:\s*/i, "").trim(); text = text.slice(0, fb).trim(); }
      }
      return json({ text: text || "Thank you! Have a nice day.", heard, done: rpFinal, feedback, stars: stars || (rpFinal ? 2 : 0), turnsLeft: RP_TURNS - msgs.filter(m => m.role === "user").length }, 200, h);
    }
    return json({ text: text || "Perdona, no alcancé a responder. ¿Me lo preguntas de nuevo?", heard }, 200, h);
  },
};
