// Frontend of bb-plugin-claude-copilot:
// - provider icon for "Claude Code (Copilot)": the orange Claude mark with the
//   GitHub Copilot glyph in the bottom-right corner (same layout as the
//   claude-bedrock plugin's AWS badge); keep in sync with icons/claude-copilot.svg
// - settings section: GitHub sign-in and copilot-api status first, then the
//   model dropdowns (from Copilot's live model list), the wrapped Claude Code
//   options and the copilot-api config.json editor
// - usage dashboard page (one tab per local copilot-api instance) + footer button
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { REASONING_LEVELS, type ReasoningLevel } from "./reasoning";
import type {
  AppStatus,
  appContract,
  CopilotModel,
  CopilotSettings,
  Instance,
  SettingField,
  SettingsView,
  SettingValue,
} from "./contract";
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

const SELECT_CLASS =
  "h-8 w-full max-w-md rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

function Field({ label, description, children }: { label: string; description?: string | null; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 py-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </label>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  );
}

function modelLabel(model: CopilotModel): string {
  const extras = [model.vendor, model.contextWindow ? contextLabel(model.contextWindow) : null].filter(Boolean);
  return extras.length ? `${model.displayName} (${extras.join(", ")})` : model.displayName;
}

function contextLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

/** Dropdown of Copilot models grouped by vendor; keeps an unknown current value selectable. */
function ModelSelect({
  value,
  models,
  disabled,
  onChange,
}: {
  value: string;
  models: CopilotModel[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const groups = new Map<string, CopilotModel[]>();
  for (const model of models) {
    const vendor = model.vendor ?? "Other";
    groups.set(vendor, [...(groups.get(vendor) ?? []), model]);
  }
  const known = models.some((m) => m.id === value);
  return (
    <select className={SELECT_CLASS} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {known ? null : <option value={value}>{value}</option>}
      {[...groups.entries()].map(([vendor, list]) => (
        <optgroup key={vendor} label={vendor}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {modelLabel(m)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Text or number input that saves on blur / Enter. */
function CommitInput({
  value,
  type,
  disabled,
  onCommit,
}: {
  value: string;
  type: "text" | "number";
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      className="max-w-md"
      type={type}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** One of the wrapped Claude Code provider's settings, rendered from its descriptor. */
function ClaudeField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField;
  value: SettingValue | undefined;
  disabled: boolean;
  onChange: (value: SettingValue) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-2 py-1.5 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{field.label}</span>
          {field.description ? <span className="text-xs text-muted-foreground">{field.description}</span> : null}
        </span>
      </label>
    );
  }
  return (
    <Field label={field.label} description={field.description}>
      {field.type === "select" ? (
        <select
          className={SELECT_CLASS}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {field.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
      ) : (
        <CommitInput
          type={field.type === "number" ? "number" : "text"}
          value={value === undefined ? "" : String(value)}
          disabled={disabled}
          onCommit={(next) => onChange(field.type === "number" ? Number(next) : next)}
        />
      )}
    </Field>
  );
}

function SettingsSection() {
  const rpc = useRpc<typeof appContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => setError(errorText(cause)), []);
  const refresh = useCallback(() => {
    rpc.call("status").then((s) => {
      setStatus(s);
      setError(null);
    }, report);
  }, [rpc, report]);
  const loadSettings = useCallback(() => {
    rpc.call("getSettings").then(setSettings, (cause: unknown) => setSettingsError(errorText(cause)));
  }, [rpc]);
  const loadConfig = useCallback(() => {
    rpc.call("getConfig").then((c) => {
      setConfig(c.json);
      setConfigMessage(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refresh();
    loadSettings();
    loadConfig();
  }, [refresh, loadSettings, loadConfig]);

  // Poll while the GitHub sign-in waits for the user.
  const waiting = status?.login.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  // After sign-in or a (re)start the model list may have changed.
  const running = status?.proxy?.running === true;
  useEffect(() => {
    if (running) loadSettings();
  }, [running, loadSettings]);

  const run = (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    action()
      .then(() => refresh(), report)
      .finally(() => setBusy(null));
  };

  const saveSettings = (action: () => Promise<SettingsView>) => {
    setBusy("settings");
    action()
      .then((next) => {
        setSettings(next);
        setSettingsError(null);
      }, (cause: unknown) => setSettingsError(errorText(cause)))
      .finally(() => setBusy(null));
  };
  const setCopilot = (patch: Partial<CopilotSettings>) => saveSettings(() => rpc.call("setCopilotSettings", patch));
  const setClaude = (key: string, value: SettingValue) => saveSettings(() => rpc.call("setClaudeSetting", { key, value }));

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
  const copilot = settings?.copilot;
  const models = settings?.models ?? [];
  const settingsDisabled = settings === null || busy === "settings";

  return (
    <div className="flex flex-col gap-8">
      <Section title="GitHub Copilot">
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
      </Section>

      <Section
        title="Models"
        description={
          models.length === 0
            ? "The model list loads from Copilot once copilot-api has run; until then only the current values are shown."
            : "Copilot's chat models. Non-Anthropic models run through copilot-api's Messages translation."
        }
      >
        {copilot ? (
          <div className="flex flex-col">
            <Field label="Default model" description="Preselected for new Claude Code (Copilot) threads.">
              <ModelSelect value={copilot.defaultModel} models={models} disabled={settingsDisabled} onChange={(v) => setCopilot({ defaultModel: v })} />
            </Field>
            <Field label="Default reasoning" description="Preselected reasoning effort, where the model supports it.">
              <select
                className={SELECT_CLASS}
                value={copilot.defaultReasoning}
                disabled={settingsDisabled}
                onChange={(e) => setCopilot({ defaultReasoning: e.target.value as ReasoningLevel })}
              >
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Opus model" description="What Claude Code's opus alias resolves to.">
              <ModelSelect value={copilot.opusModel} models={models} disabled={settingsDisabled} onChange={(v) => setCopilot({ opusModel: v })} />
            </Field>
            <Field label="Sonnet model" description="What Claude Code's sonnet alias resolves to.">
              <ModelSelect value={copilot.sonnetModel} models={models} disabled={settingsDisabled} onChange={(v) => setCopilot({ sonnetModel: v })} />
            </Field>
            <Field label="Haiku model" description="Used by Claude Code for background tasks such as titles and summaries.">
              <ModelSelect value={copilot.haikuModel} models={models} disabled={settingsDisabled} onChange={(v) => setCopilot({ haikuModel: v })} />
            </Field>
            <Field label="Stop copilot-api when idle (minutes)" description="0 keeps it running. The next turn starts it again.">
              <CommitInput
                type="number"
                value={String(copilot.idleStopMinutes)}
                disabled={settingsDisabled}
                onCommit={(v) => setCopilot({ idleStopMinutes: Math.max(0, Math.round(Number(v) || 0)) })}
              />
            </Field>
          </div>
        ) : settingsError ? null : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {settingsError ? <p className="text-sm text-destructive">{settingsError}</p> : null}
      </Section>

      {settings && settings.claudeFields.length > 0 ? (
        <Section title="Claude Code" description="bb's Claude Code options, for this provider only. Changes apply to new turns.">
          <div className="flex flex-col">
            {settings.claudeFields.map((field) => (
              <ClaudeField
                key={field.key}
                field={field}
                value={settings.claudeValues[field.key]}
                disabled={settingsDisabled}
                onChange={(value) => setClaude(field.key, value)}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="copilot-api config.json"
        description="Options for the private copilot-api, such as model mappings and reasoning efforts; see the copilot-api README. The gateway keys are managed by the plugin and not shown. Saving reloads a running copilot-api."
      >
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
      </Section>
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

const OWN_INSTANCE: Instance = { id: "plugin", label: "bb plugin", home: "", own: true, port: null };

function UsagePage() {
  const rpc = useRpc<typeof appContract>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [instances, setInstances] = useState<Instance[]>([OWN_INSTANCE]);
  const [selected, setSelected] = useState(OWN_INSTANCE.id);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    rpc.call("listInstances").then(
      (r) => {
        if (r.instances.length > 0) setInstances(r.instances);
      },
      () => undefined,
    );
  }, [rpc]);

  // The dashboard runs sandboxed (opaque origin), so it cannot reach bb's API
  // or cookies. It asks us for data via postMessage; we call the plugin's
  // proxy route (which re-validates the path) and post the result back.
  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || !isFetchRequest(event.data)) return;
      const { id, path } = event.data;
      try {
        const query = new URLSearchParams({ path, instance: selectedRef.current });
        const res = await fetch(`${BASE}/proxy?${query}`);
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
    <div className="flex h-full w-full flex-col">
      {instances.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2" role="tablist">
          {instances.map((instance) => (
            <button
              key={instance.id}
              type="button"
              role="tab"
              aria-selected={instance.id === selected}
              title={instance.home || undefined}
              className={`whitespace-nowrap rounded-md px-3 py-1 text-sm ${
                instance.id === selected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
              onClick={() => setSelected(instance.id)}
            >
              {instance.label}
              {!instance.own && instance.port ? <span className="text-muted-foreground"> :{instance.port}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <iframe
        key={selected}
        ref={frame}
        src={src}
        title="Copilot usage"
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="block min-h-0 w-full flex-1 border-0"
      />
    </div>
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
    title: "Claude Code (Copilot)",
    description: "GitHub sign-in, models and the private copilot-api used by the Claude Code (Copilot) provider.",
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
