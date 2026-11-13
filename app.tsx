// Frontend of bb-plugin-claude-copilot:
// - provider icon for "Claude Code (Copilot)": the orange Claude mark with the
//   GitHub Copilot glyph in the bottom-right corner (same layout as the
//   claude-bedrock plugin's AWS badge); keep in sync with icons/claude-copilot.svg
// - settings section: GitHub sign-in, copilot-api status, config.json editor
// - usage dashboard page + sidebar footer button
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { AppStatus, appContract } from "./contract";
import { CLAUDE_MARK, COPILOT_PATHS } from "./icon-paths";
import { MESSAGE_FETCH, MESSAGE_RESPONSE, VIRTUAL } from "./dashboard";

const PROVIDER_ID = "claude-copilot";
const BASE = "/api/v1/plugins/claude-copilot/http";
const PANEL_PATH = "usage";
const COPILOT_ICON = "claude-copilot/copilot";

// ---------------------------------------------------------------------------
// Icons

function ClaudeCopilotIcon({ className }: { className?: string }) {
  const mask = useId();
  return (
    // explicit width/height: without them WebKit (iOS app) sizes the svg at 300px
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="16" height="16" className={className} aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="1200" height="1200" fill="#fff" />
          <rect x="560" y="640" width="660" height="580" rx="170" fill="#000" />
        </mask>
      </defs>
      <path fill="#D97757" mask={`url(#${mask})`} d={CLAUDE_MARK} />
      {/* Copilot glyph in the theme's text colour */}
      <g transform="translate(624 674) scale(11.5)" fill="currentColor">
        {COPILOT_PATHS.map((d) => (
          <path key={d.slice(0, 16)} d={d} />
        ))}
      </g>
    </svg>
  );
}

function CopilotIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="16" height="16" fill="currentColor" className={className} aria-hidden="true">
      {COPILOT_PATHS.map((d) => (
        <path key={d.slice(0, 16)} d={d} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Settings section

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function SettingsSection() {
  const rpc = useRpc<typeof appContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => setError(errorText(cause)), []);
  const refresh = useCallback(() => {
    rpc.call("status").then((s) => {
      setStatus(s);
      setError(null);
    }, report);
  }, [rpc, report]);
  const loadConfig = useCallback(() => {
    rpc.call("getConfig").then((c) => {
      setConfig(c.json);
      setConfigMessage(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refresh();
    loadConfig();
  }, [refresh, loadConfig]);

  // Poll while the GitHub sign-in waits for the user.
  const waiting = status?.login.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const run = (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    action()
      .then(() => refresh(), report)
      .finally(() => setBusy(null));
  };

  const saveConfig = () => {
    if (config === null) return;
    setBusy("config");
    rpc
      .call("setConfig", { json: config })
      .then(
        (r) => setConfigMessage(r.message),
        (cause: unknown) => setConfigMessage(errorText(cause)),
      )
      .finally(() => setBusy(null));
  };

  const proxy = status?.proxy ?? null;
  const login = status?.login;
  const signedIn = proxy?.signedIn === true;
  const deviceUrl = login?.url ?? "https://github.com/login/device";

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        {status === null && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {status ? (
          <div>
            <Row label="Account">
              {signedIn ? (status.account ?? "Signed in") : "Not signed in"}
              {signedIn && status.plan ? <span className="text-muted-foreground"> · {status.plan}</span> : null}
            </Row>
            <Row label="copilot-api">
              {proxy?.running ? `Running on 127.0.0.1:${proxy.port}` : "Stopped"}
              {status.hostName ? <span className="text-muted-foreground"> · {status.hostName}</span> : null}
            </Row>
            {proxy?.error ? <Row label="Error">{proxy.error}</Row> : null}
            {proxy ? (
              <Row label="Data folder">
                <code className="text-xs">{proxy.home}</code>
              </Row>
            ) : null}
          </div>
        ) : null}

        {login?.state === "waiting" && login.userCode ? (
          <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
            <span>Open GitHub and enter this code, signed in with the account that has Copilot:</span>
            <span className="select-all font-mono text-2xl tracking-widest">{login.userCode}</span>
            <div>
              <Button size="sm" onClick={() => navigate.openUrl(deviceUrl)}>
                Open {deviceUrl.replace(/^https:\/\//, "")}
              </Button>
            </div>
            <span className="text-muted-foreground">Waiting for GitHub…</span>
          </div>
        ) : null}
        {login?.state === "failed" && login.message ? (
          <pre className="whitespace-pre-wrap rounded-md border p-3 text-xs text-destructive">{login.message}</pre>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          {signedIn ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("signOut", () => rpc.call("signOut"))}>
              Sign out
            </Button>
          ) : (
            <Button size="sm" disabled={busy !== null || waiting} onClick={() => run("login", () => rpc.call("startLogin"))}>
              {busy === "login" ? "Starting…" : "Sign in with GitHub"}
            </Button>
          )}
          {signedIn && proxy && !proxy.running ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("start", () => rpc.call("start"))}>
              Start copilot-api
            </Button>
          ) : null}
          {proxy?.running ? (
            <>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("restart", () => rpc.call("restart"))}>
                Restart copilot-api
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("stop", () => rpc.call("stop"))}>
                Stop copilot-api
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={refresh}>
            Refresh
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">copilot-api config.json</h3>
        <p className="text-sm text-muted-foreground">
          Options for the private copilot-api, such as model mappings and reasoning efforts; see the copilot-api README.
          The gateway keys are managed by the plugin and not shown. Saving reloads a running copilot-api.
        </p>
        <textarea
          className="min-h-64 w-full rounded-md border bg-transparent p-3 font-mono text-xs"
          spellCheck={false}
          value={config ?? ""}
          disabled={config === null}
          onChange={(event) => {
            setConfig(event.target.value);
            setConfigMessage(null);
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={config === null || busy !== null} onClick={saveConfig}>
            {busy === "config" ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={loadConfig}>
            Revert
          </Button>
          {configMessage ? <span className="text-sm text-muted-foreground">{configMessage}</span> : null}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage dashboard

type FetchRequest = { type: typeof MESSAGE_FETCH; id: number; path: string };

function isFetchRequest(value: unknown): value is FetchRequest {
  const m = value as Partial<FetchRequest> | null;
  return (
    !!m &&
    m.type === MESSAGE_FETCH &&
    typeof m.id === "number" &&
    typeof m.path === "string" &&
    m.path.startsWith("/") &&
    m.path.length < 2048
  );
}

function UsagePage() {
  const frame = useRef<HTMLIFrameElement>(null);

  // The dashboard runs sandboxed (opaque origin), so it cannot reach bb's API
  // or cookies. It asks us for data via postMessage; we call the plugin's
  // proxy route (which re-validates the path) and post the result back.
  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || !isFetchRequest(event.data)) return;
      const { id, path } = event.data;
      try {
        const res = await fetch(`${BASE}/proxy?path=${encodeURIComponent(path)}`);
        target.postMessage(
          {
            type: MESSAGE_RESPONSE,
            id,
            status: res.status,
            contentType: res.headers.get("content-type") ?? "application/json",
            body: await res.text(),
          },
          "*",
        );
      } catch (error) {
        target.postMessage({ type: MESSAGE_RESPONSE, id, error: String(error) }, "*");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const endpoint = `${window.location.origin}${VIRTUAL}/usage`;
  const src = `${BASE}/viewer?${new URLSearchParams({ endpoint, period: "this_month" })}`;
  return (
    <iframe
      ref={frame}
      src={src}
      title="Copilot usage"
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className="block h-full w-full border-0"
    />
  );
}

/** Footer button: jump to the usage page, then close the (empty) disclosure. */
function OpenUsage({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const navigate = useBbNavigate();
  useEffect(() => {
    navigate.toPluginPanel(PANEL_PATH);
    dismiss();
  }, [navigate, dismiss]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: PROVIDER_ID, icon: ClaudeCopilotIcon });
  app.experimental_icons.register({ name: COPILOT_ICON, component: CopilotIcon });
  app.slots.settingsSection({
    id: "copilot",
    title: "GitHub Copilot",
    description: "Sign-in and the private copilot-api used by Claude Code (Copilot).",
    component: SettingsSection,
  });
  app.slots.navPanel({
    id: "usage",
    title: "Copilot usage",
    icon: COPILOT_ICON,
    path: PANEL_PATH,
    component: UsagePage,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Copilot usage",
    icon: COPILOT_ICON,
    component: OpenUsage,
  });
});
