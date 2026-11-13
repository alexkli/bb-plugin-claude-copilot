// The copilot-api usage dashboard, served through bb.
//
// The page runs in a sandboxed iframe (opaque origin: no access to bb, its
// cookies or storage). A script injected first into its <head> sends the
// page's API fetches to the embedding bb page via postMessage; that page calls
// this plugin's /proxy route, which reads the private copilot-api through the
// host entry.

/** Virtual path the dashboard thinks its API lives under; the shim rewrites it. */
export const VIRTUAL = "/__claude_copilot";
export const MESSAGE_FETCH = "claude-copilot:fetch";
export const MESSAGE_RESPONSE = "claude-copilot:response";

/** Upstream API paths the dashboard may read (GET only). */
export const DASHBOARD_PATHS = /^\/(usage|token-usage|models)(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

export const SHIM = `<script>(() => {
  const V = ${JSON.stringify(VIRTUAL)};
  const pending = new Map();
  let seq = 0;
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.type !== ${JSON.stringify(MESSAGE_RESPONSE)} || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new TypeError(m.error));
    else resolve(new Response(m.body, { status: m.status, headers: { "content-type": m.contentType } }));
  });
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let u;
    try {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      u = new URL(raw, location.href);
    } catch {}
    if (!u || !u.pathname.startsWith(V + "/")) return orig(input, init);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ type: ${JSON.stringify(MESSAGE_FETCH)}, id, path: u.pathname.slice(V.length) + u.search }, "*");
    });
  };
  // Opaque origins have no storage; give the page an in-memory stand-in.
  const mem = () => { const d = new Map(); return {
    getItem: (k) => (d.has(String(k)) ? d.get(String(k)) : null),
    setItem: (k, v) => void d.set(String(k), String(v)),
    removeItem: (k) => void d.delete(String(k)),
    clear: () => d.clear(), key: (i) => [...d.keys()][i] ?? null,
    get length() { return d.size; } }; };
  for (const name of ["localStorage", "sessionStorage"]) {
    try { window[name].length; } catch {
      try { Object.defineProperty(window, name, { value: mem(), configurable: true }); } catch {}
    }
  }
  for (const name of ["pushState", "replaceState"]) {
    const f = history[name].bind(history);
    history[name] = (...args) => { try { return f(...args); } catch {} };
  }
})();</script>`;

/** Applied to the viewer even if opened directly: no same-origin, no popups, no top navigation. */
export const VIEWER_CSP = "sandbox allow-scripts allow-forms; frame-ancestors 'self'";
