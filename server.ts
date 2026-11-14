// Server side of bb-plugin-claude-copilot.
//
// Registers "Claude Code (Copilot)" by running bb's own built-in Claude Code
// provider plugin (loaded at runtime from the bb install, so it follows bb
// updates) against a lightly rewritten plugin API:
//   - provider id/name/icon/strings changed, usage maintenance off,
//     BB_CLAUDE_CODE_EXECUTABLE / CLAUDE_CODE_OAUTH_TOKEN not passed through;
//   - its provider-usage RPC dropped (it only serves provider-claude-code);
//   - its settings kept by this plugin (settings.ts) and passed to its
//     deriveProviderOptions.
// The thread environment points Claude Code at this plugin's embedded
// copilot-api, which the host entry runs. The server also serves the usage
// dashboard, a Provider usage card and the settings section's API, and stops
// copilot-api when no Copilot thread has run for a while.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  appContract,
  claudeSessionIdSchema,
  hostContract,
  type AppStatus,
  type CopilotModel,
  type ProxyStatus,
  type SessionCredits,
  type SettingsView,
} from "./contract.js";
import { DASHBOARD_PATHS, SHIM, VIEWER_CSP } from "./dashboard.js";
import { SettingsStore } from "./settings.js";

const PROVIDER_ID = "claude-copilot";
const PROVIDER_NAME = "Claude Code (Copilot)";
const BUILTIN_ID = "provider-claude-code";
const OWN_INSTANCE_ID = "plugin";

/** This plugin's root: the nearest folder up from the bundle with our package.json. */
function findPluginDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes('"bb-plugin-claude-copilot"')) return dir;
    dir = dirname(dir);
  }
  throw new Error(`claude-copilot: could not find the plugin folder from ${fileURLToPath(import.meta.url)}`);
}
const PLUGIN_DIR = findPluginDir();

function builtinServerPath(): string {
  const candidates = [
    process.argv[1] ? join(dirname(process.argv[1]), "builtin-plugins", BUILTIN_ID, "dist", "server.js") : null,
    `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/builtin-plugins/${BUILTIN_ID}/dist/server.js`,
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error(`claude-copilot: bb's built-in ${BUILTIN_ID} server bundle was not found.`);
}

// ---------------------------------------------------------------------------
// Wrapping the built-in provider plugin

type ProviderDeclaration = Parameters<BbPluginApi["providers"]["register"]>[0];
type DeriveContext = { settings: Record<string, unknown> } & Record<string, unknown>;

function rewriteDeclaration(declaration: ProviderDeclaration, settings: SettingsStore): ProviderDeclaration {
  const d = { ...(declaration as unknown as Record<string, unknown>) };
  delete d.internal_DO_NOT_USE_guidedSignIn; // that flow signs in to claude.ai
  const strings = (d.strings ?? {}) as Record<string, unknown>;
  const maintenance = (d.maintenance ?? {}) as Record<string, unknown>;
  const env = (d.env ?? {}) as { passthrough?: string[] };
  const derive = d.deriveProviderOptions as ((ctx: DeriveContext) => unknown) | undefined;
  return {
    ...d,
    id: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    icon: "./icons/claude-copilot.svg",
    strings: {
      ...strings,
      signInHint: "Sign in to GitHub Copilot in the Claude Copilot plugin settings, or run `bb claude-copilot login`.",
      expiredHint: "Your GitHub Copilot sign-in expired. Sign in again in the Claude Copilot plugin settings.",
      installUrl: "https://claude.com/claude-code",
    },
    // Claude Code's usage check reads the claude.ai subscription, which is not
    // what this provider spends; the plugin publishes its own usage card.
    maintenance: { ...maintenance, usage: false },
    env: {
      ...env,
      passthrough: (env.passthrough ?? []).filter(
        (name) => name !== "BB_CLAUDE_CODE_EXECUTABLE" && name !== "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    },
    // The built-in reads its settings only here; give it the plugin-kept values.
    ...(derive ? { deriveProviderOptions: (ctx: DeriveContext) => derive({ ...ctx, settings: { ...ctx.settings, ...settings.claudeValues() } }) } : {}),
  } as unknown as ProviderDeclaration;
}

function bindAll<T extends object>(target: T, overrides: Record<string | symbol, unknown>): T {
  return new Proxy(target, {
    get(t, key, receiver) {
      if (key in overrides) return overrides[key];
      const value = Reflect.get(t, key, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/** Run the built-in provider plugin against a rewritten API. */
async function registerWrappedProvider(bb: BbPluginApi, settings: SettingsStore): Promise<void> {
  const wrapped = bindAll(bb, {
    providers: bindAll(bb.providers, {
      register: (declaration: ProviderDeclaration) => bb.providers.register(rewriteDeclaration(declaration, settings)),
    }),
    rpc: bindAll(bb.rpc, { register: () => {} }), // the built-in's provider-usage source; not ours
    settings: bindAll(bb.settings, {
      // Keep the built-in's settings ourselves (rendered by our section).
      define: (descriptors: Record<string, unknown>) => {
        settings.setClaudeDescriptors(descriptors);
        return {
          get: async () => settings.claudeValues(),
          experimental_set: async (values: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(values)) {
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                await settings.setClaude(key, value);
              }
            }
            return settings.claudeValues();
          },
          onChange: (listener: () => void) => settings.onChange(listener),
        };
      },
    }),
  });
  // A query string gives this plugin its own module instance, separate from
  // the one bb runs for the real Claude Code provider.
  const builtin = (await import(`${pathToFileURL(builtinServerPath()).href}?instance=${PROVIDER_ID}`)) as {
    default: (bb: BbPluginApi) => unknown;
  };
  await builtin.default(wrapped);
}

// ---------------------------------------------------------------------------
// Provider usage card (bb's provider-usage plugin discovers it via RPC)

const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";

const usageWindow = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
});
const usageCommon = { plan: z.null(), accountEmail: z.string().nullable(), planLabel: z.string().nullable() };
const usageState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), ...usageCommon, windows: z.array(usageWindow) }),
  z.object({ status: z.literal("error"), ...usageCommon, message: z.string() }),
]);
type UsageResult = { accountKey: string | null; observedAt: number | null; usage: z.infer<typeof usageState> };

