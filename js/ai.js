/* ai.js — "describe it or snap it" food estimates. No DOM.
   Fuel has no server, so the call goes straight from the phone to the Claude API with
   the owner's own key. The key lives in its own localStorage slot (KEY_SLOT), never in
   the state record, so it is never part of a backup, a recovery copy, or an export.
   Plain fetch rather than the SDK: Fuel is deliberately build-free with no dependencies. */

export const KEY_SLOT = "fuel.aikey.v1";
export const MODEL = "claude-opus-5-5";
export const ENDPOINT = "https://api.anthropic.com/v1/messages";

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          emoji: { type: "string" },
          portion: { type: "string" },
          calories: { type: "integer" },
          protein: { type: "integer" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["name", "emoji", "portion", "calories", "protein", "confidence"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["items", "note"],
  additionalProperties: false,
};

const SYSTEM = `You estimate calories and protein for a personal food log.
The person lives in the US, shops at Trader Joe's, and often eats at Pret, Just Salad and Chipotle.
Split what they describe (or what is in the photo) into separate loggable items, one per distinct food or drink.
Assume realistic restaurant or home portions, not label-minimum servings; when a portion is ambiguous, pick the most likely one and say what you assumed in "portion".
When an item matches one of their known foods listed below, reuse that name and those exact numbers.
Calories and protein are for the whole portion eaten, as whole numbers. Use "low" confidence when a photo hides oils, sauces or portion size.
Keep "note" to one short sentence about the biggest uncertainty, or an empty string.`;

/** Pure: the request body, so tests can check it without a key or network. */
export function buildRequest({ text = "", image = null, known = [] }) {
  const knownList = known.slice(0, 60).map((k) => `- ${k.name}: ${k.calories} kcal, ${k.protein} g protein`).join("\n");
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  content.push({ type: "text", text: (text.trim() || "Estimate what is in this photo.") });
  return {
    model: MODEL,
    max_tokens: 4000,
    system: knownList ? `${SYSTEM}\n\nTheir known foods:\n${knownList}` : SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    fallbacks: "default",
    messages: [{ role: "user", content }],
  };
}

export function headers(key) {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2026-10-21",
    "anthropic-beta": "server-side-fallback-2026-07-01",
    // Required for any call made from a browser page; the key is the owner's own.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Pure: response JSON → { items, note } or a thrown, human-readable Error. */
export function parseResponse(json) {
  if (json?.stop_reason === "refusal") throw new Error("The estimate was declined. Try describing the food in words.");
  const block = (json?.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("No estimate came back. Try again.");
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { throw new Error("The estimate came back garbled. Try again."); }
  const items = (parsed.items || [])
    .filter((i) => i && i.name && Number.isFinite(i.calories))
    .map((i) => ({
      name: String(i.name).slice(0, 80),
      emoji: String(i.emoji || "🍽").slice(0, 4),
      portion: String(i.portion || "").slice(0, 80),
      calories: Math.max(0, Math.round(i.calories)),
      protein: Math.max(0, Math.round(i.protein || 0)),
      confidence: ["high", "medium", "low"].includes(i.confidence) ? i.confidence : "medium",
    }));
  if (!items.length) throw new Error("Couldn't find any food in that. Try adding a bit more detail.");
  return { items, note: String(parsed.note || "") };
}

export async function estimateFood({ key, text, image, known, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(ENDPOINT, { method: "POST", headers: headers(key), body: JSON.stringify(buildRequest({ text, image, known })) });
  } catch {
    throw new Error("Couldn't reach the AI service — check your connection.");
  }
  if (res.status === 401 || res.status === 403) throw new Error("The API key was rejected. Check it in Settings.");
  if (res.status === 429) throw new Error("Rate limited — wait a minute and try again.");
  if (res.status === 402 || res.status === 400) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    throw new Error(/credit|billing/i.test(msg) ? "Your API account is out of credit." : `The request was rejected${msg ? `: ${msg}` : ""}.`);
  }
  if (!res.ok) throw new Error(`The AI service had a problem (${res.status}). Try again.`);
  return parseResponse(await res.json());
}
