/**
 * app/api/complete/route.js
 * ─────────────────────────────────────────────────────────────────
 * Replaces the ENTIRE client-side ProviderRegistry from the artifact
 * version. This is the fix for three separate problems the artifact
 * version could only work around:
 *
 *   1. CORS — this call is same-origin from the browser's point of
 *      view (your app calling its own /api/complete). The actual
 *      cross-origin calls to Anthropic/OpenAI/Poyo happen here,
 *      server-to-server, where CORS does not apply at all.
 *   2. The claude.ai-only "bridge" — gone. This works identically
 *      whether the request came from your dev machine, a Vercel
 *      preview URL, or production. No special environment required.
 *   3. Keys in the browser — gone. Every key below is read from
 *      process.env, set in Vercel's dashboard, never sent to the
 *      client in any response.
 *
 * Client usage (see MIGRATION-GUIDE.md for the matching callOnce):
 *   POST /api/complete
 *   { provider, model, system?, user, maxTokens?, search? }
 *   → { text } on success, { error } on failure (still HTTP 200 for
 *     application-level errors so the client's existing error-message
 *     handling works unchanged; use res.ok + a JSON error field rather
 *     than relying on status codes for retry logic already written
 *     client-side).
 * ─────────────────────────────────────────────────────────────────
 */

export const runtime = "nodejs"; // needed for some provider SDKs; safe default either way

async function callAnthropic({ model, system, user, maxTokens, search }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set on the server");
  const body = {
    model,
    max_tokens: maxTokens || 4000,
    messages: [{ role: "user", content: user }],
  };
  if (system) body.system = system;
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text.trim()) throw new Error("Claude returned no text");
  return text;
}

async function callOpenAI({ model, system, user, maxTokens }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set on the server");
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens || 4000 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
  const text = (data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("OpenAI returned no text");
  return text;
}

async function callPoyo({ model, system, user, maxTokens }) {
  const key = process.env.POYO_API_KEY2;
  if (!key) throw new Error("POYO_API_KEY2 not set on the server");
  // Poyo's /v1/messages endpoint is Claude-Messages-API-compatible: auth via
  // x-api-key (not Bearer), system as a top-level field, and content
  // returned as Anthropic-style blocks under data.content — not the OpenAI
  // choices[].message.content shape /v1/chat/completions uses.
  const body = { model, max_tokens: maxTokens || 4000, messages: [{ role: "user", content: user }] };
  if (system) body.system = system;

  const res = await fetch("https://api.poyo.ai/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Poyo HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const envelope = await res.json();
  if (envelope.code && envelope.code !== 200) throw new Error(`Poyo error code ${envelope.code}: ${envelope.message || ""}`);
  const text = (envelope.data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text.trim()) throw new Error("Poyo returned no text content");
  return text;
}

const HANDLERS = {
  bridge: callAnthropic, // "bridge" from the old client code now just means "Anthropic, server-side"
  anthropic: callAnthropic,
  openai: callOpenAI,
  poyo: callPoyo,
};

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { provider = "bridge", model, system, user, maxTokens, search } = body;
  if (!user) return Response.json({ error: "Missing 'user' field" }, { status: 400 });
  if (!model) return Response.json({ error: "Missing 'model' field" }, { status: 400 });

  const handler = HANDLERS[provider];
  if (!handler) return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });

  try {
    const text = await handler({ model, system, user, maxTokens, search });
    return Response.json({ text });
  } catch (e) {
    // Still HTTP 200 with an error field for provider/application-level
    // failures — lets existing client retry logic (askClaude's own
    // catch/retry) keep working unchanged, same pattern the artifact
    // version already used.
    return Response.json({ error: e.message || "Unknown error" });
  }
}