const usageRpcContract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({
      resources: z.array(
        z.object({
          accountKey: z.string().min(1).nullable(),
          id: z.string().min(1),
          providerId: z.string().min(1),
          label: z.string().min(1),
          scope: z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
        }),
      ),
    }),
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.object({
      accountKey: z.string().min(1).nullable(),
      observedAt: z.number().int().nonnegative().nullable(),
      usage: usageState,
    }),
  },
});

const copilotUsageSchema = z.object({
  login: z.string().optional(),
  copilot_plan: z.string().optional(),
  quota_reset_date_utc: z.string().optional(),
  quota_snapshots: z
    .record(
      z.string(),
      z.object({
        unlimited: z.boolean().optional(),
        percent_remaining: z.number().optional(),
        entitlement: z.number().optional(),
        remaining: z.number().optional(),
        credits_used: z.number().optional(),
        token_based_billing: z.boolean().optional(),
      }),
    )
    .optional(),
});
type CopilotUsage = z.infer<typeof copilotUsageSchema>;

function capitalized(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function planName(usage: CopilotUsage): string | null {
  return usage.copilot_plan ? `Copilot ${capitalized(usage.copilot_plan)}` : null;
}

/**
 * USD cents per unit of the premium quota. With token-based billing the quota
 * is in AI credits of $0.01 (copilot-api prices usage the same way: its
 * total_cost_nanos is total_nano_aiu / 100). Request-based quotas use the
 * list price of a premium request ($0.04).
 */
function centsPerUnit(tokenBased: boolean | undefined): number {
  return tokenBased ? 1 : 4;
}

function usageWindows(usage: CopilotUsage): z.infer<typeof usageWindow>[] {
  const premium = usage.quota_snapshots?.premium_interactions;
  if (!premium || premium.unlimited || premium.percent_remaining === undefined) return [];
  const used = Math.max(0, 100 - premium.percent_remaining);
  const { entitlement, remaining } = premium;
  // bb's provider-usage card shows amounts only as USD ("$used / $limit" next
  // to the reset time when a row is expanded), so the quota is shown in dollars.
  const usedUnits = premium.credits_used ?? (entitlement !== undefined && remaining !== undefined ? entitlement - remaining : undefined);
  const cents = centsPerUnit(premium.token_based_billing);
  const cost =
    entitlement !== undefined && entitlement > 0 && usedUnits !== undefined
      ? { usedUsdCents: Math.max(0, usedUnits) * cents, limitUsdCents: entitlement * cents }
      : null;
  return [
    {
      kind: "custom",
      id: "premium",
      label: "Premium",
      usedPercent: Math.round(used * 10) / 10,
      resetsAt: usage.quota_reset_date_utc ?? null,
      model: null,
      cost,
    },
  ];
}

// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = new SettingsStore(bb);
  await settings.load();
  await registerWrappedProvider(bb, settings);
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const ensure = async (hostId: string): Promise<ProxyStatus> => {
    const s = settings.copilot();
    return host.call(
      "ensureProxy",
      { pluginDir: PLUGIN_DIR, catalog: { defaultModel: s.defaultModel, defaultReasoning: s.defaultReasoning } },
      { hostId },
    );
  };

  /** The machine the bb server runs on (copilot-api usage lives there). */
  async function primaryHost(): Promise<{ id: string; name: string } | null> {
    const [hosts, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config().catch(() => null)]);
    const connected = hosts.filter((h) => h.status === "connected");
    const found = connected.find((h) => h.id === config?.primaryHostId) ?? connected[0];
    return found ? { id: found.id, name: found.name } : null;
  }
  async function primaryHostId(): Promise<string> {
    const found = await primaryHost();
    if (!found) throw new Error("No connected machine.");
    return found.id;
  }

  const modelCache = new Map<string, { at: number; models: CopilotModel[] }>();
  async function models(hostId: string): Promise<CopilotModel[]> {
    const cached = modelCache.get(hostId);
    if (cached && Date.now() - cached.at < 60_000) return cached.models;
    const { models: list } = await host.call("models", {}, { hostId });
    modelCache.set(hostId, { at: Date.now(), models: list });
    return list;
  }

  // -- Thread environment ----------------------------------------------------

  bb.providers.experimental_contributeEnv(PROVIDER_ID, async ({ hostId }) => {
    const status = await ensure(hostId);
    const s = settings.copilot();
    const list = await models(hostId).catch(() => [] as CopilotModel[]);
    // [1m] models: compact before the smallest real input limit among them.
    // Claude Code caps this at each model's own window, so 200K models keep theirs.
    const oneM = list.filter((m) => m.id.endsWith("[1m]") && m.inputLimit !== null).map((m) => m.inputLimit as number);
    const entries = [
      { name: "ANTHROPIC_BASE_URL", value: `http://127.0.0.1:${status.port}`, reason: "Route Claude Code through the plugin's copilot-api" },
      { name: "ANTHROPIC_AUTH_TOKEN", value: status.apiKey, reason: "Gateway key of the plugin's copilot-api" },
      { name: "ANTHROPIC_MODEL", value: s.defaultModel, reason: "Default model (plugin setting)" },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: s.opusModel, reason: "Copilot model for Opus (plugin setting)" },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: s.sonnetModel, reason: "Copilot model for Sonnet (plugin setting)" },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: s.haikuModel, reason: "Copilot model for Haiku and background tasks (plugin setting)" },
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "0", reason: "Use the Anthropic API shape" },
      { name: "CLAUDE_CODE_AUTO_MODE_SERVER", value: "0", reason: "copilot-api has no auto-mode endpoint" },
      { name: "DISABLE_NON_ESSENTIAL_MODEL_CALLS", value: "1", reason: "Save Copilot requests" },
      { name: "DISABLE_TELEMETRY", value: "1", reason: "No Anthropic telemetry for Copilot sessions" },
      { name: "DISABLE_ERROR_REPORTING", value: "1", reason: "No Anthropic error reporting for Copilot sessions" },
      { name: "DISABLE_FEEDBACK_COMMAND", value: "1", reason: "Feedback goes to Anthropic" },
      { name: "CLAUDE_CODE_ATTRIBUTION_HEADER", value: "0", reason: "Keeps the system prompt stable for prompt caching (copilot-api guide)" },
      { name: "CLAUDE_COPILOT_SESSION", value: "1", reason: "Lets the statusline detect Copilot mode" },
    ];
    if (oneM.length > 0) {
      entries.push({
        name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        value: String(Math.min(...oneM)),
        reason: "Compact 1M Copilot models before their real input limit",
      });
    }
    if (status.claudePath) {
      entries.push({ name: "BB_CLAUDE_CODE_EXECUTABLE", value: status.claudePath, reason: "Plain claude, not a machine-wide wrapper" });
    }
    return entries;
  });

  bb.providers.experimental_contributeEnvHealth(PROVIDER_ID, async ({ hostId }) => {
    const status = await ensure(hostId);
    return status.running
      ? { label: "GitHub Copilot", statusMessage: "Signed in through the plugin's copilot-api." }
      : null;
  });

  // -- Copilot account / usage -------------------------------------------------

  const USAGE_CACHE_KEY = "lastUsage";
  type CachedUsage = { observedAt: number; usage: CopilotUsage };

  /** Read /usage from copilot-api; with start=false, only when it already runs. */
  async function readCopilotUsage(hostId: string, start: boolean): Promise<CachedUsage | null> {
    const status = start ? await ensure(hostId) : await host.call("proxyStatus", {}, { hostId });
    if (!status.running) return null;
    const res = await host.call("apiRequest", { path: "/usage" }, { hostId });
    if (res.status !== 200) throw new Error(`copilot-api /usage returned HTTP ${res.status}`);
    const parsed = copilotUsageSchema.safeParse(JSON.parse(res.body));
    if (!parsed.success) throw new Error("Unexpected /usage response from copilot-api.");
    const cached = { observedAt: Date.now(), usage: parsed.data };
    await bb.storage.kv.set(USAGE_CACHE_KEY, cached);
    return cached;
  }

  bb.rpc.register(
    usageRpcContract,
    {
      [LIST_RESOURCES]: async () => {
        const found = await primaryHost();
        return {
          resources: found
            ? [
                {
                  accountKey: null,
                  id: found.id,
                  providerId: PROVIDER_ID,
                  label: PROVIDER_NAME,
                  scope: { kind: "host" as const, hostId: found.id, hostName: found.name },
                },
              ]
            : [],
        };
      },
      [GET_RESOURCE]: async ({ resourceId, refresh }): Promise<UsageResult> => {
        const meta = { plan: null, accountEmail: null };
        let fresh: CachedUsage | null = null;
        let error: string | null = null;
        try {
          // A refresh (user action) may start copilot-api; background polls do not,
          // so the card does not keep an idle proxy alive.
          fresh = await readCopilotUsage(resourceId, refresh);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        const cached = fresh ?? (await bb.storage.kv.get<CachedUsage>(USAGE_CACHE_KEY)) ?? null;
        if (!cached) {
          return {
            accountKey: null,
            observedAt: null,
            usage: { status: "error", ...meta, planLabel: null, message: error ?? "copilot-api is not running. Refresh to start it." },
          };
        }
        const plan = cached.usage.copilot_plan ? capitalized(cached.usage.copilot_plan) : null;
        return {
          accountKey: cached.usage.login ?? null,
          observedAt: cached.observedAt,
          usage: { status: "ok", ...meta, planLabel: plan, windows: usageWindows(cached.usage) },
        };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Publishes the GitHub Copilot premium-request quota for Claude Code (Copilot).",
    },
  );

  // -- Settings section API -----------------------------------------------------

  async function appStatus(): Promise<AppStatus> {
    const found = await primaryHost();
    const idle = { state: "idle" as const, userCode: null, url: null, message: null };
    if (!found) return { hostName: null, proxy: null, login: idle, account: null, plan: null, error: "No connected machine." };
    try {
      const [proxy, login, cached] = await Promise.all([
        host.call("proxyStatus", {}, { hostId: found.id }),
        host.call("loginStatus", {}, { hostId: found.id }),
        bb.storage.kv.get<CachedUsage>(USAGE_CACHE_KEY),
      ]);
      let usage = cached?.usage ?? null;
      if (proxy.running) usage = (await readCopilotUsage(found.id, false).catch(() => null))?.usage ?? usage;
      const { apiKey: _apiKey, ...publicProxy } = proxy;
      return {
        hostName: found.name,
        proxy: publicProxy,
        login,
        account: proxy.signedIn ? (usage?.login ?? null) : null,
        plan: proxy.signedIn && usage ? planName(usage) : null,
        error: null,
      };
    } catch (cause) {
      return { hostName: found.name, proxy: null, login: idle, account: null, plan: null, error: String(cause) };
    }
  }

  async function settingsView(): Promise<SettingsView> {
    const hostId = await primaryHostId().catch(() => null);
    const list = hostId ? await models(hostId).catch(() => [] as CopilotModel[]) : [];
    return {
      copilot: settings.copilot(),
      claudeFields: settings.claudeFields,
      claudeValues: settings.claudeValues(),
      models: list,
    };
  }

  /** Credits a thread's Claude Code session used, from copilot-api's usage log on the thread's host. */
  async function sessionCredits(threadId: string): Promise<SessionCredits> {
    try {
      const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
      if (thread.providerId !== PROVIDER_ID) return { status: "unsupported" };
      const environment = "environment" in thread ? thread.environment : null;
      const hostId = environment?.hostId;
      if (!hostId) return { status: "error", message: "The thread's machine is not known." };
      // Identity events only: no prompts, messages or tool output.
      const events = await bb.sdk.threads.events.list({ threadId, types: ["thread/identity"], order: "desc", limit: "1" });
      const identity = events.find((e) => e.type === "thread/identity");
      const parsed = claudeSessionIdSchema.safeParse(identity?.data.providerThreadId);
      if (!parsed.success) return { status: "pending" };
      const usage = await host.call("sessionUsage", { sessionId: parsed.data }, { hostId });
      return { status: "ok", sessionId: parsed.data, usage };
    } catch (cause) {
      return { status: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  bb.rpc.register(appContract, {
    status: () => appStatus(),
    startLogin: async () => host.call("startLogin", { pluginDir: PLUGIN_DIR }, { hostId: await primaryHostId() }),
    signOut: async () => {
      const result = await host.call("signOut", {}, { hostId: await primaryHostId() });
      await bb.storage.kv.delete(USAGE_CACHE_KEY);
      return result;
    },
    start: async () => {
      await ensure(await primaryHostId());
      return appStatus();
    },
    stop: async () => {
      await host.call("stopProxy", {}, { hostId: await primaryHostId() });
      return appStatus();
    },
    restart: async () => {
      const hostId = await primaryHostId();
      await host.call("stopProxy", {}, { hostId });
      await new Promise((r) => setTimeout(r, 500));
      await ensure(hostId);
      return appStatus();
    },
    getConfig: async () => host.call("getConfig", {}, { hostId: await primaryHostId() }),
    setConfig: async ({ json }) => host.call("setConfig", { json }, { hostId: await primaryHostId() }),
    getSettings: () => settingsView(),
    setCopilotSettings: async (patch) => {
      await settings.setCopilot(patch);
      // Rewrite the bridge's catalog file now so the picker defaults follow.
      const hostId = await primaryHostId().catch(() => null);
      if (hostId) await ensure(hostId).catch(() => null);
      return settingsView();
    },
    setClaudeSetting: async ({ key, value }) => {
      await settings.setClaude(key, value);
      return settingsView();
    },
    listInstances: async () => host.call("listInstances", {}, { hostId: await primaryHostId() }),
    sessionCredits: ({ threadId }) => sessionCredits(threadId),
  });

  // -- Usage dashboard -------------------------------------------------------------

  bb.http.route("GET", "/viewer", async (c) => {
    const hostId = await primaryHostId();
    const status = await ensure(hostId);
    if (!status.running) {
      return c.text(
        status.signedIn
          ? "copilot-api did not start; see the Claude Copilot plugin settings."
          : "Sign in to GitHub Copilot in the Claude Copilot plugin settings first.",
        503,
      );
    }
    const res = await host.call("apiRequest", { path: "/usage-viewer" }, { hostId });
    const html = res.body.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${SHIM}`);
    c.header("content-security-policy", VIEWER_CSP);
    return c.html(html, res.status === 200 ? 200 : 502);
  });

  bb.http.route("GET", "/proxy", async (c) => {
    const target = c.req.query("path") ?? "";
    const instance = c.req.query("instance") ?? OWN_INSTANCE_ID;
    const [path = "", query = ""] = target.split("?", 2);
    if (!DASHBOARD_PATHS.test(path)) return c.text("Path not allowed", 400);
    const full = query ? `${path}?${query}` : path;
    const hostId = await primaryHostId();
    // Token usage is per copilot-api home; account-level data (quota, models)
    // always comes from this plugin's own copilot-api.
    const res =
      instance !== OWN_INSTANCE_ID && path.startsWith("/token-usage")
        ? await host.call("instanceUsage", { pluginDir: PLUGIN_DIR, instanceId: instance, path: full }, { hostId })
        : await host.call("apiRequest", { path: full }, { hostId });
    return new Response(res.body, { status: res.status, headers: { "content-type": res.contentType } });
  });

  // -- Idle stop -----------------------------------------------------------------

  bb.background.service("idle-stop", {
    async start(signal) {
      let lastActive = Date.now();
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (signal.aborted) break;
        try {
          const { idleStopMinutes } = settings.copilot();
          const running = await bb.sdk.threads.listRunning();
          let active = false;
          if (running.length > 0) {
            const list = (await bb.sdk.threads.list({ threadIds: running.map((t) => t.id).slice(0, 200) })) as unknown;
            const threads = (Array.isArray(list) ? list : ((list as { threads?: unknown[] }).threads ?? [])) as {
              providerId?: string;
            }[];
            active = threads.some((t) => t.providerId === PROVIDER_ID);
          }
          if (active) lastActive = Date.now();
          if (idleStopMinutes <= 0 || Date.now() - lastActive < idleStopMinutes * 60_000) continue;
          const hostId = await primaryHostId();
          const status = await host.call("proxyStatus", {}, { hostId });
          if (status.running) {
            await host.call("stopProxy", {}, { hostId });
            bb.log.info(`stopped copilot-api after ${idleStopMinutes} idle minutes`);
          }
        } catch (error) {
          bb.log.warn(`idle check failed: ${String(error)}`);
        }
      }
    },
  });

  // -- CLI -----------------------------------------------------------------------

  const usage = [
    "bb claude-copilot status   Show the embedded copilot-api state",
    "bb claude-copilot login    Sign in to GitHub Copilot (device code)",
    "bb claude-copilot logout   Sign out of GitHub Copilot",
    "bb claude-copilot start    Start copilot-api",
    "bb claude-copilot stop     Stop copilot-api",
  ].join("\n");

  bb.cli.register({
    name: "claude-copilot",
    summary: "Manage the Claude Code (Copilot) provider's embedded copilot-api",
    commands: [
      { name: "status", summary: "Show copilot-api state", usage: "bb claude-copilot status" },
      { name: "login", summary: "Sign in to GitHub Copilot", usage: "bb claude-copilot login" },
      { name: "logout", summary: "Sign out of GitHub Copilot", usage: "bb claude-copilot logout" },
      { name: "start", summary: "Start copilot-api", usage: "bb claude-copilot start" },
      { name: "stop", summary: "Stop copilot-api", usage: "bb claude-copilot stop" },
    ],
    async run(argv) {
      const [command] = argv;
      const hostId = await primaryHostId();
      const show = (s: ProxyStatus) =>
        [
          `copilot-api: ${s.running ? `running on 127.0.0.1:${s.port}` : "stopped"}`,
          `GitHub:      ${s.signedIn ? "signed in" : "not signed in (run: bb claude-copilot login)"}`,
          `claude:      ${s.claudePath ?? "not found on PATH"}`,
          `home:        ${s.home}`,
          ...(s.error ? [`error:       ${s.error}`] : []),
        ].join("\n");
      switch (command) {
        case "status":
          return { exitCode: 0, stdout: show(await host.call("proxyStatus", {}, { hostId })) };
        case "start":
          return { exitCode: 0, stdout: show(await ensure(hostId)) };
        case "stop": {
          const { stopped } = await host.call("stopProxy", {}, { hostId });
          return { exitCode: 0, stdout: stopped ? "Stopped." : "Not running." };
        }
        case "logout": {
          const { signedOut } = await host.call("signOut", {}, { hostId });
          await bb.storage.kv.delete(USAGE_CACHE_KEY);
          return { exitCode: 0, stdout: signedOut ? "Signed out." : "Was not signed in." };
        }
        case "login": {
          const state = await host.call("startLogin", { pluginDir: PLUGIN_DIR }, { hostId });
          if (state.userCode && state.url) {
            return {
              exitCode: 0,
              stdout: `Open ${state.url} and enter the code ${state.userCode}\nThen run: bb claude-copilot status`,
            };
          }
          return { exitCode: 1, stderr: state.message ?? "Could not start the GitHub sign-in." };
        }
        default:
          return { exitCode: command ? 1 : 0, stdout: usage };
      }
    },
  });
}
