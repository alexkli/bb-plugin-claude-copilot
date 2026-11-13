// Host side of bb-plugin-claude-copilot.
//
// 1. Runs a private copilot-api (the plugin's own pinned copy, its own
//    COPILOT_API_HOME, port and gateway key) under bb's Node.
// 2. Re-exports bb's built-in Claude Code provider bridge (loaded at runtime
//    from bb's host-artifact cache, so it follows bb updates) for the
//    claude-copilot provider.
// 3. Delegates resolveNativeRoots to the built-in host entry.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import {
  experimental_defineProviderBridge,
  type ProviderBridgeContext,
  type ProviderBridgeEntry,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  catalogDefaultsSchema,
  hostContract,
  type ApiResponse,
  type CatalogDefaults,
  type LoginStatus,
  type ProxyStatus,
} from "./contract.js";

// ---------------------------------------------------------------------------
// Locating bb's built-in Claude Code host artifact

const BUILTIN_ID = "provider-claude-code";

/** ~/.bb from one of this plugin's data dirs (<root>/plugins/<id>/<kind>). */
function bbDataRoot(pluginDataDir: string): string {
  return dirname(dirname(dirname(pluginDataDir)));
}

function findBuiltinHostModule(pluginDataDir: string): string {
  const candidates: { path: string; mtime: number }[] = [];
  const cache = join(bbDataRoot(pluginDataDir), "plugin-host-artifacts", BUILTIN_ID);
  if (existsSync(cache)) {
    for (const digest of readdirSync(cache)) {
      const file = join(cache, digest, "host.mjs");
      if (existsSync(file)) candidates.push({ path: file, mtime: statSync(file).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates[0]) return candidates[0].path;
  // Fallback: the copy inside a local bb app install.
  const bridgeDir = process.env.BB_BRIDGE_DIR;
  const appCopy = bridgeDir
    ? join(bridgeDir, "..", "..", "server", "dist", "builtin-plugins", BUILTIN_ID, "dist", "host.js")
    : null;
  if (appCopy && existsSync(appCopy)) return appCopy;
  throw new Error(
    `claude-copilot: bb's built-in Claude Code host artifact was not found under ${cache}. ` +
      "Run one normal Claude Code thread on this machine so bb delivers it, then retry.",
  );
}

type BuiltinModule = {
  default?: { handlers?: Record<string, (input: unknown, ctx: unknown) => unknown> };
  experimental_providerBridge?: ProviderBridgeEntry;
};
let builtinPromise: Promise<BuiltinModule> | null = null;
function loadBuiltin(pluginDataDir: string): Promise<BuiltinModule> {
  builtinPromise ??= import(pathToFileURL(findBuiltinHostModule(pluginDataDir)).href) as Promise<BuiltinModule>;
  return builtinPromise;
}

// ---------------------------------------------------------------------------
// Provider bridge: forward to the built-in one once it has loaded.

let realBridge: ProviderBridgeEntry | null = null;
let pending: string[] = [];
let pendingEvents: ("close" | "sigterm" | "sigint")[] = [];

function flushEvent(event: "close" | "sigterm" | "sigint") {
  if (!realBridge) return void pendingEvents.push(event);
  if (event === "close") realBridge.onClose?.();
  else if (event === "sigterm") realBridge.onSigterm?.();
  else realBridge.onSigint?.();
}

// Catalog defaults for this provider (Settings: default model / reasoning).
// The built-in bridge defaults every model to "high" reasoning and marks
// Claude Code's own "default" entry (its account default, not ANTHROPIC_MODEL)
// as the default model. Rewrite the catalogs it reports on their way to bb.
// The host entry writes the current choice to host-data/catalog-defaults.json.
const FALLBACK_DEFAULTS: CatalogDefaults = { defaultModel: "claude-opus-5-5", defaultReasoning: "medium" };
const CATALOG_DEFAULTS_FILE = "catalog-defaults.json";
let bridgeDataDir: string | null = null;
let cachedDefaults: { value: CatalogDefaults; at: number } | null = null;

function catalogDefaults(): CatalogDefaults {
  if (cachedDefaults && Date.now() - cachedDefaults.at < 5000) return cachedDefaults.value;
  let value = FALLBACK_DEFAULTS;
  if (bridgeDataDir) {
    try {
      const file = join(dirname(bridgeDataDir), "host-data", CATALOG_DEFAULTS_FILE);
      const parsed = catalogDefaultsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) value = parsed.data;
    } catch {
      // not written yet: keep the fallback
    }
  }
  cachedDefaults = { value, at: Date.now() };
  return value;
}

function applyCatalogDefaults(value: unknown, defaults: CatalogDefaults): void {
  if (Array.isArray(value)) {
    const isCatalog = value.some(
      (m) => m && typeof m === "object" && "isDefault" in m && (m as { id?: unknown }).id === defaults.defaultModel,
    );
    if (isCatalog) {
      for (const m of value) {
        if (m && typeof m === "object" && "isDefault" in m) {
          (m as { isDefault: boolean }).isDefault = (m as { id?: unknown }).id === defaults.defaultModel;
        }
      }
    }
    for (const item of value) applyCatalogDefaults(item, defaults);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const supported = record.supportedReasoningEfforts;
  if (
    typeof record.defaultReasoningEffort === "string" &&
    Array.isArray(supported) &&
    supported.some((s) => (s as { reasoningEffort?: unknown })?.reasoningEffort === defaults.defaultReasoning)
  ) {
    record.defaultReasoningEffort = defaults.defaultReasoning;
  }
  for (const child of Object.values(record)) applyCatalogDefaults(child, defaults);
}

function rewriteLine(line: string): string {
  if (!line.includes('"defaultReasoningEffort"') && !line.includes('"isDefault"')) return line;
  try {
    const message = JSON.parse(line) as unknown;
    applyCatalogDefaults(message, catalogDefaults());
    return JSON.stringify(message);
  } catch {
    return line;
  }
}

let stdoutPatched = false;
/** Rewrite whole JSON-RPC lines the bridge writes to stdout (its channel to bb). */
function patchStdout(): void {
  if (stdoutPatched) return;
  stdoutPatched = true;
  const original = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
  let buffer = "";
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return original(chunk, ...rest);
    const encoding = typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : undefined;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8");
    buffer += text;
    const end = buffer.lastIndexOf("\n");
    const callback = rest.find((r) => typeof r === "function") as ((error?: Error | null) => void) | undefined;
    if (end === -1) {
      callback?.(null);
      return true;
    }
    const complete = buffer.slice(0, end + 1);
    buffer = buffer.slice(end + 1);
    const out = complete
      .split("\n")
      .map((line) => (line ? rewriteLine(line) : line))
      .join("\n");
    return callback ? original(out, callback) : original(out);
  }) as typeof process.stdout.write;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context: ProviderBridgeContext) {
    bridgeDataDir = context.dataDir;
    patchStdout();
    loadBuiltin(context.dataDir).then(
      (mod) => {
        const bridge = mod.experimental_providerBridge;
        if (!bridge) throw new Error("built-in host artifact has no experimental_providerBridge export");
        realBridge = bridge;
        bridge.start?.(context);
        for (const line of pending) bridge.handleLine(line);
        pending = [];
        for (const event of pendingEvents) flushEvent(event);
        pendingEvents = [];
      },
      (error: unknown) => {
        process.stderr.write(`claude-copilot: could not load the Claude Code bridge: ${String(error)}\n`);
        process.exit(1);
      },
    );
  },
  handleLine(line) {
    if (realBridge) realBridge.handleLine(line);
    else pending.push(line);
  },
  onClose: () => flushEvent("close"),
  onSigterm: () => flushEvent("sigterm"),
  onSigint: () => flushEvent("sigint"),
});

