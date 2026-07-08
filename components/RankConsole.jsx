"use client";
import "../lib/storage";
import React, { useState, useEffect, useRef } from "react";

/* ————————————————————————————————————————————————
   RANK CONSOLE v5 — full implementation of plan
   Phase 1: storage v3 + provider layer (refactored callOnce/askClaude/runLong)
   Phase 2: mode system (local vs online)
   Phase 3: insights extraction + expanded dashboard
   Phase 4: output export + full-page report
———————————————————————————————————————————————— */

// ============================================================================
// COLORS & STYLES
// ============================================================================
const C = {
  bg: "#0B1316", bgDeep: "#080E11", panel: "#111E23", panelUp: "#16262C", line: "#22363D", lineUp: "#2C444C",
  text: "#EAEFEB", dim: "#8DA0A3", faint: "#5A6D71",
  gold: "#E8B44C", goldDim: "#8a6f34", goldGlow: "#E8B44C22",
  teal: "#4FC3B8", tealDim: "#2b5f5a", coral: "#E4674F", green: "#7BC47F", greenDim: "#3d5f40",
};

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600&display=swap');
.rc-root { font-family:'Instrument Sans',sans-serif; -webkit-font-smoothing:antialiased; }
.rc-display { font-family:'Bricolage Grotesque',sans-serif; }
.rc-mono { font-family:'IBM Plex Mono',monospace; }
.rc-root ::selection { background:#E8B44C33; }
.rc-root input:focus, .rc-root textarea:focus { border-color:#E8B44C !important; box-shadow:0 0 0 3px #E8B44C1A; }
.rc-root button:focus-visible { outline:2px solid #E8B44C; outline-offset:2px; }
.rc-btn { transition: transform .12s ease, filter .12s ease, background .12s ease, border-color .12s ease, color .12s ease; }
.rc-btn:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.08); }
.rc-btn:not(:disabled):active { transform: translateY(0); }
.rc-card { transition: border-color .18s ease, transform .18s ease, box-shadow .18s ease; }
.rc-card-hover:hover { border-color:#2C444C; transform: translateY(-1px); box-shadow: 0 6px 24px -12px rgba(0,0,0,.55); }
.rc-tab { transition: color .15s ease, border-color .15s ease; }
.rc-fade { animation: rcfade .35s ease; }
@keyframes rcfade { from {opacity:0; transform:translateY(5px);} to {opacity:1; transform:none;} }
@keyframes rcpulse { 0%,100%{opacity:.45} 50%{opacity:1} }
.rc-pulse { animation: rcpulse 1.4s ease infinite; }
@keyframes rcgrow { from { width: 0; } }
.rc-grow { animation: rcgrow .8s cubic-bezier(.22,1,.36,1); }
@keyframes rcdash { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce){ .rc-fade,.rc-pulse,.rc-grow{animation:none;} }
.rc-scroll::-webkit-scrollbar{width:8px;height:8px} .rc-scroll::-webkit-scrollbar-thumb{background:#22363D;border-radius:4px}
.rc-scroll::-webkit-scrollbar-thumb:hover{background:#2C444C}
@media print {
  .rc-no-print { display: none !important; }
  .rc-print-only { display: block !important; }
  body { background: white; color: black; }
  .rc-root { background: white; color: black; }
}
`;

// ============================================================================
// PHASE 1: STORAGE v3 + PROVIDER LAYER
// ============================================================================

// ——————— Storage v3 schema ———————
const SKEY = "rank-console-v3";

async function loadState() {
  try {
    const r = await window.storage.get(SKEY);
    if (!r) return null;
    const data = JSON.parse(r.value);
    // Migrate v2 → v3 if needed
    if (!data.version || data.version < 3) {
      return migrateV2toV3(data);
    }
    return data;
  } catch { return null; }
}

function migrateV2toV3(data) {
  // v2 keys: ctx, baseline, current, notes, baselineLocked, status, outputs
  // → v3: wrap under mode slices, add settings, bump version
  return {
    version: 3,
    ctx: { ...data.ctx, businessMode: "local" },
    settings: {
      provider: "bridge", model: "claude-sonnet-4-6",
      keys: { anthropic: "", openai: "", poyo: "", fal: "", custom: { baseUrl: "", key: "", modelList: "" } },
      report: { includeGraphs: true, includeMockups: false },
    },
    local: { baseline: data.baseline || {}, current: data.current || {}, notes: data.notes || {},
      baselineLocked: !!data.baselineLocked, status: data.status || {}, outputs: data.outputs || {}, insights: {} },
    online: { baseline: {}, current: {}, notes: {}, baselineLocked: false, status: {}, outputs: {}, insights: {} },
  };
}

async function saveState(s) {
  try {
    s.version = 3;
    await window.storage.set(SKEY, JSON.stringify(s));
  } catch (e) { console.error(e); }
}

// ——————— Refactored AI interface (provider-agnostic) ———————
// Server-side route: /api/complete dispatches to the right provider using
// env-configured keys, so the browser never needs (or sees) a raw API key.
async function callOnce({ provider, model, system, user, maxTokens = 1000, search = false }) {
  const res = await fetch("/api/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, system, user, maxTokens, search }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data.text;
}

async function pingClaude(provider, model) {
  return callOnce({ provider, model, user: "Reply with exactly: OK", maxTokens: 1000 });
}

async function pingSearch() {
  // Genuinely exercises the web_search tool path (not just a duplicate
  // ping) — some artifact-bridge contexts accept plain requests but
  // reject the `tools` array outright, which is exactly what this needs
  // to detect so the UI can tell "AI only" from "AI + search" honestly.
  return callOnce({ provider: "bridge", model: "claude-sonnet-4-6", user: "OK", maxTokens: 1000, search: true });
}

async function askClaude({ provider, model, system, user, search = false, keys = {} }) {
  // Stash keys in global for the callOnce layer to use
  globalThis.__rcKeys = keys;
  // Only the bridge (and Anthropic direct, in principle) can attach the
  // web_search tool; for other providers the flag is meaningless.
  const canSearch = search && provider === "bridge";
  if (canSearch) {
    // BUG FIX: this branch previously never passed `search` to callOnce, so
    // "search-enabled" requests were silently identical to plain ones — the
    // model was asked to "research" with no research capability, which is
    // precisely the recipe for confidently fabricated business details.
    try { return await callOnce({ provider, model, system, user, maxTokens: 4000, search: true }); }
    catch (e1) {
      try { return await callOnce({ provider, model, system, user, maxTokens: 4000, search: true }); }
      catch (e2) {
        // Degrade honestly: run without search but TELL the model, so it
        // stops claiming verified facts and leaves unknowns blank.
        return await callOnce({
          provider, model, system: (system || "") + "\n\nNOTE: live web search is unavailable after all — you have NOT looked anything up. Report only what you genuinely know; leave anything unverifiable blank rather than guessing.",
          user, maxTokens: 4000,
        });
      }
    }
  }
  try { return await callOnce({ provider, model, system, user, maxTokens: 4000 }); }
  catch (e1) {
    try { return await callOnce({ provider, model, system, user, maxTokens: 4000 }); }
    catch (e2) {
      try { await pingClaude(provider, model); throw new Error(`Claude is reachable, but this request fails (${e2.message})`); }
      catch (e3) { throw new Error(`Claude API unreachable (${e2.message})`); }
    }
  }
}

function looksTruncated(chunk) {
  const t = chunk.trim();
  if (t.length < 2200) return false;
  if (t.length > 3200) return true;
  return !/[.!?:|"'\)\]’”]$/.test(t) && !/```$/.test(t);
}

async function runLong(opts) {
  const { provider, model, system, user, maxTokens = 4000, onProgress, search = false, keys = {} } = opts;
  let full = "";
  let nextUser = user;
  const maxParts = 3;
  for (let i = 0; i < maxParts; i++) {
    if (onProgress) onProgress(i + 1, maxParts);
    const out = await askClaude({ provider, model, system, user: nextUser, search: search && i === 0, keys });
    full += (full ? "\n\n" : "") + out.trim();
    if (!looksTruncated(out)) break;
    nextUser = `Continue the SAME deliverable from EXACTLY where you left off. Do not repeat anything already written, do not re-add headers you've already used, no new preamble — just the continuation.\n\nEnd of what's written so far:\n"""\n${full.slice(-900)}\n"""\n\nOriginal task, for reference only:\n${user}`;
  }
  return full;
}

const parseJSON = (t) => {
  const clean = t.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error("Response was truncated");
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch (e) { throw new Error(`Failed to parse JSON (${e.message})`); }
};

// ============================================================================
// AUTOFILL PROMPTS — grounded, anti-fabrication
// ============================================================================
// Why these exist: an earlier simplified autofill told the model to
// "research the business" with no research capability and no rule against
// guessing — so ambiguous names (e.g. "VectorSquid") got a confidently
// invented industry, services, even competitors. These prompts enforce the
// two rules that prevent that:
//   1. The NAME IS NOT EVIDENCE — what the business does may only come from
//      the actual website/search results, never inferred from the name.
//   2. BLANK BEATS PLAUSIBLE — any field that can't be verified is "".

const AUTOFILL_RULES = `HARD RULES — these override everything else:
1. NEVER fabricate. A blank "" field is a correct answer; a plausible-sounding guess is a failure that pollutes every downstream audit.
2. THE BUSINESS NAME IS NOT EVIDENCE. Do not infer the industry, services, or anything else from the name alone — many names are abstract or misleading. What the business does may only come from the actual website content or real search results. If you cannot establish what the business does from evidence, leave primaryService/niche/services/keywords "" — do not guess.
3. Never invent: addresses, phone numbers, URLs, review counts, star ratings, or competitor names. Only include competitors you actually found; blank entries beat invented ones.
4. Respond ONLY with a single compact JSON object — no prose, no markdown fences, no line breaks inside string values, every string under 25 words.
5. Include a "_notes" field (one sentence, under 25 words) stating what you verified vs what you left blank and why.`;

// ——— TWO-PHASE AUTOFILL (v5.1) ———
// Even with the rules above and live search, the model can still latch onto
// the WRONG entity — abstract names match unrelated results, and thin sites
// give search nothing to anchor on. The fix is a checkpoint, not a better
// guess: Phase 1 only answers "what IS this business?" and shows it to the
// user to confirm or correct; Phase 2 fills the fields with that confirmed
// identity injected as ground truth it must not contradict.

const IDENTIFY_SYS_LIVE = `You are a business researcher with live web search. Your ONLY job is to establish what one specific business actually is. Search the exact domain (use a site: query and the bare domain) and the business name. Read the results. Beware WRONG-ENTITY matches: other businesses with similar names, parked/for-sale domains, directories about a different company. Only report an identity supported by results clearly tied to THIS exact domain. If results are thin, conflicting, or about a different entity, say so via confidence:"low" and put what you saw in evidence. NEVER pad thin evidence into a confident-sounding summary. Respond ONLY with compact JSON, no prose, strings under 30 words.`;

const IDENTIFY_SYS_INFER = `You have NO live internet access. Your ONLY job is to state whether you genuinely, specifically know what one exact business is from training. For most businesses the honest answer is that you don't — return confidence:"none" with empty summary. The name alone is NOT evidence (an abstract name like "VectorSquid" tells you nothing). Respond ONLY with compact JSON, no prose, strings under 30 words.`;

const identifyPrompt = (name, site) => `Business name: "${name}". Website: ${site}.

Establish what this business actually is and does. Return ONLY:
{"summary":"1-2 plain sentences: what it does, for whom — from evidence only, else \\"\\"","offering":"its core product/service in a few words, else \\"\\"","audience":"who it serves, else \\"\\"","isLocal":"true/false/unknown — does it serve a physical area vs purely online","confidence":"high/medium/low/none","evidence":"what you actually found that ties to THIS domain (e.g. 'homepage title says X', 'GBP listing in Y'), else what you found instead","_notes":""}`;

const groundTruthBlock = (desc) => desc ? `CONFIRMED BUSINESS IDENTITY (verified by the owner — this is ground truth):
"${desc}"
Every field you fill MUST be consistent with this identity. If a search result contradicts it, the result is about the wrong entity — discard it. Use this identity (not the name) to derive services/niche/keywords.\n\n` : "";

const AUTOFILL_SYS_LIVE = `You are a business researcher with live web search. FIRST search for the website's actual domain and the business name to establish what this business really is and does — read the results before filling anything. Then search for its Google Maps/GBP listing (if it's a local business), review presence, and real competitors. Report only what you actually found in the search results. ${AUTOFILL_RULES}`;

const AUTOFILL_SYS_INFER = `You are a business analyst with NO live internet access — you cannot look anything up right now. Work only from what you genuinely, specifically know about this exact business from training. For most small businesses that is nothing, and the correct output is mostly-blank JSON. Only fill the industry/services if the name unambiguously states it (e.g. "Ridge Roofing Co" is roofing; an abstract name like "VectorSquid" tells you NOTHING and must not be interpreted). ${AUTOFILL_RULES}`;

const autofillPromptLocal = (name, site, live, desc) => `${groundTruthBlock(desc)}Business name: "${name}". Website: ${site}.
${live
  ? `Step 1 — search "${site.replace(/^https?:\/\//, "")}" and "${name}" to ${desc ? "gather details consistent with the confirmed identity above" : "establish what this business actually does (from results, not the name)"}. Step 2 — search for its Google Maps/GBP listing: address, phone, rating, review count. Step 3 — search "[its primary service] [its city]" to find up to 3 REAL competitors.`
  : `You cannot search. ${desc ? "Derive services/keywords from the confirmed identity above; leave every verifiable-fact field (address, phone, reviews, competitors) blank." : `Fill ONLY what you genuinely know about this specific business; otherwise leave fields "". Do not interpret the name.`}`}

Return ONLY this compact JSON (use "" for anything unverified):
{"address":"","phone":"","gbpUrl":"","primaryService":"","services":"comma-separated","areas":"comma-separated real areas served","keywords":"up to 5 local-intent keywords ONLY if the service+area are verified, else \\"\\"","reviewCount":"","starRating":"","reviewsPerMonth":"","biggestProblem":"one sentence, only if grounded in something you found, else \\"\\"","competitors":[{"name":"","gbpUrl":"","website":""},{"name":"","gbpUrl":"","website":""},{"name":"","gbpUrl":"","website":""}],"_notes":""}`;

const autofillPromptOnline = (name, site, live, desc) => `${groundTruthBlock(desc)}Business name: "${name}". Website: ${site}.
${live
  ? `Step 1 — search "${site.replace(/^https?:\/\//, "")}" and "${name}" to ${desc ? "gather details consistent with the confirmed identity above" : "establish what this business actually does and sells (from results, not the name)"}. Step 2 — search for its niche, target market, platforms, and trust profiles (Trustpilot/G2/app stores). Step 3 — find up to 3 REAL competitors in the same niche.`
  : `You cannot search. ${desc ? "Derive niche/productType/keywords from the confirmed identity above; leave every verifiable-fact field (platforms, trust profiles, competitors) blank." : `Fill ONLY what you genuinely know about this specific business; otherwise leave fields "". Do not interpret the name.`}`}

Return ONLY this compact JSON (use "" for anything unverified):
{"niche":"","productType":"","targetMarket":"","platforms":"","trustProfiles":"","keywords":"up to 5 keywords ONLY if the niche is verified, else \\"\\"","biggestProblem":"one sentence, only if grounded in something you found, else \\"\\"","competitors":[{"name":"","website":""},{"name":"","website":""},{"name":"","website":""}],"_notes":""}`;

// ============================================================================
// PHASE 2: MODE SYSTEM & DOMAIN CONFIG
// ============================================================================

// ——————— Score model: shared across modes ———————
const CATS_LOCAL = [
  { id: "gbpCats", label: "GBP categories", w: 1.2, phase: "GBP" },
  { id: "gbpAttrs", label: "GBP attributes", w: 0.8, phase: "GBP" },
  { id: "reviews", label: "Review velocity", w: 1.2, phase: "GBP" },
  { id: "responses", label: "Review responses", w: 0.7, phase: "GBP" },
  { id: "posts", label: "GBP posting", w: 0.7, phase: "GBP" },
  { id: "services", label: "Services + description", w: 0.8, phase: "GBP" },
  { id: "photos", label: "Photo signal", w: 0.6, phase: "GBP" },
  { id: "keywords", label: "Keyword coverage", w: 1.2, phase: "SITE" },
  { id: "onpage", label: "On-page quality", w: 1.1, phase: "SITE" },
  { id: "citypages", label: "City page stack", w: 0.9, phase: "SITE" },
  { id: "backlinks", label: "Backlink authority", w: 1.0, phase: "AUTH" },
  { id: "citations", label: "Citations + entity", w: 0.8, phase: "AUTH" },
];

const CATS_ONLINE = [
  { id: "keywords", label: "Keyword coverage", w: 1.2, phase: "VIS" },
  { id: "content", label: "Content depth & velocity", w: 1.0, phase: "VIS" },
  { id: "snippets", label: "SERP features & snippets", w: 0.8, phase: "VIS" },
  { id: "coreWeb", label: "Technical health / CWV", w: 0.9, phase: "VIS" },
  { id: "onpage", label: "On-page quality", w: 1.1, phase: "CONV" },
  { id: "landing", label: "Landing / offer pages", w: 1.0, phase: "CONV" },
  { id: "trust", label: "Trust signals & reviews", w: 1.0, phase: "CONV" },
  { id: "social", label: "Social proof & UGC", w: 0.7, phase: "CONV" },
  { id: "backlinks", label: "Backlink authority", w: 1.2, phase: "AUTH" },
  { id: "pr", label: "Digital PR & mentions", w: 0.9, phase: "AUTH" },
  { id: "entity", label: "Entity / schema & brand SERP", w: 0.8, phase: "AUTH" },
  { id: "owned", label: "Email / owned audience", w: 0.6, phase: "AUTH" },
];

const PHASES_LOCAL = [
  { id: "GBP", label: "Google Business Profile", color: C.gold },
  { id: "SITE", label: "Website", color: C.teal },
  { id: "AUTH", label: "Authority", color: C.green },
];

const PHASES_ONLINE = [
  { id: "VIS", label: "Visibility", color: C.teal },
  { id: "CONV", label: "Conversion", color: C.gold },
  { id: "AUTH", label: "Authority", color: C.green },
];

const weighted = (scores, phase, cats) => {
  let sum = 0, wsum = 0;
  cats.forEach((c) => {
    if (phase && c.phase !== phase) return;
    const v = scores?.[c.id];
    if (typeof v === "number") { sum += v * c.w; wsum += c.w; }
  });
  return wsum ? Math.round((sum / wsum) * 10) : 0;
};

// ——————— Empty context ———————
const emptyCtxLocal = {
  businessName: "", businessDescription: "", address: "", phone: "", website: "", gbpUrl: "",
  primaryService: "", services: "", areas: "", keywords: "",
  reviewCount: "", starRating: "", reviewsPerMonth: "", biggestProblem: "",
  competitors: [
    { name: "", gbpUrl: "", website: "" },
    { name: "", gbpUrl: "", website: "" },
    { name: "", gbpUrl: "", website: "" },
  ],
};

const emptyCtxOnline = {
  businessName: "", businessDescription: "", website: "", niche: "", productType: "", targetMarket: "",
  platforms: "", trustProfiles: "", biggestProblem: "",
  keywords: "", competitors: [
    { name: "", website: "" },
    { name: "", website: "" },
    { name: "", website: "" },
  ],
};

// ——————— Context block generation ———————
const ctxBlock = (c, mode) => {
  if (mode === "online") {
    return `ONLINE BUSINESS CONTEXT
Business: ${c.businessName || "[name]"} | Website: ${c.website || "[url]"}
What it does (owner-confirmed): ${c.businessDescription || "[not confirmed — do not assume from the name]"}
Niche: ${c.niche || "[niche]"} | Product/offer: ${c.productType || "[type]"}
Target market: ${c.targetMarket || "[geo or global]"}
Platforms: ${c.platforms || "[Shopify, Instagram, etc]"}
Trust profiles: ${c.trustProfiles || "[Trustpilot, G2, app-store URLs]"}
Keywords: ${c.keywords || "[keywords]"}
Biggest problem: ${c.biggestProblem || "[unknown]"}
Competitors:
${c.competitors.map((k, i) => `  ${i + 1}. ${k.name || "[name]"} — ${k.website || "[url]"}`).join("\n")}`;
  }
  // LOCAL mode (default)
  return `BUSINESS CONTEXT (single source of truth)
Business: ${c.businessName || "[business name]"}
What it does (owner-confirmed): ${c.businessDescription || "[not confirmed — do not assume from the name]"}
Address: ${c.address || "[address]"} | Phone: ${c.phone || "[phone]"}
Website: ${c.website || "[website]"} | GBP: ${c.gbpUrl || "[GBP URL]"}
Primary service: ${c.primaryService || "[primary service]"}
Other services: ${c.services || "[services]"}
Service areas: ${c.areas || "[cities]"}
Target keywords: ${c.keywords || "[keywords]"}
Reviews: ${c.reviewCount || "?"} total · ${c.starRating || "?"}★ · ${c.reviewsPerMonth || "?"} /month
Biggest problem: ${c.biggestProblem || "[unknown]"}
Competitors:
${c.competitors.map((k, i) => `  ${i + 1}. ${k.name || "[name]"} — GBP: ${k.gbpUrl || "[url]"} — Site: ${k.website || "[url]"}`).join("\n")}

WORKING RULES: prioritize quick wins; tag every recommendation High/Medium/Low impact with time-to-result; use tables for comparisons; say when unsure — never guess.`;
};

// ============================================================================
// MODULES (LOCAL MODE) — unchanged from v4
// ============================================================================

const MODULES_LOCAL = [
  {
    id: "gbpCats", grid: "GBP·01", title: "Category gap audit", depth: "public", cat: "gbpCats", merged: "prompt 1", phase: "GBP",
    what: "Map competitor primary + secondary categories against map-pack presence; get a ranked add-list.",
    runTask: (c) => `${ctxBlock(c, "local")}

Audit GBP categories: mine vs my competitors' listings for the searches ${c.keywords || "[keywords]"}. If you can search, look up each business's actual Maps/GBP listing and extract the real primary + secondary categories; anything you couldn't verify, fill from standard category structures for ${c.primaryService || "[service]"} businesses and mark it unverified.

Output: comparison table (business | primary | secondaries | verified?), then a ranked add-list for me — categories every strong competitor carries first (non-negotiable), then differentiation picks — each with impact H/M/L. If any rows were unverified, end with: "Run the GBP·01 Cowork prompt for the fully verified comparison."`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — GBP CATEGORY GAP AUDIT (tool-grade)
Open Chrome → Google Maps. Search "[service] in [city]" for: ${c.keywords || "[keywords]"}. Note map-pack competitors per search; open each GBP and extract primary + all secondary categories.
Spreadsheet, one tab per keyword: business, primary, secondaries, rating, reviews, position. Highlight categories I'm missing. Finish with the ranked add-list (all-3 → 2-of-3 → 1-of-3) with impact ratings.`,
  },
  {
    id: "gbpAttrs", grid: "GBP·02", title: "Attribute gap audit", depth: "public", cat: "gbpAttrs", merged: "prompt 2", phase: "GBP",
    what: "Every attribute tag across my listing + 3 competitors; three-tier gap list with CTR impact.",
    runTask: (c) => `${ctxBlock(c, "local")}

Audit GBP attributes: mine vs 3 competitors. Output: table attribute | me | c1 | c2 | c3 | verified?, then add-list with H/M/L impact.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — GBP ATTRIBUTE GAP AUDIT (tool-grade)
Open Chrome → GBP + 3 competitors. Extract every visible attribute. Gap-list with impact.`,
  },
  {
    id: "reviews", grid: "GBP·03", title: "Review teardown + sentiment engine", depth: "full", cat: "reviews", merged: "prompts 3+4+13", phase: "GBP",
    what: "Velocity, keyword mining, emotional-language analysis, and full response template system.",
    pasteLabel: "Optional: paste raw reviews",
    runTask: (c) => `${ctxBlock(c, "local")}

Analyze reviews. Produce: (1) VELOCITY, (2) SENTIMENT, (3) REVIEW ASK, (4) RESPONSES — templates, (5) REWRITES — homepage + GBP description in customer language.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — REVIEW TEARDOWN (tool-grade)
3 competitor GBPs, sentiment analysis, response templates, rewrites.`,
  },
  {
    id: "posts", grid: "GBP·04", title: "Posting pattern engine", depth: "full", cat: "posts", merged: "prompts 5+19", phase: "GBP",
    what: "Reverse-engineer competitor posting cadence, then generate an 8-week calendar written in full.",
    runTask: (c) => `${ctxBlock(c, "local")}

Build my 8-week GBP calendar, 2–3 posts/week. Weeks 1–4 in full, 5–8 outlined.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — GBP POSTING (tool-grade)
3 competitor GBPs, posting patterns, write weeks 1–4 in full.`,
  },
  {
    id: "services", grid: "GBP·05", title: "Services + description studio", depth: "full", cat: "services", merged: "prompts 6+7", phase: "GBP",
    what: "Optimized service descriptions plus 3 testable GBP descriptions.",
    runTask: (c) => `${ctxBlock(c, "local")}

Write: SERVICE DESCRIPTIONS, GBP DESCRIPTIONS × 3 versions (keyword/conversion/trust).`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — SERVICES + GBP DESCRIPTION (tool-grade)
Optimized descriptions + 3 GBP versions.`,
  },
  {
    id: "photos", grid: "GBP·06", title: "Photo velocity plan", depth: "public", cat: "photos", merged: "prompt 8", phase: "GBP",
    what: "8-week shot list to beat top velocity by 50%.",
    runTask: (c) => `${ctxBlock(c, "local")}

Build 8-week photo plan: upload count, shot list, naming, geotagging.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — GBP PHOTO (tool-grade)
8-week photo plan with shot lists, naming, geotagging.`,
  },
  {
    id: "keywords", grid: "SITE·01", title: "Keyword gap + intent map", depth: "public", cat: "keywords", merged: "prompts 9+16", phase: "SITE",
    what: "Gap analysis mapped to buyer-journey stage.",
    runTask: (c) => `${ctxBlock(c, "local")}

Build keyword universe: S1–S4 classification. Top 5 Stage-4 keywords to win in 90 days.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — KEYWORD GAP (tool-grade)
SEMrush: keyword gap analysis, S1–S4 classification, 90-day sprint.`,
  },
  {
    id: "onpage", grid: "SITE·02", title: "On-page deep audit", depth: "full", cat: "onpage", merged: "prompts 10+12+21", phase: "SITE",
    what: "Head-of-on-page audit: title/meta/H1 rewrites, entity gaps, fix-it checklist.",
    pasteLabel: "Optional: paste keyword + page text",
    runTask: (c) => `${ctxBlock(c, "local")}

Audit target page. Deliver: NON-NEGOTIABLES, HEADINGS outline, BODY critique, SCORECARD, FIX-IT CHECKLIST by impact.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — DEEP ON-PAGE (tool-grade)
Google Search Console, 90-day export, pos 11–20 keywords, deep audit on top money page.`,
  },
  {
    id: "citypages", grid: "SITE·03", title: "City page builder", depth: "full", cat: "citypages", merged: "prompt 11", phase: "SITE",
    what: "One fully-written service × city landing page per run.",
    runTask: (c) => `${ctxBlock(c, "local")}

Write ONE complete page for ${c.primaryService || "[service]"} in a city: title, meta, H1, openers, why-us, details, FAQs, CTA, slug, links, directories.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — CITY PAGE (tool-grade)
Inventory existing pages, write all missing service+city pages in full.`,
  },
  {
    id: "backlinks", grid: "AUTH·01", title: "Backlink gap + target number", depth: "public", cat: "backlinks", merged: "prompts 14+22", phase: "AUTH",
    what: "Referring domains needed for top-5, plus 90-day acquisition plan with outreach emails.",
    runTask: (c) => `${ctxBlock(c, "local")}

Build link-source table. 90-day plan: month 1 = 5 easy, month 2 = 5 medium, month 3 = 5 authority. Per target: outreach email.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — AHREFS BACKLINK (tool-grade)
Keywords Explorer, Top 10 organic, Backlinks report, RDs, 90-day plan + outreach emails.`,
  },
  {
    id: "citations", grid: "AUTH·02", title: "Citations + entity build", depth: "full", cat: "citations", merged: "prompts 15+18", phase: "AUTH",
    what: "NAP consistency sweep, knowledge-graph entity building, schema JSON-LD, profiles, brand-mention plan.",
    runTask: (c) => `${ctxBlock(c, "local")}

Check NAP across directories. Report inconsistencies. Entity building: LocalBusiness JSON-LD, profiles, brand-mention plan.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — CITATION + ENTITY (tool-grade)
NAP audit, knowledge panel, LocalBusiness JSON-LD, profiles to claim, brand-mention plan.`,
  },
  {
    id: "content", grid: "AUTH·03", title: "Content gap briefs", depth: "public", cat: "keywords", merged: "prompt 17", phase: "AUTH",
    what: "Question-keyword gaps organized by funnel stage.",
    runTask: (c) => `${ctxBlock(c, "local")}

Build question-keyword universe. Bucket by stage. Top 10 with full briefs: title, slug, target + secondary keywords, word count, links, CTA.`,
    prompt: (c) => `${ctxBlock(c, "local")}

TASK — CONTENT GAP (tool-grade)
SEMrush Content Gap, top 20, full brief each by stage.`,
  },
];

// 12 online modules — same depth as local, mapped to CATS_ONLINE (VIS / CONV / AUTH)
const MODULES_ONLINE = [
  /* ———————————————— VISIBILITY ———————————————— */
  {
    id: "keywords", grid: "VIS·01", title: "Keyword gap + intent map", depth: "public", cat: "keywords", merged: "VIS 1", phase: "VIS",
    what: "Non-geo keyword universe mapped to buyer-journey stage so budget goes to Stage-4 money terms.",
    runTask: (c) => `${ctxBlock(c, "online")}

Build the keyword universe for ${c.niche || "[niche]"} targeting ${c.targetMarket || "[market]"}: variations of ${c.keywords || "[keywords]"} plus modifiers (best, vs, alternative, pricing, review, how to, for [audience]) and typical question queries for this niche. If you can search, check real results to see which competitors surface and whether ${c.website || "[site]"} appears; note that exact volumes/KD always need the SEMrush Cowork run.

Classify every keyword: S1 problem-unaware, S2 problem-aware, S3 solution-aware (comparisons, alternatives), S4 ready-to-buy (pricing, discount, "buy", branded-competitor). Output per stage: keywords, who ranks, my presence y/n, and placement (S4→product/offer pages, S3→comparison + alternative pages, S2→educational content, S1→problem-ID content). Finish with the 5 Stage-4 keywords to win in 90 days, each with an Action: optimize existing page or create new page.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — KEYWORD GAP + INTENT MAP (tool-grade)
Open Chrome → SEMrush. Keyword Gap: ${c.website || "[domain]"} vs 3 competitor domains. Filter: they rank 1–20 / I don't; volume 50–5,000; non-branded; KD<50. Classify survivors S1–S4; per stage: count, volume, avg KD, top 10. Map placements (S4→offer pages, S3→comparison/alternatives, S2→guides, S1→problem content); finish with 5 Stage-4 targets + exact 90-day plan each + Action column (optimize vs create).`,
  },
  {
    id: "content", grid: "VIS·02", title: "Content gap → briefs", depth: "public", cat: "content", merged: "VIS 2", phase: "VIS",
    what: "Question-keyword and topic gaps organized by funnel stage, with a full brief per page.",
    runTask: (c) => `${ctxBlock(c, "online")}

Build the question-keyword universe (how/why/what/cost/vs/best/alternative) around ${c.niche || "[niche]"} and ${c.productType || "[product]"} — from real search-result / People-Also-Ask patterns if you can search, otherwise from pattern-knowledge (say which).

Bucket the top gaps: problem-awareness ("why is my X doing Y"), solution-comparison ("[product] vs [competitor]", "[competitor] alternatives"), purchase-intent ("[product] pricing", "is [product] worth it"). For each of the top 10: SEO title, URL slug, 150-word brief (target + secondary keywords, questions to answer, word count, internal links, closing CTA). Comparison and alternatives pages first — they intercept competitor demand. Note exact volumes need the SEMrush Cowork run.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — CONTENT GAP → 20 BRIEFS (tool-grade)
Open Chrome → SEMrush Content Gap: ${c.website || "[domain]"} vs 3 competitors. Filter: they rank / I don't; 50–1,000/mo; question words + "vs" + "alternative" + "best". Bucket top 20 by funnel stage; full 200-word brief each (title, slug, keywords, questions, word count, internal links, CTA). Prioritize comparison/alternatives pages that intercept competitor-brand demand.`,
  },
  {
    id: "snippets", grid: "VIS·03", title: "SERP feature + snippet capture", depth: "public", cat: "snippets", merged: "VIS 3", phase: "VIS",
    what: "Which featured snippets, People-Also-Ask boxes, and AI-overview citations are winnable, and the exact copy blocks to win them.",
    runTask: (c) => `${ctxBlock(c, "online")}

For my top keywords (${c.keywords || "[keywords]"}): if you can search, check which SERP features actually appear (featured snippet, PAA, video, AI overview) and who owns them; otherwise infer typical feature mix for this query class and say so.

Deliver: (1) FEATURE MAP — table keyword | features present | current owner | winnable y/n | why. (2) SNIPPET BLOCKS — for the 5 most winnable: the exact 40–55-word definition paragraph, list, or table formatted to capture the snippet, plus where to place it on the page. (3) PAA COVERAGE — 10 People-Also-Ask questions with 2-3 sentence answers ready to paste as H3+paragraph. (4) STRUCTURED-DATA hooks — which schema types (FAQ, HowTo, Product) support each capture. End with a 30-day capture priority list, impact H/M/L each.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — SERP FEATURE AUDIT + CAPTURE (tool-grade)
Open Chrome → search each target keyword: ${c.keywords || "[keywords]"}. Screenshot/log every SERP feature: featured snippet (owner + format), PAA questions (expand 2 levels, log all), video/image packs, AI overview presence + cited sources. Cross-check SEMrush SERP features report for ${c.website || "[domain]"}. Deliver the feature map, exact snippet-formatted copy blocks for the 5 most winnable, full PAA answer bank, and schema recommendations per page.`,
  },
  {
    id: "coreWeb", grid: "VIS·04", title: "Technical + Core Web Vitals audit", depth: "full", cat: "coreWeb", merged: "VIS 4", phase: "VIS",
    what: "Prioritized technical-health checklist: CWV, indexing, crawlability, mobile — plain-English fixes. Paste PageSpeed/GSC data for a verified audit.",
    pasteLabel: "Optional: paste PageSpeed Insights results or GSC Core Web Vitals / coverage data",
    runTask: (c) => `${ctxBlock(c, "online")}

Audit technical health for ${c.website || "[site]"}. Evidence priority: (1) anything pasted below, (2) what's visible if you can search/fetch the site, (3) the standard failure patterns for sites on ${c.platforms || "[platform]"} — flag which tier each finding comes from.

Deliver: (1) CWV TRIAGE — LCP/INP/CLS: likely score band, top 3 causes each for this platform, fix per cause with effort estimate. (2) INDEXING — robots/sitemap/canonical/noindex checklist with what to check and where. (3) CRAWL + ARCHITECTURE — depth, orphan pages, internal-link structure, pagination/faceting risks. (4) MOBILE + RENDERING — JS-rendering risks, viewport, tap targets. (5) FIX-IT CHECKLIST — numbered by impact: what, where to click (platform-specific), minutes, H/M/L. End: "If you only do the first three, you'll still see crawl + CWV movement within 30 days."`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — TECHNICAL + CWV AUDIT (tool-grade)
Open Chrome → PageSpeed Insights for ${c.website || "[site]"} (home + top 3 money pages): record LCP, INP, CLS, mobile + desktop, and every flagged opportunity. Then Google Search Console: Core Web Vitals report (failing URL groups), Page Indexing (excluded reasons, counts), sitemaps status. Crawl top 50 pages (Screaming Frog if available): status codes, canonicals, titles/meta duplicates, orphans, depth. Deliver the prioritized fix list with platform-specific click-paths (${c.platforms || "[platform]"}), effort, and expected impact per fix.`,
  },

  /* ———————————————— CONVERSION ———————————————— */
  {
    id: "onpage", grid: "CONV·01", title: "On-page deep audit", depth: "full", cat: "onpage", merged: "CONV 1", phase: "CONV",
    what: "Head-of-on-page audit for a money page: title/meta/H1 rewrites, heading outline, entity gaps, fix-it checklist. Paste a URL's text or let it template.",
    pasteLabel: "Optional: paste target keyword + page text (first line = keyword)",
    runTask: (c) => `${ctxBlock(c, "online")}

Audit target: the pasted page text below if given (first line = target keyword, default: ${(c.keywords || "[keyword]").split(",")[0]}). If nothing's pasted but you can search, look up ${c.website || "[site]"} and audit what's visible; if neither, write the audit as a best-practice template for that keyword and say so — never guess at content that isn't in front of you.

Deliver: (1) NON-NEGOTIABLES — title/meta/URL/H1 table: Current | Count | Score/10 | Wrong | Exact rewrite. (2) HEADINGS — current vs corrected outline; weak H2s rewritten word-for-word; H3s for People-Also-Ask. (3) BODY — first-100-words rewrite if weak; keyword density; 10 missing entities + insertion points; fluff deleted; CTA copy written. (4) CONVERSION LAYER — above-fold value prop, trust elements, objection handling, CTA placement. (5) SCORECARD — Area | /10 | Priority | Time. (6) FIX-IT CHECKLIST numbered by impact with paste-ready text.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — PAGE-2 GOLDMINE + DEEP ON-PAGE (tool-grade)
Open Chrome → Google Search Console for ${c.website || "[domain]"}. Export 90 days. Find: pos 11–20 keywords with 100+ impressions; high-impression low-CTR pages; zero-ranking money pages; cannibalization. Per page-2 keyword check title/H1/first-100-words/word count/internal links/meta. 30-day sprint with every title, H1, meta written in full. Then run the full deep audit (non-negotiables, heading outline, body critique, conversion layer, schema JSON-LD, scorecard, fix-it checklist) on my top money page.`,
  },
  {
    id: "landing", grid: "CONV·02", title: "Landing / offer page builder", depth: "full", cat: "landing", merged: "CONV 2", phase: "CONV",
    what: "One fully-written landing page per run — for a segment, use-case, or comparison target. The online equivalent of the city-page play.",
    runTask: (c) => `${ctxBlock(c, "online")}

If you can search, check ${c.website || "[site]"} for which segment/use-case/comparison pages already exist and pick the highest-value missing one; otherwise pick the most obvious high-intent segment for ${c.productType || "[product]"} in ${c.niche || "[niche]"} and note the inventory was skipped. Write ONE complete page — real specifics only where verified, [DETAIL] placeholders otherwise:

SEO title <60 chars · meta <155 · H1 · 100-word pain-point opener in the segment's language · 150-word why-us for this segment · 200-word how-it-works / feature-to-benefit mapping · social-proof placeholder (which proof type converts this segment) · 3 segment-specific FAQs · pricing-objection handling block · primary CTA + secondary low-commitment CTA · URL slug · 3 internal-link anchors.
End with the remaining missing segment/use-case/comparison combinations so I can run this module once per page.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — FULL LANDING PAGE STACK (tool-grade)
Open Chrome → ${c.website || "[site]"}; inventory existing vs missing pages across three types: segment pages ([product] for [audience]), use-case pages, and comparison pages ([me] vs [competitor], [competitor] alternative). Check each competitor's page stack for the pattern they're winning with. Write every missing page in full (title/meta/H1/opener/why-us/features-to-benefits/FAQs/objection block/CTAs), plus slug and internal links per page.`,
  },
  {
    id: "trust", grid: "CONV·03", title: "Review + trust engine", depth: "full", cat: "trust", merged: "CONV 3", phase: "CONV",
    what: "Trustpilot/G2/app-store review analysis, response system, and review-velocity plan. Optionally paste raw reviews for deeper mining.",
    pasteLabel: "Optional: paste raw reviews (mine or competitors') for deeper mining",
    runTask: (c) => `${ctxBlock(c, "online")}

Analyze reviews across my trust profiles (${c.trustProfiles || "[Trustpilot/G2/app stores]"}) and my competitors'. Evidence priority: (1) anything pasted below, (2) live lookups of public reviews if you can search, (3) general knowledge of what ${c.niche || "[niche]"} customers praise and fear — flag which tier each finding comes from. Produce:
1. VELOCITY — counts, ratings, recency comparison table across platforms; who's accelerating.
2. SENTIMENT — top emotional words, concrete outcomes, pre-purchase fears, exact recommendation phrases (money phrases).
3. REVIEW ASK — the in-product / post-purchase moments to trigger asks, 5 phrases to seed, and a short request template per channel (email, in-app).
4. RESPONSES — 3 templates each for 5★/4★/3★/1–2★, 40–80 words, human never robotic; negative-review de-escalation flow.
5. REWRITES — homepage headline+sub and meta description in real customer language pulled from the analysis.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — TRUST PROFILE TEARDOWN (tool-grade)
Open Chrome → my profiles (${c.trustProfiles || "[urls]"}) + 3 competitors' on the same platforms. Read last 100 reviews each: totals, rating, 30/60/90-day counts, top praised features, top complaints, switching reasons ("moved from X because"). Read last 30 responses: rate %, tone, negative handling. Sentiment-mine all: emotional words, outcomes, fears, recommendation phrases. Deliver velocity table, ask-trigger map, full response template system, homepage + meta rewrites in customer language.`,
  },
  {
    id: "social", grid: "CONV·04", title: "Social proof + UGC calendar", depth: "full", cat: "social", merged: "CONV 4", phase: "CONV",
    what: "Reverse-engineer competitor social cadence, then generate an 8-week proof-led content calendar written in full.",
    runTask: (c) => `${ctxBlock(c, "online")}

If you can search, first check visible competitor activity on ${c.platforms || "[platforms]"} and note cadence patterns + gaps I can exploit; otherwise use standard best-practice cadence for this niche and say so. Then build my 8-week calendar, 2–3 posts/week across my platforms: customer-win spotlights, before/after or results posts, UGC reshares + the ask that generates them, behind-the-scenes, educational posts targeting ${c.keywords || "[keywords]"}, and launch/offer posts. Each post: 50–150 words of ready-to-paste copy, hook first line, CTA, and an image/asset description. Weeks 1–4 in full, 5–8 outlined. Include the UGC engine: 3 mechanics to get customers creating content (with the exact ask copy) and rights-request template.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — SOCIAL FORENSICS + CALENDAR (tool-grade)
Open Chrome → 3 competitors' profiles on ${c.platforms || "[platforms]"}. Log 30 days of posts each: date/time, format, hook, topic, proof type used, engagement signals. Analyze patterns (days, formats, proof-to-promo ratio, gaps). Build my counter-cadence and write weeks 1–4 in full (copy + hook + CTA + asset description), outline 5–8, plus the 3-mechanic UGC engine with ask copy and rights template.`,
  },

  /* ———————————————— AUTHORITY ———————————————— */
  {
    id: "backlinks", grid: "AUTH·01", title: "Backlink gap + target number", depth: "public", cat: "backlinks", merged: "AUTH 1", phase: "AUTH",
    what: "How many referring domains you need for top-5, plus a 90-day acquisition plan with outreach emails written.",
    runTask: (c) => `${ctxBlock(c, "online")}

If you can search, look up who ranks top-5 for "${(c.keywords || "[keyword]").split(",")[0]}" and any visible mentions/links of those sites (roundups, directories, integrations, press) plus mentions of ${c.website || "[site]"}, and fold real targets into the plan; otherwise build it from the link-source categories that move rankings in ${c.niche || "[niche]"} and say so.

Deliver: (1) the link-source table (real targets where found, categories otherwise — "best [niche] tools" roundups, integration/partner pages, comparison sites, industry publications, podcasts, communities) with difficulty + impact, (2) the 90-day plan: month 1 = 5 easy links (directories, profiles, partner pages), month 2 = 5 medium (roundup inclusions, guest posts, HARO-style quotes), month 3 = 5 authority plays (original research, tools, digital PR) — with contact method + a full ready-to-send outreach email per target. Note exact RD counts/DR tiers need the Ahrefs Cowork run.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — AHREFS BACKLINK GAP (tool-grade)
Ahrefs open in Chrome, logged in; pause 3–5s between drill-downs.
P1 — Keywords Explorer: "${(c.keywords || "[keyword]").split(",")[0]}" (confirm keyword+country with me first). Record KD, volume, #1 traffic potential; capture top 10 organic: position, URL, DR, UR, page-level referring domains, traffic.
P2 — Top 5 pages one at a time: Backlinks report, dofollow + one-per-domain, DR desc, up to 100 rows each; bucket DR 70+/50–69/30–49/0–29; flag niche vs generic.
P3 — Mean AND median RDs (median anchors the target, +10–15% buffer), DR mix, PBN/paid flags (don't replicate), top-15 domains linking to 2+ competitors ranked by overlap then DR. Then the 90-day plan with full outreach emails per target.`,
  },
  {
    id: "pr", grid: "AUTH·02", title: "Digital PR + brand-mention plan", depth: "public", cat: "pr", merged: "AUTH 2", phase: "AUTH",
    what: "Newsworthy angles, journalist/publication targets, and pitch emails — the mention engine that compounds authority.",
    runTask: (c) => `${ctxBlock(c, "online")}

Build the digital-PR plan for ${c.businessName || "[brand]"} in ${c.niche || "[niche]"}. If you can search, check which publications, newsletters, and podcasts actually cover this niche and who's been quoted recently; otherwise name the category targets and say so.

Deliver: (1) ANGLES — 5 newsworthy story angles ranked by effort: data/original-research angle (what to survey or mine from my own product data), contrarian take, trend-jack template, founder-story angle, tool/free-resource angle. (2) TARGET LIST — 15 publications/newsletters/podcasts by tier (dream / realistic / easy) with what they cover and why I fit. (3) PITCHES — 3 full ready-to-send pitch emails (data angle, expert-comment offer, guest contribution), each under 150 words with subject line. (4) MENTION HYGIENE — how to find and reclaim unlinked brand mentions. End with a monthly PR cadence checklist.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — DIGITAL PR SPRINT (tool-grade)
Open Chrome. (1) Search "${c.niche || "[niche]"}" + news/roundups/podcasts: log 15 real targets (publication, journalist/host, recent relevant piece, contact route). (2) Ahrefs/SEMrush: competitors' best links from press — which angles earned them. (3) Search my brand name in quotes minus my domain: log unlinked mentions to reclaim. Deliver the tiered target list with real names, the 5 angles matched to real outlets, 3 full pitch emails, and the reclaim list with contact per mention.`,
  },
  {
    id: "entity", grid: "AUTH·03", title: "Entity / schema + brand SERP build", depth: "full", cat: "entity", merged: "AUTH 3", phase: "AUTH",
    what: "Own your brand SERP: Organization/Product schema JSON-LD ready to paste, profile claims, knowledge-panel groundwork.",
    runTask: (c) => `${ctxBlock(c, "online")}

My brand: ${c.businessName || "[name]"} | ${c.website || "[site]"} | ${c.productType || "[product]"}.
If you can search, check my actual brand SERP — what appears for my exact brand name (site links, profiles, competitors bidding/ranking, People-Also-Ask) — and report it; otherwise give the standard brand-SERP checklist marked unverified.

Then deliver: (1) SCHEMA — complete Organization + Product (or SoftwareApplication) JSON-LD ready to paste, real values from my context, including sameAs array for every profile. (2) PROFILE CLAIMS — the profiles that feed entity understanding (LinkedIn company, Crunchbase, G2/Capterra where relevant, Wikidata candidacy check, social handles) with claim order. (3) BRAND SERP DEFENSE — pages/profiles to rank so I own positions 1–10 for my brand name; flag any competitor comparison pages ranking on my brand + the counter-page to publish. (4) CONSISTENCY — name/description/logo consistency checklist across every surface. End with a quarterly entity-maintenance checklist.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — ENTITY + BRAND SERP (tool-grade)
Open Chrome → search my exact brand name + brand + "review" + brand + "alternative": screenshot/log all 10 positions each, who owns them, and PAA. Check search.google.com/test/rich-results on ${c.website || "[site]"}; check wikidata.org for the entity. Deliver Organization/Product JSON-LD with full sameAs, profile claim list in order, the brand-SERP defense plan (which pages to publish/optimize per hostile or empty position), and the consistency sweep results.`,
  },
  {
    id: "owned", grid: "AUTH·04", title: "Email + owned-audience engine", depth: "full", cat: "owned", merged: "AUTH 4", phase: "AUTH",
    what: "Capture, welcome, and nurture: lead-magnet concepts, full welcome sequence written, and a weekly send cadence.",
    runTask: (c) => `${ctxBlock(c, "online")}

Build the owned-audience engine for ${c.businessName || "[brand]"} (${c.productType || "[product]"}, ${c.niche || "[niche]"}). Deliver, all ready to use:
1. CAPTURE — 3 lead-magnet concepts ranked by effort-to-value for this niche (checklist/template, mini-tool/calculator, email course), each with title, one-line promise, and the exact form headline + button copy; plus placement map (which pages, which trigger).
2. WELCOME SEQUENCE — 5 emails written in full (60–120 words each): deliver + quick win, story/why-us, best-content roundup, social proof + objection handling, soft offer. Subject line + preview text each.
3. CADENCE — weekly send plan tied to the content calendar: what to send, repurposed from what, with 4 example subject lines.
4. LIST HYGIENE — sunset flow for cold subscribers + re-engagement email written.
End with the 3 metrics to watch monthly (capture rate, open trend, click-to-site) and healthy benchmarks for this niche.`,
    prompt: (c) => `${ctxBlock(c, "online")}

TASK — EMAIL ENGINE (tool-grade)
Open Chrome → subscribe to 3 competitors' lists with a fresh address; screenshot their capture placements, magnets, and log their welcome sequences over the week (timing, angle, offer moment). Audit my current capture on ${c.website || "[site]"}: placements, copy, friction. Deliver the gap analysis, 3 magnet concepts with form copy, the full 5-email welcome sequence, weekly cadence plan, and sunset flow — all written ready to load into the ESP.`,
  },
];

// ============================================================================
// UI ATOMS
// ============================================================================

const Eyebrow = ({ children, color = C.faint }) => (
  <div className="rc-mono" style={{ fontSize: 10, letterSpacing: "0.18em", color, textTransform: "uppercase" }}>{children}</div>
);

const Field = ({ label, value, onChange, ph, area }) => (
  <label style={{ display: "block" }}>
    <Eyebrow>{label}</Eyebrow>
    {area ? (
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph} rows={2}
        style={{ width: "100%", marginTop: 5, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, color: C.text, padding: "9px 11px", fontSize: 13.5, resize: "vertical", fontFamily: "inherit", outline: "none" }} />
    ) : (
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph}
        style={{ width: "100%", marginTop: 5, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, color: C.text, padding: "9px 11px", fontSize: 13.5, outline: "none" }} />
    )}
  </label>
);

const Btn = ({ children, onClick, tone = "gold", small, disabled }) => {
  const tones = {
    gold: { background: `linear-gradient(180deg, #F0C05E, ${C.gold})`, color: "#151004", border: "1px solid #F0C05E" },
    ghost: { background: "transparent", color: C.dim, border: `1px solid ${C.line}` },
    teal: { background: "transparent", color: C.teal, border: `1px solid ${C.teal}55` },
    coral: { background: "transparent", color: C.coral, border: `1px solid ${C.coral}55` },
  };
  return (
    <button className="rc-btn" onClick={onClick} disabled={disabled}
      style={{ ...tones[tone], borderRadius: 9, padding: small ? "6px 12px" : "10px 16px", fontSize: small ? 12 : 13.5, fontWeight: 600, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, fontFamily: "inherit" }}>
      {children}
    </button>
  );
};

const Panel = ({ children, style, hover }) => (
  <div className={`rc-card${hover ? " rc-card-hover" : ""}`} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, ...style }}>
    {children}
  </div>
);

