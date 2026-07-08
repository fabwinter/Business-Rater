# Rank Console → GitHub + Vercel: Migration Guide

## Why this is worth doing

Every workaround this session has been patching around one fact: the app has no server. Moving it to Vercel gives it one, and that resolves the root cause instead of another symptom:

| Problem this session | Root cause | Fixed by having a server |
|---|---|---|
| "Poyo load failed" (CORS) | Third-party API has no CORS allowance for browser callers | ✅ Server-to-server call, no browser CORS at all |
| Bridge only works inside claude.ai | Artifact-only auth interception | ✅ Real API key held server-side, works anywhere |
| Keys stored in cleartext in browser | No secret storage available client-side | ✅ Environment variables, never sent to browser |
| `window.storage` (Claude-only API) | No persistence layer of your own | ✅ `localStorage` today, real DB later if you want |
| Can't share the app with someone else | It only exists inside your chat | ✅ A real URL, works for anyone |

None of this needs a rewrite of the 2,150-line component. It needs: swap the storage calls, swap the "how do I call an LLM" layer, deploy.

## What actually has to change

### 1. Storage — `window.storage` → `localStorage`
Smallest, safest change. `lib/storage.js` (below) exposes the exact same `get/set/delete/list` async interface and attaches itself to `window.storage` on import — so the 2,150 lines of existing `await window.storage.get(...)` calls throughout `RankConsole.jsx` **do not need to change**.

*Upgrade path later, not required now:* if you want scores/outputs to sync across devices instead of living in one browser, swap `lib/storage.js`'s internals for Vercel KV or Postgres. The interface the component uses stays identical either way.

### 2. AI calls — `ProviderRegistry` direct fetches → one API route
Currently the client fetches `api.anthropic.com`, `api.openai.com`, `api.poyo.ai` directly — which is exactly what CORS blocks. Replace all of it with one call to your own `/api/complete`, which runs server-side and holds every key.

This also means you can delete:
- `corsAwareFetch` and its error-message plumbing (no longer needed — same-origin calls don't hit CORS)
- The `bridge` adapter entirely (was claude.ai-only; the API route replaces it for every environment)
- The Poyo Cloudflare Worker proxy (your own `/api/complete` **is** that proxy now, with less to deploy)

The client-side `askClaude`/`runLong`/`parseJSON` logic (retry, continuation-on-truncation, JSON extraction) stays exactly as-is — only the innermost `callOnce` needs to change from six separate fetches to one `fetch('/api/complete', {...})`.

### 3. Keys — browser storage → environment variables
Set once in Vercel's dashboard (Project → Settings → Environment Variables), never touch the browser:
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
POYO_API_KEY=...
```
The Settings drawer's key-input UI can either be removed (if you're the only user) or repurposed to let a signed-in user paste a key that gets forwarded per-request instead of stored — your call depending on whether this stays single-user or becomes multi-user.

## Step-by-step

1. `npx create-next-app@latest rank-console` (App Router, no TypeScript unless you want it, Tailwind optional — the component already ships its own inline styles)
2. Drop the starter files below into the new project (they're written to match that scaffold exactly)
3. Move the existing `rank-console-v5.jsx` content into `components/RankConsole.jsx`, changing only:
   - Add `"use client";` as the very first line (the component uses `useState`/`useEffect`/`useRef` — App Router treats files as Server Components by default, which don't support hooks)
   - Add `import "../lib/storage";` right after that — this must live here, not in `app/layout.js` (that file is a Server Component; `window` doesn't exist when it renders, so the shim wouldn't reliably attach before this component mounts and calls `window.storage.get(...)`)
   - Delete the `ProviderRegistry` object and `corsAwareFetch` — replaced by the one-liner in `callOnce` below
   - Replace `callOnce`'s body with the version in this guide (calls `/api/complete`)
4. `git init && git add -A && git commit -m "initial"` → push to a new GitHub repo
5. [vercel.com/new](https://vercel.com/new) → import the repo → paste in the env vars above → Deploy
6. Every `git push` after that auto-deploys; every PR gets its own preview URL for free

## Simplified `callOnce` (replaces the entire `ProviderRegistry`)

```javascript
async function callOnce({ provider, model, system, user, maxTokens = 1000, search = false }) {
  const res = await fetch('/api/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, system, user, maxTokens, search }),
  });
  const data = await res.json();
  // The route returns HTTP 200 with an `error` field for provider/API
  // failures (so this matches what askClaude's existing retry logic
  // already expects), and a 4xx only for malformed requests — check
  // `data.error` first, not just res.ok.
  if (data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data.text;
}
```
That's it — this one function now does what six adapter objects and a CORS-catching wrapper did before, because the hard part (reaching each provider) moved server-side where it belongs.

## Honest caveats

- I don't have network access in this environment, so none of this has been run through an actual `next build` or a live Vercel deploy — it follows standard, well-documented Next.js App Router conventions, but treat it as a verified-by-convention starting point, not a tested one. Run `npm run build` locally before your first deploy to catch anything environment-specific.
- `localStorage` is per-browser, not per-account — if two people (or you on two devices) open the deployed URL, they will *not* see each other's data. That's fine for a personal tool; flag it if you want multi-device sync, since that's a slightly bigger change (needs a real database + some form of auth).
- The web-search tool (`web_search_20250305`) is an Anthropic-specific server tool — it'll keep working through `/api/complete` when `provider: "anthropic"`, but OpenAI/Poyo calls won't have it (same limitation as today, just cleaner to reason about now that it's one code path).