// ---------------------------------------------------------------------------
// copilot-api

type ProxyState = { port: number; apiKey: string; adminKey: string };

let child: ChildProcess | null = null;
let lease: ExperimentalHostWorkerLease | null = null;
let lastError: string | null = null;

function copilotApiMain(pluginDir: string): string {
  const main = join(pluginDir, "node_modules", "@jeffreycao", "copilot-api", "dist", "main.js");
  if (!existsSync(main)) throw new Error(`copilot-api is not installed in the plugin (${main}). Run npm install in the plugin.`);
  return main;
}

/** Environment for copilot-api: the host env minus any copilot-api overrides. */
function copilotEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("COPILOT_API_") || key.startsWith("BB_")) continue;
    env[key] = value;
  }
  env.COPILOT_API_HOME = home;
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function prepareHome(dataDir: string): Promise<{ home: string; state: ProxyState }> {
  const home = join(dataDir, "copilot-api");
  await mkdir(home, { recursive: true });
  const stateFile = join(dataDir, "proxy.json");
  let state = await readJson<ProxyState>(stateFile);
  if (!state) {
    state = {
      port: await freePort(),
      apiKey: `bbcc-${randomBytes(24).toString("hex")}`,
      adminKey: `bbcc-admin-${randomBytes(24).toString("hex")}`,
    };
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  // Lock the gateway to our key; keep any other settings the user adds.
  const configFile = join(home, "config.json");
  const config = (await readJson<Record<string, unknown>>(configFile)) ?? {};
  const auth = (config.auth ?? {}) as Record<string, unknown>;
  if (JSON.stringify(auth.apiKeys) !== JSON.stringify([state.apiKey]) || auth.adminApiKey !== state.adminKey) {
    config.auth = { ...auth, apiKeys: [state.apiKey], adminApiKey: state.adminKey };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return { home, state };
}

function isSignedIn(home: string): boolean {
  const token = join(home, "github_token");
  return existsSync(token) && statSync(token).size > 0;
}

function findClaude(): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  dirs.push(join(process.env.HOME ?? "", ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs) {
    if (!dir) continue;
    const file = join(dir, "claude");
    if (existsSync(file)) return file;
  }
  return null;
}

async function healthy(state: ProxyState): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/v1/models`, {
      headers: { authorization: `Bearer ${state.apiKey}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function statusFor(home: string, state: ProxyState, running: boolean): ProxyStatus {
  return {
    running,
    signedIn: isSignedIn(home),
    port: state.port,
    apiKey: state.apiKey,
    claudePath: findClaude(),
    home,
    error: lastError,
  };
}

const PID_FILE = "copilot-api.pid";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureProxy(
  pluginDir: string,
  catalog: CatalogDefaults,
  context: ExperimentalHostRpcContext,
): Promise<ProxyStatus> {
  const dataDir = context.experimental_paths.dataDir;
  const { home, state } = await prepareHome(dataDir);
  await writeFile(join(dataDir, CATALOG_DEFAULTS_FILE), JSON.stringify(catalog));
  if (!isSignedIn(home)) return statusFor(home, state, false);
  if (child && child.exitCode === null) return statusFor(home, state, await healthy(state));
  if (await healthy(state)) return statusFor(home, state, true); // e.g. survived a worker restart

  const log = join(dataDir, "copilot-api.log");
  lastError = null;
  const proc = spawn(process.execPath, [copilotApiMain(pluginDir), "start", "--host", "127.0.0.1", "--port", String(state.port)], {
    env: copilotEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  if (proc.pid) await writeFile(join(dataDir, PID_FILE), String(proc.pid));
  lease?.dispose();
  lease = context.experimental_retainWorker();
  const write = (chunk: Buffer) => void appendFile(log, chunk).catch(() => {});
  proc.stdout?.on("data", write);
  proc.stderr?.on("data", write);
  proc.on("exit", (code, signal) => {
    if (child === proc) {
      child = null;
      lease?.dispose();
      lease = null;
      void rm(join(dataDir, PID_FILE), { force: true });
      if (code !== 0 && signal === null) lastError = `copilot-api exited with code ${code}; see ${log}`;
    }
  });
  for (let i = 0; i < 16; i++) {
    if (await healthy(state)) return statusFor(home, state, true);
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return statusFor(home, state, await healthy(state));
}

async function proxyStatus(context: ExperimentalHostRpcContext): Promise<ProxyStatus> {
  const { home, state } = await prepareHome(context.experimental_paths.dataDir);
  return statusFor(home, state, await healthy(state));
}

/** Stop our copilot-api: the child we own, or one a previous worker left running. */
async function stopProxy(dataDir: string): Promise<boolean> {
  if (child) {
    child.kill("SIGTERM");
    return true;
  }
  const pid = Number((await readFile(join(dataDir, PID_FILE), "utf8").catch(() => "")).trim());
  if (pid > 0 && pidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    await rm(join(dataDir, PID_FILE), { force: true });
    return true;
  }
  return false;
}

/** Read-only copilot-api paths the dashboard and usage card may GET. */
const API_PATHS = /^\/(usage-viewer|(usage|token-usage|models|v1\/models)(\/[A-Za-z0-9_.-]+)*)(\?[^#\s]*)?$/;

/** GET a path on the private copilot-api with the gateway key. */
async function apiRequest(path: string, context: ExperimentalHostRpcContext): Promise<ApiResponse> {
  const segments = (path.split("?")[0] ?? "").split("/");
  if (!API_PATHS.test(path) || segments.some((s) => s === "." || s === "..")) {
    return { status: 400, contentType: "text/plain", body: "Path not allowed" };
  }
  const { state } = await prepareHome(context.experimental_paths.dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      headers: { authorization: `Bearer ${state.apiKey}`, accept: "application/json, text/html" },
      signal: AbortSignal.timeout(25_000),
    });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body: body.length > 7_000_000 ? body.slice(0, 7_000_000) : body,
    };
  } catch (error) {
    return { status: 502, contentType: "application/json", body: JSON.stringify({ error: `copilot-api is not reachable: ${String(error)}` }) };
  }
}

const MANAGED_AUTH_KEYS = ["apiKeys", "adminApiKey"];

/** config.json for editing: the plugin-managed auth keys are left out. */
async function getConfig(context: ExperimentalHostRpcContext): Promise<string> {
  const { home } = await prepareHome(context.experimental_paths.dataDir);
  const config = (await readJson<Record<string, unknown>>(join(home, "config.json"))) ?? {};
  const auth = { ...((config.auth ?? {}) as Record<string, unknown>) };
  for (const key of MANAGED_AUTH_KEYS) delete auth[key];
  if (Object.keys(auth).length === 0) delete config.auth;
  else config.auth = auth;
  return JSON.stringify(config, null, 2);
}

async function setConfig(json: string, context: ExperimentalHostRpcContext): Promise<{ reloaded: boolean; message: string | null }> {
  let next: unknown;
  try {
    next = JSON.parse(json);
  } catch (error) {
    throw new Error(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("config.json must be a JSON object.");
  const config = next as Record<string, unknown>;
  const auth = { ...((config.auth ?? {}) as Record<string, unknown>) };
  for (const key of MANAGED_AUTH_KEYS) delete auth[key]; // re-added by prepareHome
  config.auth = auth;
  const { home, state } = await prepareHome(context.experimental_paths.dataDir);
  await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  await prepareHome(context.experimental_paths.dataDir); // restore the managed keys
  if (!(await healthy(state))) return { reloaded: false, message: "Saved. copilot-api is not running; it reads the file when it starts." };
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/admin/config/reload`, {
      method: "POST",
      headers: { "x-api-key": state.adminKey },
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok
      ? { reloaded: true, message: "Saved and reloaded." }
      : { reloaded: false, message: `Saved, but reload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}` };
  } catch (error) {
    return { reloaded: false, message: `Saved, but reload failed: ${String(error)}` };
  }
}

async function signOut(context: ExperimentalHostRpcContext): Promise<boolean> {
  const dataDir = context.experimental_paths.dataDir;
  const home = join(dataDir, "copilot-api");
  await stopProxy(dataDir);
  const token = join(home, "github_token");
  const existed = existsSync(token);
  await rm(token, { force: true });
  login = { state: "idle", userCode: null, url: null, message: null };
  return existed;
}

// ---------------------------------------------------------------------------
// GitHub sign-in (device flow, driven through copilot-api's own login command)

let login: LoginStatus = { state: "idle", userCode: null, url: null, message: null };
let loginProc: ChildProcess | null = null;

async function startLogin(pluginDir: string, context: ExperimentalHostRpcContext): Promise<LoginStatus> {
  if (loginProc && loginProc.exitCode === null && login.userCode) return login;
  const { home } = await prepareHome(context.experimental_paths.dataDir);
  login = { state: "waiting", userCode: null, url: null, message: null };
  const proc = spawn(process.execPath, [copilotApiMain(pluginDir), "auth", "login", "--provider=copilot"], {
    env: copilotEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  loginProc = proc;
  const loginLease = context.experimental_retainWorker();
  let output = "";
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    const match = /enter the code "([^"]+)" in (\S+)/.exec(output);
    if (match && !login.userCode) login = { ...login, userCode: match[1] ?? null, url: match[2] ?? null };
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    loginLease.dispose();
    if (loginProc === proc) loginProc = null;
    login =
      code === 0 && isSignedIn(home)
        ? { state: "succeeded", userCode: null, url: null, message: "Signed in to GitHub Copilot." }
        : { state: "failed", userCode: null, url: null, message: output.trim().split("\n").slice(-5).join("\n") || `exit ${code}` };
  });
  for (let i = 0; i < 40 && !login.userCode && proc.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return login;
}

// ---------------------------------------------------------------------------

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async resolveNativeRoots(input, context) {
      const mod = await loadBuiltin(context.experimental_paths.dataDir);
      const handler = mod.default?.handlers?.resolveNativeRoots;
      if (!handler) return { skills: [], commands: [] };
      return (await handler({ ...input, providerId: "claude-code" }, context)) as never;
    },
    ensureProxy: ({ pluginDir, catalog }, context) => ensureProxy(pluginDir, catalog, context),
    proxyStatus: (_input, context) => proxyStatus(context),
    stopProxy: async (_input, context) => ({ stopped: await stopProxy(context.experimental_paths.dataDir) }),
    startLogin: ({ pluginDir }, context) => startLogin(pluginDir, context),
    loginStatus: async () => login,
    signOut: async (_input, context) => ({ signedOut: await signOut(context) }),
    apiRequest: ({ path }, context) => apiRequest(path, context),
    getConfig: async (_input, context) => ({ json: await getConfig(context) }),
    setConfig: ({ json }, context) => setConfig(json, context),
  },
  dispose: () => {
    child?.kill("SIGTERM");
    loginProc?.kill("SIGTERM");
  },
});