// ============================================================================
// GAUGES & DASHBOARD ATOMS
// ============================================================================

function Gauge({ before, after, size = 340 }) {
  const R = 92, CX = 120, CY = 118, start = -210, sweep = 240;
  const arc = (pct, r) => {
    const a0 = (start * Math.PI) / 180, a1 = ((start + sweep * Math.min(pct, 1)) * Math.PI) / 180;
    const x0 = CX + r * Math.cos(a0), y0 = CY + r * Math.sin(a0);
    const x1 = CX + r * Math.cos(a1), y1 = CY + r * Math.sin(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${sweep * pct > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ticks = [];
  for (let i = 0; i <= 24; i++) {
    const a = ((start + (sweep * i) / 24) * Math.PI) / 180;
    const r0 = R + 8, r1 = R + (i % 6 === 0 ? 16 : 12);
    ticks.push(<line key={i} x1={CX + r0 * Math.cos(a)} y1={CY + r0 * Math.sin(a)} x2={CX + r1 * Math.cos(a)} y2={CY + r1 * Math.sin(a)} stroke={C.line} strokeWidth={i % 6 === 0 ? 1.5 : 1} />);
  }
  const delta = after - before;
  return (
    <svg viewBox="0 0 240 200" style={{ width: "100%", maxWidth: size }}>
      {ticks}
      <path d={arc(1, R)} fill="none" stroke={C.line} strokeWidth="10" strokeLinecap="round" />
      {before > 0 && <path d={arc(before / 100, R)} fill="none" stroke={C.faint} strokeWidth="10" strokeLinecap="round" />}
      {after > 0 && <path d={arc(after / 100, R - 16)} fill="none" stroke={C.gold} strokeWidth="10" strokeLinecap="round" style={{ filter: "drop-shadow(0 0 8px #E8B44C66)" }} />}
      <text x={CX} y={CY - 4} textAnchor="middle" fill={C.text} className="rc-display" style={{ fontSize: 52, fontWeight: 700 }}>{after || "—"}</text>
      <text x={CX} y={CY + 20} textAnchor="middle" fill={C.faint} className="rc-mono" style={{ fontSize: 10, letterSpacing: "0.15em" }}>CURRENT / 100</text>
      <text x={CX} y={CY + 44} textAnchor="middle" className="rc-mono" style={{ fontSize: 12, fill: delta > 0 ? C.green : delta < 0 ? C.coral : C.faint }}>
        {before ? `baseline ${before}  ·  ${delta >= 0 ? "+" : ""}${delta}` : "no baseline yet"}
      </text>
    </svg>
  );
}

const StatTile = ({ label, value, sub, color = C.text }) => (
  <Panel style={{ padding: "14px 16px", flex: "1 1 130px", minWidth: 130 }}>
    <Eyebrow>{label}</Eyebrow>
    <div className="rc-mono" style={{ fontSize: 26, fontWeight: 600, color, lineHeight: 1.15, marginTop: 6 }}>{value}</div>
    {sub && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>{sub}</div>}
  </Panel>
);

const PhaseBar = ({ phase, baseline, current, cats }) => {
  const b = weighted(baseline, phase.id, cats), cur = weighted(current, phase.id, cats);
  const d = cur - b;
  const catCount = cats.filter((c) => c.phase === phase.id).length;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          <span className="rc-mono" style={{ color: phase.color, fontSize: 10, letterSpacing: "0.12em", marginRight: 8 }}>{phase.id}</span>
          {phase.label}
          <span className="rc-mono" style={{ fontSize: 10, color: C.faint, marginLeft: 8 }}>{catCount} areas</span>
        </div>
        <div className="rc-mono" style={{ fontSize: 12, color: d > 0 ? C.green : d < 0 ? C.coral : C.dim }}>
          {cur}<span style={{ color: C.faint }}>/100</span>{d !== 0 && b > 0 ? ` (${d > 0 ? "+" : ""}${d})` : ""}
        </div>
      </div>
      <div style={{ height: 8, background: C.line, borderRadius: 4, position: "relative", overflow: "hidden" }}>
        {b > 0 && <div style={{ position: "absolute", inset: 0, width: `${b}%`, background: C.faint, borderRadius: 4, opacity: 0.5 }} />}
        <div className="rc-grow" style={{ position: "absolute", inset: 0, width: `${cur}%`, background: `linear-gradient(90deg, ${phase.color}99, ${phase.color})`, borderRadius: 4 }} />
      </div>
    </div>
  );
};

// ============================================================================
// MAIN APP
// ============================================================================

export default function RankConsole() {
  const [state, setState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("dash");
  const [busy, setBusy] = useState(null);
  const [step, setStep] = useState("");
  const [toast, setToast] = useState("");
  const [open, setOpen] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pasteData, setPasteData] = useState({});
  const [testingKey, setTestingKey] = useState(null);
  const [runAllProgress, setRunAllProgress] = useState(null);
  const runAllAbort = useRef(false);

  const [apiOk, setApiOk] = useState(null);  // null = checking, true = API available, false = offline mode
  const [searchOk, setSearchOk] = useState(null); // null = unknown, true = web search works, false = no search
  const [apiError, setApiError] = useState(""); // last real error from the bridge probe, for diagnostics
  // Two-phase autofill: identity = null (not run) or the confirmed/pending
  // identification result shown in the Setup checkpoint panel. Declared
  // here — alongside every other hook — because it MUST run before the
  // `if (!loaded || !state) return ...` early return below. A hook called
  // only after that return fires on some renders and not others (loaded
  // flips false→true), which is React error #310: hook count changing
  // between renders.
  const [identity, setIdentity] = useState(null);
  const [identityEdit, setIdentityEdit] = useState("");
  const [confirmReset, setConfirmReset] = useState(false); // scorecard reset needs a second click to fire

  // Detect API availability on mount
  const detectApi = async () => {
    setApiOk(null); setSearchOk(null); setApiError("");
    // One retry before declaring offline — the first bridge call after an
    // artifact mounts can be genuinely slow (cold start), not broken, and
    // a single 15s timeout shouldn't be enough to mark a working
    // connection as dead.
    let lastErr = null;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        await Promise.race([
          pingClaude("bridge", "claude-sonnet-4-6"),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 15s")), 15000)),
        ]);
        ok = true;
      } catch (e) { lastErr = e; }
    }
    if (ok) {
      setApiOk(true);
      try {
        await Promise.race([
          pingSearch(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
        ]);
        setSearchOk(true);
      } catch { setSearchOk(false); }
    } else {
      setApiOk(false);
      setSearchOk(false);
      setApiError(lastErr?.message || "unknown error");
    }
  };

  // Load state on mount
  useEffect(() => {
    (async () => {
      const s = await loadState();
      if (s) setState(s);
      else {
        setState({
          version: 3,
          ctx: { ...emptyCtxLocal, businessMode: "local" },
          settings: {
            provider: "bridge", model: "claude-sonnet-4-6",
            keys: { anthropic: "", openai: "", poyo: "", fal: "", custom: { baseUrl: "", key: "", modelList: "" } },
            report: { includeGraphs: true, includeMockups: false },
          },
          local: { baseline: {}, current: {}, notes: {}, baselineLocked: false, status: {}, outputs: {}, insights: {} },
          online: { baseline: {}, current: {}, notes: {}, baselineLocked: false, status: {}, outputs: {}, insights: {} },
        });
      }
      setLoaded(true);
      setTimeout(() => detectApi(), 500);
    })();
  }, []);

  useEffect(() => {
    if (loaded && state) saveState(state);
  }, [state, loaded]);

  if (!loaded || !state) return <div style={{ background: C.bg, color: C.text, padding: 40, textAlign: "center" }}>Loading...</div>;

  const { ctx, settings, local: localState, online: onlineState } = state;
  const mode = ctx.businessMode || "local";
  const modeState = mode === "local" ? localState : onlineState;
  const CATS = mode === "local" ? CATS_LOCAL : CATS_ONLINE;
  const PHASES = mode === "local" ? PHASES_LOCAL : PHASES_ONLINE;
  const MODULES = mode === "local" ? MODULES_LOCAL : MODULES_ONLINE;
  const emptyCtx = mode === "local" ? emptyCtxLocal : emptyCtxOnline;

  // Helper functions
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), Math.min(9000, Math.max(2600, m.length * 55))); };
  const copy = async (t, m = "Copied") => {
    try { await navigator.clipboard.writeText(t); flash(m); } catch { flash("Copy blocked"); }
  };
  const setCtx = (k) => (v) => setState((p) => ({ ...p, ctx: { ...p.ctx, [k]: v } }));
  const setComp = (i, k) => (v) => setState((p) => ({
    ...p, ctx: { ...p.ctx, competitors: p.ctx.competitors.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }
  }));
  const setModeState = (updates) => setState((p) => ({
    ...p, [mode]: { ...modeState, ...updates }
  }));
  // Switching Business Type previously just flipped ctx.businessMode — the
  // other mode's fields (niche/productType/... for online, address/gbpUrl/
  // ... for local) were never added, so a FIRST switch left them undefined
  // and every Field for that mode rendered blank until something else wrote
  // to it. This merges in the right empty-field template, keeps whatever
  // shared fields already have values (name, website, description,
  // keywords, biggest problem), and reshapes competitors to the fields the
  // new mode actually uses (gbpUrl only exists for local).
  const switchBusinessMode = (m) => setState((p) => {
    const template = m === "local" ? emptyCtxLocal : emptyCtxOnline;
    const shared = { businessName: p.ctx.businessName, website: p.ctx.website, businessDescription: p.ctx.businessDescription, keywords: p.ctx.keywords, biggestProblem: p.ctx.biggestProblem };
    const competitors = (p.ctx.competitors || []).map((c) => m === "local"
      ? { name: c.name || "", gbpUrl: c.gbpUrl || "", website: c.website || "" }
      : { name: c.name || "", website: c.website || "" });
    return { ...p, ctx: { ...template, ...shared, competitors, businessMode: m } };
  });
  // Clears every filled scorecard cell (baseline + current values, notes,
  // the baseline lock) for the active mode only. Deliberately leaves module
  // outputs/insights/status alone — those are separate work, not "cells" —
  // and leaves the OTHER mode's scores untouched (local vs online state
  // slices are independent, same as everywhere else in the app).
  const resetScores = () => {
    setModeState({ baseline: {}, current: {}, notes: {}, baselineLocked: false });
    setConfirmReset(false);
    flash("All scorecard cells cleared — baseline unlocked, ready to re-score");
  };
  const setSetting = (k, v) => setState((p) => ({ ...p, settings: { ...p.settings, [k]: v } }));
  const setKey = (provider, value) => setState((p) => ({
    ...p, settings: { ...p.settings, keys: { ...p.settings.keys, [provider]: value } }
  }));

  const { baseline, current, notes, baselineLocked, status, outputs, insights } = modeState;
  const beforeScore = weighted(baseline, undefined, CATS);
  const afterScore = weighted(current, undefined, CATS);
  const doneCount = Object.values(status).filter((s) => s === "done").length;

  // Derived data for dashboard
  const catRows = CATS.map((cat) => ({
    ...cat, b: baseline[cat.id] ?? null, cur: current[cat.id] ?? null,
    d: baseline[cat.id] != null && current[cat.id] != null ? current[cat.id] - baseline[cat.id] : null,
    note: notes[cat.id], module: MODULES.find((m) => m.cat === cat.id),
  }));
  const gaps = [...catRows].filter((r) => r.cur != null).sort((a, b) => a.cur - b.cur).slice(0, 3);
  const improvements = catRows.filter((r) => r.d != null && r.d > 0).sort((a, b) => b.d - a.d);
  const nextModule = MODULES.find((m) => status[m.id] !== "done");
  const findings = MODULES.filter((m) => status[m.id] === "done" && outputs[m.id])
    .map((m) => {
      const raw = outputs[m.id].replace(/[#*`>|—-]{2,}/g, " ").replace(/\s+/g, " ").trim();
      return { m, snippet: raw.slice(0, 180) + (raw.length > 180 ? "…" : "") };
    });

  const anyBusy = !!busy;
  const hasBaseline = beforeScore > 0;

  const tabs = [
    { id: "dash", label: "Dashboard" },
    { id: "setup", label: "Setup" },
    { id: "modules", label: "Modules" },
    { id: "score", label: "Scorecard" },
    { id: "report", label: "Report" },
    { id: "export", label: "Export" },
  ];

  // ————— Event handlers —————

  // ————— TWO-PHASE AUTOFILL —————
  // identity state is declared above (before the early return); this block
  // only defines the functions that use it.

  // Phase 1 — establish WHAT the business is; never fills fields.
  const identifyBusiness = async (name = ctx.businessName, site = ctx.website) => {
    if (!name || !site) { flash("Enter business name + website first"); return; }
    const live = searchOk === true && settings.provider === "bridge";
    setBusy("identify");
    setStep(live ? "Identifying the business from its real web footprint…" : "Checking if this business is specifically known (no live search here)…");
    try {
      const raw = await askClaude({
        provider: settings.provider, model: settings.model,
        system: live ? IDENTIFY_SYS_LIVE : IDENTIFY_SYS_INFER,
        user: identifyPrompt(name, site), search: live, keys: settings.keys,
      });
      const j = parseJSON(raw);
      const found = { summary: j.summary || "", offering: j.offering || "", audience: j.audience || "",
        isLocal: j.isLocal || "unknown", confidence: j.confidence || "none", evidence: j.evidence || "", live };
      setIdentity(found);
      setIdentityEdit(found.summary);
      if (!found.summary) {
        flash(live
          ? "Couldn't establish what this business is from search — describe it below in a sentence and continue from that."
          : "No live search here and this business isn't specifically known — describe it below in a sentence and continue from that.");
      }
    } catch (e) { flash(`Identification failed: ${e.message}`); }
    finally { setBusy(null); setStep(""); }
  };

  // Phase 2 — fill fields, anchored to the user-confirmed description.
  const autofill = async (confirmedDesc) => {
    const name = ctx.businessName, site = ctx.website;
    if (!name || !site) { flash("Enter business name + website first"); return null; }
    const desc = (confirmedDesc ?? ctx.businessDescription ?? "").trim();
    const live = searchOk === true && settings.provider === "bridge";
    setBusy("autofill");
    setStep(live
      ? "Filling details from search, anchored to the confirmed identity…"
      : "No live search — deriving what's derivable from the confirmed identity, leaving facts blank…");
    try {
      const system = live ? AUTOFILL_SYS_LIVE : AUTOFILL_SYS_INFER;
      const prompt = mode === "local" ? autofillPromptLocal(name, site, live, desc) : autofillPromptOnline(name, site, live, desc);
      const raw = await askClaude({ provider: settings.provider, model: settings.model, system, user: prompt, search: live, keys: settings.keys });
      const j = parseJSON(raw);

      // NON-DESTRUCTIVE MERGE — new data fills gaps but never wipes what the
      // user already typed. (The previous merge used `j.x || ""`, which
      // overwrote hand-entered fields with blanks.)
      const keep = (fresh, existing) => (fresh && String(fresh).trim()) || existing || "";
      const mergeComps = (freshList, keyFields) =>
        [0, 1, 2].map((i) => {
          const f = freshList?.[i] || {}, e = ctx.competitors?.[i] || {};
          const out = {};
          keyFields.forEach((k) => { out[k] = keep(f[k], e[k]); });
          return out;
        });

      const next = mode === "local" ? {
        ...ctx, businessName: name, website: site, businessDescription: desc || ctx.businessDescription,
        address: keep(j.address, ctx.address), phone: keep(j.phone, ctx.phone), gbpUrl: keep(j.gbpUrl, ctx.gbpUrl),
        primaryService: keep(j.primaryService, ctx.primaryService), services: keep(j.services, ctx.services),
        areas: keep(j.areas, ctx.areas), keywords: keep(j.keywords, ctx.keywords),
        reviewCount: keep(j.reviewCount, ctx.reviewCount), starRating: keep(j.starRating, ctx.starRating),
        reviewsPerMonth: keep(j.reviewsPerMonth, ctx.reviewsPerMonth),
        biggestProblem: keep(j.biggestProblem, ctx.biggestProblem),
        competitors: mergeComps(j.competitors, ["name", "gbpUrl", "website"]),
      } : {
        ...ctx, businessName: name, website: site, businessDescription: desc || ctx.businessDescription,
        niche: keep(j.niche, ctx.niche), productType: keep(j.productType, ctx.productType),
        targetMarket: keep(j.targetMarket, ctx.targetMarket), platforms: keep(j.platforms, ctx.platforms),
        trustProfiles: keep(j.trustProfiles, ctx.trustProfiles), keywords: keep(j.keywords, ctx.keywords),
        biggestProblem: keep(j.biggestProblem, ctx.biggestProblem),
        competitors: mergeComps(j.competitors, ["name", "website"]),
      };
      setState((p) => ({ ...p, ctx: next }));
      setIdentity(null); // confirmation checkpoint passed — hide the panel

      // Honest feedback: count what actually got filled, surface the model's
      // own verification note, and be explicit when little was verifiable.
      const fieldKeys = mode === "local"
        ? ["address", "phone", "gbpUrl", "primaryService", "services", "areas", "keywords", "reviewCount", "starRating", "reviewsPerMonth"]
        : ["niche", "productType", "targetMarket", "platforms", "trustProfiles", "keywords"];
      const filled = fieldKeys.filter((k) => j[k] && String(j[k]).trim()).length;
      const comps = (j.competitors || []).filter((k) => k?.name && String(k.name).trim()).length;
      const note = j._notes ? ` ${j._notes}` : "";
      if (filled === 0 && comps === 0) {
        flash(live
          ? `Search couldn't verify details for this business — nothing was guessed.${note} Fill the fields manually, or use a Cowork prompt for a deep lookup.`
          : `No live search here, and this business isn't specifically known — nothing was guessed.${note} Fill the fields manually (guessed data would corrupt every audit).`);
      } else {
        flash(`${live ? "Researched" : "Filled"} ${filled} field${filled !== 1 ? "s" : ""}${comps ? ` + ${comps} competitor${comps > 1 ? "s" : ""}` : ""}; unverifiable fields left blank.${note} Review everything before running modules.`);
      }
      return next;
    } catch (e) { flash(`Autofill failed: ${e.message}`); return null; }
    finally { setBusy(null); setStep(""); }
  };

  const assess = async (c = ctx, target = "baseline") => {
    setBusy("assess");
    setStep(`Scoring (${target})…`);
    try {
      const prompt = `${ctxBlock(c, mode)}

Score each area 0–10 (0 = missing, 10 = excellent). Return ONLY compact JSON: {scores:{${CATS.map((c) => `${c.id}:0`).join(",")}}, notes:{${CATS.map((c) => `${c.id}:""`).join(",")}}}`;
      const raw = await askClaude({ provider: settings.provider, model: settings.model, user: prompt, keys: settings.keys });
      const j = parseJSON(raw);
      const s = {};
      CATS.forEach((cat) => {
        const v = Number(j.scores?.[cat.id]);
        s[cat.id] = isNaN(v) ? 0 : Math.max(0, Math.min(10, Math.round(v)));
      });
      setModeState({ notes: j.notes || {} });
      if (target === "baseline") {
        setModeState({ baseline: s, current: s, baselineLocked: true });
      } else {
        setModeState({ current: s });
      }
      flash(target === "baseline" ? "Baseline locked" : "Current scores updated");
      return true;
    } catch (e) { flash(`Scoring failed: ${e.message}`); return false; }
    finally { setBusy(null); setStep(""); }
  };

  const runModule = async (m) => {
    setBusy(m.id);
    try {
      const paste = pasteData[m.id] || "";
      const user = m.runTask(ctx) + (paste ? `\n\nPASTED DATA:\n${paste}` : "");
      const system = `You are a senior ${mode === "local" ? "local-SEO" : "digital marketing"} analyst. Output clean markdown with tables.`;
      const out = await runLong({ provider: settings.provider, model: settings.model, system, user, keys: settings.keys, onProgress: (i, n) => setStep(`${m.title} (${i}/${n})…`) });
      setModeState({ outputs: { ...outputs, [m.id]: out }, status: { ...status, [m.id]: "done" } });
      // Extract insights (Phase 3)
      try {
        const insightPrompt = `From this deliverable, extract ONLY {stats:[{label,value}], findings:[string], actions:[{text,impact,eta}], summary:string}: ${out.slice(0, 500)}`;
        const insightRaw = await askClaude({ provider: settings.provider, model: settings.model, user: insightPrompt, keys: settings.keys });
        const insightJson = parseJSON(insightRaw);
        setModeState({ insights: { ...insights, [m.id]: insightJson } });
      } catch (e) { console.error("Insight extraction failed", e); }
    } catch (e) { setModeState({ outputs: { ...outputs, [m.id]: `⚠ ${e.message}` } }); }
    finally { setBusy(null); setStep(""); }
  };

  const runAllModules = async () => {
    if (!ctx.businessName) { flash("Enter business name first"); return; }
    runAllAbort.current = false;
    setBusy("runall");
    const pending = MODULES.filter((m) => status[m.id] !== "done");
    for (let i = 0; i < pending.length; i++) {
      if (runAllAbort.current) break;
      const m = pending[i];
      setRunAllProgress({ current: i + 1, total: pending.length, moduleId: m.id });
      setStep(`${m.grid} (${i + 1}/${pending.length})…`);
      await runModule(m);
    }
    flash(`${pending.length} modules complete`);
    setBusy(null); setStep(""); setRunAllProgress(null);
  };

  // Provider keys now live server-side (env vars read by /api/complete), so
  // "testing a key" here just confirms that provider is reachable through
  // the API route — there's no client-side key to hand an adapter directly.
  const testProviderKey = async (provider) => {
    setTestingKey(provider);
    try {
      await pingClaude(provider, settings.model);
      flash(`✓ ${provider} reachable`);
    } catch (e) { flash(`✗ ${provider} failed: ${e.message}`); }
    finally { setTestingKey(null); }
  };

  const exportAllOutputs = () => {
    const lines = [
      `# ${ctx.businessName || "Business"} — All Module Outputs`,
      `Generated: ${new Date().toLocaleString()}\n`,
    ];
    MODULES.forEach((m) => {
      const out = outputs[m.id];
      const done = status[m.id] === "done";
      lines.push(`## ${m.grid} · ${m.title}\n`);
      if (done && out && !out.startsWith("⚠")) lines.push(out);
      else if (out?.startsWith("⚠")) lines.push(`_Failed:_ ${out}`);
      else lines.push("_Not run yet_");
      lines.push("");
    });
    return lines.join("\n");
  };

  const generateReport = async () => {
    // Phase 4: compile + summarize (with cached insights)
    setBusy("report");
    setStep("Generating report…");
    try {
      const sections = [];
      sections.push(`# ${ctx.businessName} Report`);
      sections.push(`_Generated ${new Date().toLocaleDateString()}_\n`);
      sections.push(`**Score:** ${afterScore}/100 ${hasBaseline ? `(+${afterScore - beforeScore} since baseline)` : ""}`);
      sections.push(`**Modules:** ${doneCount}/${MODULES.length} complete\n`);

      // Compile: phase scores
      PHASES.forEach((p) => {
        sections.push(`### ${p.label}`);
        const score = weighted(current, p.id, CATS);
        sections.push(`Score: **${score}/100**\n`);
      });

      // Add findings from insights
      findings.forEach(({ m, snippet }) => {
        sections.push(`## ${m.grid} · ${m.title}`);
        const insight = insights[m.id];
        if (insight?.summary) sections.push(insight.summary);
        else sections.push(snippet);
        if (insight?.actions) {
          sections.push("### Actions");
          insight.actions.forEach((a) => {
            sections.push(`- **${a.text}** (${a.impact} impact, ${a.eta})`);
          });
        }
        sections.push("");
      });

      // Summarize: final action plan (AI call)
      const summaryPrompt = `From these findings, create a 90-day action priority list (top 10): ${sections.join("\n").slice(0, 1000)}`;
      const summaryRaw = await askClaude({ provider: settings.provider, model: settings.model, user: summaryPrompt, keys: settings.keys });
      sections.push("## 90-Day Action Plan");
      sections.push(summaryRaw);

      const reportHtml = sections.join("\n");
      flash("Report generated — copy to markdown or print");
      setModeState({ reportOutput: reportHtml });
      setTab("report");
    } catch (e) { flash(`Report failed: ${e.message}`); }
    finally { setBusy(null); setStep(""); }
  };

  // ————— UI: Render ———————

  return (
    <div className="rc-root" style={{ minHeight: "100vh", background: `radial-gradient(1200px 500px at 70% -10%, #12242B 0%, ${C.bg} 55%)`, color: C.text, paddingBottom: 80 }}>
      <style>{FONT_CSS}</style>

      {/* HEADER */}
      <header style={{ borderBottom: `1px solid ${C.line}`, padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: `${C.bgDeep}66`, backdropFilter: "blur(6px)" }}>
        <div>
          <h1 className="rc-display" style={{ fontSize: 21, fontWeight: 700, margin: "0 0 4px" }}>Rank Console</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eyebrow color={C.faint}>{mode === "local" ? "Local SEO command center" : "Online business growth hub"}</Eyebrow>
            <span className="rc-mono" style={{ fontSize: 9, letterSpacing: "0.12em", color: apiOk === true ? (searchOk === true ? C.green : C.gold) : apiOk === false ? C.coral : C.faint, display: "flex", alignItems: "center", gap: 4 }}>
              ● {apiOk === true ? (searchOk === true ? "AI + search" : searchOk === false ? "AI only" : "AI online") : apiOk === false ? "offline" : "checking…"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Model selector */}
          <select value={settings.model} onChange={(e) => setSetting("model", e.target.value)}
            style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.text, borderRadius: 6, padding: "6px 8px", fontSize: 12 }}>
            <option value="claude-sonnet-4-6">Sonnet 4.6</option>
            <option value="claude-opus-4-8">Opus 4.8</option>
            <option value="claude-haiku-4-5">Haiku 4.5</option>
            {settings.keys.openai && <option value="gpt-4o">GPT-4o</option>}
          </select>

          {/* Score display */}
          <div style={{ textAlign: "right" }}>
            <div className="rc-mono" style={{ fontSize: 22, color: C.gold, fontWeight: 600 }}>{afterScore || "—"}</div>
            <Eyebrow>score /100</Eyebrow>
          </div>

          {/* Settings button */}
          <button onClick={() => setShowSettings((v) => !v)}
            style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", cursor: "pointer", color: C.dim, fontSize: 16 }}>
            ⚙️
          </button>
        </div>
      </header>

      {/* SETTINGS DRAWER (Phase 1) */}
      {showSettings && (
        <div style={{ background: C.panelUp, borderBottom: `1px solid ${C.line}`, padding: 20, maxWidth: 920, margin: "0 auto" }}>
          <div style={{ display: "grid", gap: 20 }}>
            {/* Provider selection */}
            <div>
              <Eyebrow color={C.gold}>AI Provider</Eyebrow>
              <select value={settings.provider} onChange={(e) => setSetting("provider", e.target.value)}
                style={{ marginTop: 8, background: C.bg, border: `1px solid ${C.line}`, color: C.text, borderRadius: 8, padding: "8px 10px", width: "100%" }}>
                <option value="bridge">Anthropic (bridge — no key needed)</option>
                <option value="anthropic">Anthropic (direct API)</option>
                <option value="openai">OpenAI</option>
                <option value="poyo">Poyo.ai</option>
                <option value="custom">Custom endpoint</option>
              </select>
            </div>

            {/* API keys */}
            <div>
              <Eyebrow color={C.gold}>API Keys</Eyebrow>
              <p style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>Keys are read from server environment variables (set in Vercel → Project Settings). This panel lets you confirm a provider is reachable — it does not store or send a key from the browser.</p>
              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                {["anthropic", "openai", "poyo"].map((prov) => (
                  <div key={prov}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                      <div style={{ flex: 1, fontSize: 12, color: C.dim, padding: "6px 8px" }}>{prov}</div>
                      <Btn small tone="ghost" onClick={() => testProviderKey(prov)} disabled={testingKey === prov}>
                        {testingKey === prov ? "Testing…" : "Test"}
                      </Btn>
                    </div>
                  </div>
                ))}
              </div>

              {/* Custom endpoint */}
              {settings.provider === "custom" && (
                <div style={{ marginTop: 12, padding: 12, background: C.bg, borderRadius: 8, border: `1px solid ${C.line}` }}>
                  <Eyebrow>Custom endpoint</Eyebrow>
                  <p style={{ fontSize: 10.5, color: C.faint, margin: "4px 0 8px", lineHeight: 1.5 }}>
                    Configure the custom endpoint's base URL and key via server environment variables — this panel no longer accepts them from the browser.
                  </p>
                </div>
              )}
            </div>

            {/* Report settings */}
            <div>
              <Eyebrow color={C.gold}>Report Options</Eyebrow>
              <div style={{ marginTop: 10, display: "flex", gap: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={settings.report.includeGraphs} onChange={(e) =>
                    setSetting("report", { ...settings.report, includeGraphs: e.target.checked })
                  } />
                  <span style={{ fontSize: 13 }}>Include graphs</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={settings.report.includeMockups} onChange={(e) =>
                    setSetting("report", { ...settings.report, includeMockups: e.target.checked })
                  } disabled={!settings.keys.fal} style={{ opacity: !settings.keys.fal ? 0.5 : 1 }} />
                  <span style={{ fontSize: 13, opacity: !settings.keys.fal ? 0.6 : 1 }}>Include mockups (requires Fal.ai key)</span>
                </label>
              </div>
            </div>

            {/* Business mode toggle */}
            <div>
              <Eyebrow color={C.gold}>Business Type</Eyebrow>
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                {["local", "online"].map((m) => (
                  <button key={m} onClick={() => switchBusinessMode(m)}
                    style={{
                      flex: 1, padding: "8px 14px", borderRadius: 8, border: `2px solid ${mode === m ? C.gold : C.line}`,
                      background: mode === m ? `${C.gold}20` : "transparent", color: mode === m ? C.gold : C.dim,
                      cursor: "pointer", fontWeight: 600, transition: "all 0.2s",
                    }}>
                    {m === "local" ? "Local Service" : "Online Business"}
                  </button>
                ))}
              </div>
            </div>

            {/* Connection status */}
            <div>
              <Eyebrow color={C.teal}>Connection Status</Eyebrow>
              <div style={{ marginTop: 8, padding: 12, background: C.bg, borderRadius: 8, fontSize: 12, color: C.dim }}>
                <div style={{ marginBottom: 6 }}>
                  <span style={{ color: apiOk === true ? C.green : apiOk === false ? C.coral : C.gold }}>● {apiOk === true ? "API connected" : apiOk === false ? "Offline mode" : "Checking…"}</span>
                </div>
                <div>
                  <span style={{ color: searchOk === true ? C.green : searchOk === false ? C.faint : C.gold }}>● {searchOk === true ? "Web search available" : searchOk === false ? "Web search unavailable" : "Probing…"}</span>
                </div>
                {apiOk === false && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}`, lineHeight: 1.55 }}>
                    {apiError && (
                      <div className="rc-mono" style={{ fontSize: 10.5, color: C.coral, marginBottom: 8, wordBreak: "break-word" }}>
                        Last error: {apiError}
                      </div>
                    )}
                    <p style={{ margin: 0, fontSize: 11.5 }}>
                      The API route couldn't reach the configured provider. Check that ANTHROPIC_API_KEY (and any other provider keys you use) are set in your environment — locally in <span className="rc-mono" style={{ color: C.teal }}>.env.local</span>, or in Vercel → Project → Settings → Environment Variables in production — then retry below.
                    </p>
                  </div>
                )}
              </div>
              <Btn small tone="ghost" onClick={() => detectApi()} style={{ marginTop: 8, width: "100%" }}>
                Retry connection
              </Btn>
            </div>

            <Btn onClick={() => setShowSettings(false)}>Close settings</Btn>
          </div>
        </div>
      )}

      {/* NAV TABS */}
      <nav style={{ display: "flex", gap: 4, padding: "12px 20px 0", borderBottom: `1px solid ${C.line}`, overflowX: "auto", maxWidth: 920, margin: "0 auto" }} className="rc-scroll">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "10px 14px", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit", color: tab === t.id ? C.gold : C.dim, borderBottom: `2px solid ${tab === t.id ? C.gold : "transparent"}`, marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </nav>

      {step && (
        <div className="rc-mono rc-pulse" style={{ padding: "10px 20px", fontSize: 12, color: C.teal, borderBottom: `1px solid ${C.line}` }}>
          ◈ {step}
        </div>
      )}

      {/* MAIN CONTENT */}
      <main style={{ maxWidth: 920, margin: "0 auto", padding: "24px 20px" }}>

        {/* DASHBOARD TAB */}
        {tab === "dash" && (
          <div className="rc-fade">
            {!ctx.businessName ? (
              <Panel style={{ padding: "38px 28px", textAlign: "center" }}>
                <div className="rc-display" style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Get started</div>
                <Btn onClick={() => setTab("setup")}>Go to Setup →</Btn>
              </Panel>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
                  <div>
                    <Eyebrow color={C.gold}>Overview</Eyebrow>
                    <h2 className="rc-display" style={{ fontSize: 26, fontWeight: 700, margin: "4px 0 2px" }}>{ctx.businessName}</h2>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {nextModule && <Btn small onClick={() => setTab("modules")}>Next module →</Btn>}
                    {hasBaseline && <Btn small tone="teal" onClick={() => assess(ctx, "current")} disabled={anyBusy}>Re-assess</Btn>}
                    {doneCount > 0 && <Btn small onClick={generateReport} disabled={anyBusy || !hasBaseline}>Generate report</Btn>}
                  </div>
                </div>

                {/* Stat tiles */}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
                  <StatTile label="Score" value={afterScore || "—"} sub={hasBaseline ? `baseline ${beforeScore}` : "no baseline"} color={C.gold} />
                  <StatTile label="Progress" value={hasBaseline ? `${afterScore - beforeScore >= 0 ? "+" : ""}${afterScore - beforeScore}` : "—"} sub="points" color={afterScore - beforeScore > 0 ? C.green : C.dim} />
                  <StatTile label="Modules" value={`${doneCount}/${MODULES.length}`} sub={`${MODULES.length - doneCount} left`} />
                </div>

                {/* Gauge + phase breakdown */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
                  <Panel style={{ flex: "1 1 280px", padding: 20, display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <Gauge before={beforeScore} after={afterScore} size={280} />
                  </Panel>
                  <Panel style={{ flex: "1 1 320px", padding: 20 }}>
                    <Eyebrow color={C.teal}>By phase</Eyebrow>
                    <div style={{ marginTop: 14 }}>
                      {PHASES.map((p) => <PhaseBar key={p.id} phase={p} baseline={baseline} current={current} cats={CATS} />)}
                    </div>
                  </Panel>
                </div>

                {/* Module pipeline */}
                <Panel style={{ padding: 20, marginBottom: 20 }}>
                  <Eyebrow color={C.gold}>Module pipeline</Eyebrow>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginTop: 12 }}>
                    {MODULES.map((m) => (
                      <button key={m.id} onClick={() => setTab("modules")}
                        style={{
                          background: status[m.id] === "done" ? `${C.green}14` : C.bg,
                          border: `1px solid ${status[m.id] === "done" ? C.greenDim : C.line}`,
                          borderRadius: 9, padding: "9px 10px", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                        }}>
                        <div className="rc-mono" style={{ fontSize: 9.5, color: status[m.id] === "done" ? C.green : C.faint, marginBottom: 3 }}>
                          {status[m.id] === "done" ? "✓" : "○"} {m.grid}
                        </div>
                        <div style={{ fontSize: 11, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
                      </button>
                    ))}
                  </div>
                </Panel>

                {/* Gaps + improvements */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <Panel style={{ flex: "1 1 300px", padding: 20 }}>
                    <Eyebrow color={C.coral}>Biggest gaps</Eyebrow>
                    {gaps.length === 0 ? (
                      <p style={{ fontSize: 13, color: C.faint, marginTop: 10 }}>Set a baseline to see gaps</p>
                    ) : gaps.map((g) => (
                      <div key={g.id} style={{ marginTop: 12, paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{g.label}</div>
                        {g.note && <div style={{ fontSize: 11, color: C.faint }}>{g.note}</div>}
                        <span className="rc-mono" style={{ fontSize: 12, color: C.coral }}>{g.cur}/10</span>
                      </div>
                    ))}
                  </Panel>
                  <Panel style={{ flex: "1 1 300px", padding: 20 }}>
                    <Eyebrow color={C.green}>Improvements</Eyebrow>
                    {improvements.length === 0 ? (
                      <p style={{ fontSize: 13, color: C.faint, marginTop: 10 }}>Gains will appear here</p>
                    ) : improvements.map((r) => (
                      <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                        <span className="rc-mono" style={{ fontSize: 12, color: C.green }}>+{r.d}</span>
                        <div style={{ flex: 1, fontSize: 12 }}>{r.label}</div>
                      </div>
                    ))}
                  </Panel>
                </div>
              </>
            )}
          </div>
        )}

        {/* SETUP TAB */}
        {tab === "setup" && (
          <div className="rc-fade">
            <Panel style={{ padding: 20, marginBottom: 18 }}>
              <Eyebrow color={C.gold}>Business profile</Eyebrow>
              <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginTop: 12 }}>
                {mode === "local" ? (
                  <>
                    <Field label="Business name" value={ctx.businessName} onChange={setCtx("businessName")} ph="Ridge Roofing" />
                    <Field label="Website" value={ctx.website} onChange={setCtx("website")} ph="https://…" />
                    <Field label="Phone" value={ctx.phone} onChange={setCtx("phone")} ph="(02) 9000 0000" />
                    <Field label="Address" value={ctx.address} onChange={setCtx("address")} ph="123 Main St" />
                    <Field label="GBP URL" value={ctx.gbpUrl} onChange={setCtx("gbpUrl")} ph="https://maps.google.com/…" />
                    <Field label="Primary service" value={ctx.primaryService} onChange={setCtx("primaryService")} ph="roof replacement" />
                    <Field label="Services (comma-sep)" value={ctx.services} onChange={setCtx("services")} ph="repairs, gutters" area />
                    <Field label="Areas (comma-sep)" value={ctx.areas} onChange={setCtx("areas")} ph="Croydon, Burwood" area />
                    <Field label="Keywords (comma-sep)" value={ctx.keywords} onChange={setCtx("keywords")} ph="roof replacement croydon" area />
                    <Field label="Reviews total" value={ctx.reviewCount} onChange={setCtx("reviewCount")} ph="48" />
                    <Field label="Rating" value={ctx.starRating} onChange={setCtx("starRating")} ph="4.7" />
                    <Field label="Reviews/month" value={ctx.reviewsPerMonth} onChange={setCtx("reviewsPerMonth")} ph="3" />
                  </>
                ) : (
                  <>
                    <Field label="Business name" value={ctx.businessName} onChange={setCtx("businessName")} ph="SaaS Company" />
                    <Field label="Website" value={ctx.website} onChange={setCtx("website")} ph="https://…" />
                    <Field label="Niche" value={ctx.niche} onChange={setCtx("niche")} ph="project management software" />
                    <Field label="Product type" value={ctx.productType} onChange={setCtx("productType")} ph="SaaS platform" />
                    <Field label="Target market" value={ctx.targetMarket} onChange={setCtx("targetMarket")} ph="US / global / agencies" />
                    <Field label="Platforms" value={ctx.platforms} onChange={setCtx("platforms")} ph="Shopify, Instagram" />
                    <Field label="Trust profiles" value={ctx.trustProfiles} onChange={setCtx("trustProfiles")} ph="G2, Trustpilot" area />
                    <Field label="Keywords (comma-sep)" value={ctx.keywords} onChange={setCtx("keywords")} ph="project management tool" area />
                  </>
                )}
                <div style={{ gridColumn: "1 / -1" }}>
                  <Field label="What the business does (owner-confirmed ground truth — anchors every module)" value={ctx.businessDescription} onChange={setCtx("businessDescription")} ph="e.g. Sells AI-generated vector illustration packs to indie game developers" area />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <Field label="Biggest problem" value={ctx.biggestProblem} onChange={setCtx("biggestProblem")} ph="Not ranking for [keyword]" area />
                </div>
              </div>

              {/* Competitors */}
              <div style={{ marginTop: 20 }}>
                <Eyebrow>Competitors</Eyebrow>
                <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
                  {ctx.competitors.map((k, i) => (
                    <div key={i} style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                      <Field label={`Competitor ${i + 1}`} value={k.name} onChange={setComp(i, "name")} ph="name" />
                      {mode === "local" && <Field label="GBP URL" value={k.gbpUrl} onChange={setComp(i, "gbpUrl")} ph="https://maps…" />}
                      <Field label="Website" value={k.website} onChange={setComp(i, "website")} ph="https://…" />
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Btn onClick={() => identifyBusiness()} disabled={!ctx.businessName || !ctx.website || anyBusy}>
                  {busy === "identify" ? "Identifying…" : busy === "autofill" ? "Auto-filling…" : ctx.businessDescription ? "Re-identify + auto-fill" : "Auto-fill (2-step)"}
                </Btn>
                <Btn tone="teal" onClick={() => assess(ctx, "baseline")} disabled={!ctx.businessName || anyBusy}>
                  {busy === "assess" ? "Scoring…" : "Score baseline"}
                </Btn>
              </div>
              <p className="rc-mono" style={{ fontSize: 10, color: C.faint, marginTop: 10, lineHeight: 1.5 }}>
                AUTO-FILL IS 2-STEP: first it identifies what the business is and shows you — you confirm or correct before anything is filled. That checkpoint is what stops a wrong guess from polluting every field, keyword, and audit downstream.
              </p>

              {/* ——— IDENTITY CONFIRMATION CHECKPOINT ——— */}
              {identity && (
                <div className="rc-fade" style={{ marginTop: 14, padding: 14, background: `${C.gold}0E`, border: `1px solid ${C.goldDim}`, borderRadius: 10 }}>
                  <Eyebrow color={C.gold}>Step 1 result — is this right?</Eyebrow>
                  {identity.summary ? (
                    <>
                      <p style={{ fontSize: 13.5, margin: "8px 0 4px", lineHeight: 1.55 }}>{identity.summary}</p>
                      <div className="rc-mono" style={{ fontSize: 10.5, color: identity.confidence === "high" ? C.green : identity.confidence === "medium" ? C.gold : C.coral, marginBottom: 6 }}>
                        confidence: {identity.confidence}{identity.isLocal !== "unknown" ? ` · ${identity.isLocal === "true" ? "local/service-area" : "online-only"} business` : ""}{!identity.live ? " · from training knowledge, not live search" : ""}
                      </div>
                      {identity.evidence && <p style={{ fontSize: 11.5, color: C.faint, margin: "0 0 10px", lineHeight: 1.5 }}>Evidence: {identity.evidence}</p>}
                    </>
                  ) : (
                    <p style={{ fontSize: 12.5, color: C.dim, margin: "8px 0 10px", lineHeight: 1.55 }}>
                      Nothing verifiable was found for this business{identity.evidence ? ` (found instead: ${identity.evidence})` : ""}. This is expected for a genuinely new site — search engines can take days to weeks to index a domain, so zero search results doesn't mean anything is wrong here or with the site. Describe it below in a sentence or two — that description becomes the ground truth every field and module is built from.
                    </p>
                  )}
                  <textarea value={identityEdit} onChange={(e) => setIdentityEdit(e.target.value)}
                    placeholder="e.g. VectorSquid sells AI-generated vector illustration packs to indie game developers"
                    rows={2}
                    style={{ width: "100%", background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, color: C.text, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", marginBottom: 10 }} />

                  {/* MODE CHECK — deliberately part of THIS checkpoint, not
                      tucked away in Settings. A local-service business run
                      through the online prompt (or vice versa) doesn't error
                      — it silently blanks the fields anchored to concepts
                      that don't apply (a local competitor search needs a
                      city/GBP; an online one doesn't), and competitors is
                      usually the first thing that goes empty. Catching the
                      mismatch here, right before the fill call fires, is
                      what actually prevents that — a signal shown elsewhere
                      that nothing reads doesn't. */}
                  {(() => {
                    const suggested = identity.isLocal === "true" ? "local" : identity.isLocal === "false" ? "online" : null;
                    const mismatch = suggested && suggested !== mode;
                    return (
                      <div style={{ marginBottom: 10, padding: 10, background: mismatch ? `${C.coral}14` : C.bg, border: `1px solid ${mismatch ? C.coral + "55" : C.line}`, borderRadius: 8 }}>
                        {mismatch && (
                          <p style={{ fontSize: 11.5, color: C.coral, margin: "0 0 8px", lineHeight: 1.5 }}>
                            ⚠ Step 1 read this as {suggested === "local" ? "a local/service-area" : "an online-only"} business, but the app is set to <strong>{mode === "local" ? "Local Service" : "Online Business"}</strong>. Filling in the wrong mode is exactly what leaves competitors (and other mode-specific fields) empty — switch below before continuing.
                          </p>
                        )}
                        <Eyebrow color={mismatch ? C.coral : C.faint}>Business type — confirm before filling</Eyebrow>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          {["local", "online"].map((m) => (
                            <button key={m} onClick={() => switchBusinessMode(m)}
                              style={{
                                flex: 1, padding: "7px 12px", borderRadius: 7, fontSize: 12.5, cursor: "pointer", fontWeight: 600,
                                border: `2px solid ${mode === m ? C.gold : C.line}`,
                                background: mode === m ? `${C.gold}20` : "transparent",
                                color: mode === m ? C.gold : C.dim,
                              }}>
                              {m === "local" ? "Local Service" : "Online Business"}{suggested === m ? " ✓" : ""}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Btn small onClick={() => {
                      const desc = identityEdit.trim();
                      if (!desc) { flash("Type what the business does first — that's the ground truth everything else is built from"); return; }
                      setState((p) => ({ ...p, ctx: { ...p.ctx, businessDescription: desc } }));
                      autofill(desc);
                    }} disabled={anyBusy}>
                      {identity.summary && identityEdit.trim() === identity.summary.trim() ? "✓ Correct — fill the rest" : "Use my description — fill the rest"}
                    </Btn>
                    <Btn small tone="ghost" onClick={() => { setIdentity(null); setIdentityEdit(""); }} disabled={anyBusy}>Cancel</Btn>
                  </div>
                </div>
              )}
            </Panel>
          </div>
        )}

        {/* MODULES TAB */}
        {tab === "modules" && (
          <div className="rc-fade">
            {apiOk === false && (
              <Panel style={{ padding: 14, marginBottom: 14, background: `${C.coral}12`, border: `1px solid ${C.coral}55` }}>
                <div className="rc-mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: C.coral, marginBottom: 6 }}>● OFFLINE MODE</div>
                <p style={{ margin: 0, fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
                  AI isn't reachable from this context. Use the Cowork prompts below (copy, paste into Claude, bring results back) — that path gives tool-grade data anyway (Chrome, Maps, SEMrush, Ahrefs, Search Console).
                </p>
              </Panel>
            )}
            <Panel style={{ padding: 16, marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <Eyebrow>Module runner</Eyebrow>
                  <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{doneCount}/{MODULES.length} complete</div>
                </div>
                <Btn onClick={runAllModules} disabled={anyBusy || !ctx.businessName || apiOk === false}>
                  ▶ Run all
                </Btn>
              </div>
              {busy === "runall" && runAllProgress && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ height: 5, background: C.line, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${(runAllProgress.current / runAllProgress.total) * 100}%`, height: "100%", background: C.gold, transition: "width 0.4s" }} />
                  </div>
                  <div className="rc-mono" style={{ fontSize: 10, color: C.faint, marginTop: 6 }}>
                    {MODULES.find((m) => m.id === runAllProgress.moduleId)?.grid}
                  </div>
                </div>
              )}
            </Panel>

            {PHASES.map((p) => (
              <div key={p.id} style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
                  <Eyebrow color={p.color}>{p.label}</Eyebrow>
                  <div style={{ flex: 1, height: 1, background: C.line }} />
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {MODULES.filter((m) => m.phase === p.id).map((m) => {
                    const isOpen = open === m.id;
                    const done = status[m.id] === "done";
                    return (
                      <Panel key={m.id} style={{ overflow: "hidden" }}>
                        <button onClick={() => setOpen(isOpen ? null : m.id)}
                          style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, textAlign: "left", fontFamily: "inherit", color: C.text }}>
                          <span className="rc-mono" style={{ fontSize: 9.5, color: p.color }}>{m.grid}</span>
                          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{m.title}</span>
                          <span className="rc-mono" style={{ fontSize: 10, color: done ? C.green : C.faint }}>{done ? "✓ DONE" : "○ PENDING"}</span>
                        </button>
                        {isOpen && (
                          <div style={{ padding: "0 16px 14px", borderTop: `1px solid ${C.line}` }}>
                            <p style={{ fontSize: 13, color: C.dim, margin: "10px 0" }}>{m.what}</p>
                            {m.pasteLabel && (
                              <textarea value={pasteData[m.id] || ""} onChange={(e) => setPasteData((p) => ({ ...p, [m.id]: e.target.value }))}
                                placeholder={m.pasteLabel} rows={2}
                                style={{ width: "100%", marginBottom: 10, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, color: C.text, padding: "8px", fontSize: 12 }} />
                            )}
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                              <Btn small onClick={() => runModule(m)} disabled={anyBusy}>
                                {busy === m.id ? "Running…" : "Run"}
                              </Btn>
                              <Btn small tone="teal" onClick={() => copy(m.prompt(ctx))}>Copy Cowork prompt</Btn>
                              <Btn small tone="ghost" onClick={() => setModeState({ status: { ...status, [m.id]: done ? undefined : "done" } })}>
                                {done ? "Mark undone" : "Mark done"}
                              </Btn>
                            </div>
                            {outputs[m.id] && (
                              <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, maxHeight: 300, overflow: "auto" }}>
                                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: C.dim, lineHeight: 1.4 }}>{outputs[m.id].slice(0, 500)}</pre>
                                <Btn small tone="teal" onClick={() => copy(outputs[m.id])} style={{ marginTop: 8 }}>Copy full output</Btn>
                              </div>
                            )}
                          </div>
                        )}
                      </Panel>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* SCORECARD TAB */}
        {tab === "score" && (
          <div className="rc-fade">
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              {confirmReset ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: C.coral }}>Clear every score cell?</span>
                  <Btn small tone="coral" onClick={resetScores}>Confirm reset</Btn>
                  <Btn small tone="ghost" onClick={() => setConfirmReset(false)}>Cancel</Btn>
                </div>
              ) : (
                <Btn small tone="ghost" onClick={() => setConfirmReset(true)} disabled={beforeScore === 0 && afterScore === 0}>
                  ↺ Reset scores
                </Btn>
              )}
            </div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 20 }}>
              <div style={{ flex: "1 1 280px" }}>
                <Gauge before={beforeScore} after={afterScore} />
              </div>
              <Panel style={{ flex: "1 1 280px", padding: 20 }}>
                <h3 style={{ margin: "0 0 10px", fontSize: 16, fontWeight: 600 }}>Before / After</h3>
                <p style={{ fontSize: 13, color: C.dim, lineHeight: 1.6, margin: 0 }}>
                  Grey arc = baseline (locked). Gold = current. Run modules and hit re-assess to close the gap.
                </p>
                <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!baselineLocked ? (
                    <>
                      <Btn small onClick={() => assess(ctx, "baseline")} disabled={anyBusy}>AI-score baseline</Btn>
                      <Btn small tone="ghost" onClick={() => setModeState({ baselineLocked: true })} disabled={beforeScore === 0}>Lock manual</Btn>
                    </>
                  ) : (
                    <>
                      <Btn small tone="teal" onClick={() => assess(ctx, "current")} disabled={anyBusy}>Re-assess current</Btn>
                      <Btn small tone="ghost" onClick={() => setModeState({ baselineLocked: false })}>Unlock</Btn>
                    </>
                  )}
                </div>
              </Panel>
            </div>

            {/* Score rows */}
            <Panel style={{ padding: "12px 18px" }}>
              {CATS.map((cat) => {
                const b = baseline[cat.id] ?? null, cur = current[cat.id] ?? null;
                const d = b != null && cur != null ? cur - b : null;
                return (
                  <div key={cat.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.line}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
                      <span style={{ fontSize: 13 }}>{cat.label}</span>
                      <span className="rc-mono" style={{ fontSize: 11, color: d == null ? C.faint : d > 0 ? C.green : C.coral }}>
                        {b ?? "—"} → {cur ?? "—"}
                      </span>
                    </div>
                    <input type="range" min={0} max={10} step={1} value={baselineLocked ? (cur ?? 0) : (b ?? 0)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (baselineLocked) setModeState({ current: { ...current, [cat.id]: v } });
                        else setModeState({ baseline: { ...baseline, [cat.id]: v }, current: { ...current, [cat.id]: v } });
                      }}
                      style={{ width: "100%", accentColor: C.gold, height: 4 }} />
                  </div>
                );
              })}
            </Panel>
          </div>
        )}

        {/* REPORT TAB (Phase 4) */}
        {tab === "report" && (
          <div className="rc-fade">
            {doneCount === 0 ? (
              <Panel style={{ padding: "38px 28px", textAlign: "center" }}>
                <div className="rc-display" style={{ fontSize: 24, marginBottom: 8 }}>No report yet</div>
                <p style={{ color: C.dim, margin: "0 0 16px" }}>Run at least one module to generate a report.</p>
                <Btn onClick={() => setTab("modules")}>Go to modules →</Btn>
              </Panel>
            ) : (
              <Panel style={{ padding: 20 }}>
                <Eyebrow>Report</Eyebrow>
                <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  <Btn small onClick={generateReport} disabled={busy === "report" || !hasBaseline}>
                    {busy === "report" ? "Generating…" : "Generate"}
                  </Btn>
                  <Btn small tone="teal" onClick={() => window.print()}>Print / PDF</Btn>
                  <Btn small tone="ghost" onClick={() => copy(findings.map((f) => `${f.m.grid}: ${f.snippet}`).join("\n\n"))}>Copy findings</Btn>
                </div>
                <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, maxHeight: 500, overflow: "auto" }}>
                  <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.6 }}>
                    <h3 style={{ marginTop: 0 }}>Generated reports appear here</h3>
                    <p>Score: {afterScore}/100</p>
                    <p>Completed modules: {doneCount}/{MODULES.length}</p>
                  </div>
                </div>
              </Panel>
            )}
          </div>
        )}

        {/* EXPORT TAB */}
        {tab === "export" && (
          <div className="rc-fade">
            <Panel style={{ padding: 20 }}>
              <Eyebrow color={C.gold}>Export all outputs</Eyebrow>
              <p style={{ fontSize: 13, color: C.dim, margin: "10px 0 14px" }}>Download or copy all module outputs as markdown.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                <Btn small onClick={() => copy(exportAllOutputs())}>Copy as markdown</Btn>
                <Btn small tone="teal" onClick={() => {
                  const blob = new Blob([exportAllOutputs()], { type: "text/markdown" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `rank-console-${new Date().toISOString().split("T")[0]}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}>Download as .md</Btn>
              </div>
              <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, maxHeight: 400, overflow: "auto" }}>
                <pre style={{ margin: 0, fontSize: 11, color: C.dim, lineHeight: 1.4, whiteSpace: "pre-wrap" }}>
                  {exportAllOutputs().slice(0, 800)}
                </pre>
              </div>
            </Panel>
          </div>
        )}
      </main>

      {/* TOAST */}
      {toast && (
        <div className="rc-fade rc-mono" style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: C.panelUp, border: `1px solid ${C.goldDim}`, color: C.gold, borderRadius: 10, padding: "10px 18px", fontSize: 12, zIndex: 50, boxShadow: "0 8px 30px -8px rgba(0,0,0,.6)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
