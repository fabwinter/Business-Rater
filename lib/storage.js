/**
 * lib/storage.js
 * ─────────────────────────────────────────────────────────────────
 * Drop-in replacement for the Claude-artifact-only `window.storage`
 * API. Same async get/set/delete/list signature, backed by
 * localStorage instead — so RankConsole.jsx's existing
 * `await window.storage.get(key)` calls work completely unchanged.
 *
 * Import this once, early (e.g. in app/layout.js or at the top of
 * components/RankConsole.jsx) — it attaches itself to `window.storage`
 * as a side effect on load. No other wiring needed.
 *
 * Scope: per-browser only, not per-account. Two devices/browsers will
 * not see each other's data. That's the right default for a personal
 * tool; if you need cross-device sync later, this is the one file to
 * swap out — everything else in the app is agnostic to how storage
 * actually persists.
 * ─────────────────────────────────────────────────────────────────
 */

const PREFIX = "rc:"; // namespaced so this app doesn't collide with anything else in localStorage

function fullKey(key, shared) {
  // `shared` has no real meaning for a single-browser store — kept as a
  // parameter only so the interface matches window.storage exactly and
  // callers written against that API don't need to change.
  return `${PREFIX}${shared ? "shared:" : "personal:"}${key}`;
}

const storage = {
  async get(key, shared = false) {
    if (typeof window === "undefined") return null; // SSR guard
    const raw = window.localStorage.getItem(fullKey(key, shared));
    if (raw === null) {
      // window.storage.get throws on a missing key rather than
      // returning null — matched here so existing try/catch call
      // sites behave identically.
      throw new Error(`Key not found: ${key}`);
    }
    return { key, value: raw, shared };
  },

  async set(key, value, shared = false) {
    if (typeof window === "undefined") return null;
    try {
      window.localStorage.setItem(fullKey(key, shared), value);
      return { key, value, shared };
    } catch (e) {
      console.error("storage.set failed", e);
      return null;
    }
  },

  async delete(key, shared = false) {
    if (typeof window === "undefined") return null;
    const k = fullKey(key, shared);
    const existed = window.localStorage.getItem(k) !== null;
    window.localStorage.removeItem(k);
    return { key, deleted: existed, shared };
  },

  async list(prefix = "", shared = false) {
    if (typeof window === "undefined") return null;
    const scope = `${PREFIX}${shared ? "shared:" : "personal:"}`;
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const full = window.localStorage.key(i);
      if (full && full.startsWith(scope + prefix)) {
        keys.push(full.slice(scope.length));
      }
    }
    return { keys, prefix, shared };
  },
};

if (typeof window !== "undefined") {
  window.storage = storage;
}

export default storage;
