// Host side of bb-plugin-claude-copilot.
//
// 1. Runs an embedded copilot-api (the plugin's own pinned copy, its own
//    COPILOT_API_HOME, port and gateway key) under bb's Node.
// 2. Wraps the provider bridge of bb's Claude Code provider
//    (vendor/provider-claude-code) for the claude-copilot provider, adding
//    copilot-api's models to its model catalog.
// 3. Serves upstream's host handlers (resolveNativeRoots) next to its own.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import {
  experimental_defineProviderBridge,
  type ProviderBridgeContext,
} from "@get-bb/plugin-sdk/provider-bridge";
import upstreamHost, { experimental_providerBridge as upstreamBridge } from "./vendor/provider-claude-code/src/host";
import { addGatewayKey, readGateway, withGatewayKey } from "./gateway-key.js";
import {
  catalogFileSchema,
  copilotModelSchema,
  REASONING_LEVELS,
  type ApiResponse,
  type CatalogFile,
  type CopilotModel,
  type Instance,
  type LoginStatus,
  type ProxyStatus,
  type ReasoningLevel,
  type SessionUsage,
} from "./contract.js";
import { hostContract } from "./host-contract.js";

// ---------------------------------------------------------------------------
// Provider bridge: upstream's, with this provider's model catalog.

// Model catalog for this provider. Upstream's bridge reports Claude Code's
// own catalog: only Anthropic models, "high" as every model's default
// reasoning, and Claude Code's "default" entry (its account default, not
// ANTHROPIC_MODEL) as the default model. On the way to bb we add copilot-api's
// other chat models and apply the configured defaults. The host entry keeps
// host-data/catalog.json current (settings + copilot-api's model list).
const FALLBACK_CATALOG: CatalogFile = { defaultModel: "claude-opus-5-5", defaultReasoning: "medium", models: [] };
const CATALOG_FILE = "catalog.json";
let bridgeDataDir: string | null = null;
let cachedCatalog: { value: CatalogFile; at: number } | null = null;

function catalogFile(): CatalogFile {
  if (cachedCatalog && Date.now() - cachedCatalog.at < 5000) return cachedCatalog.value;
  let value = FALLBACK_CATALOG;
  if (bridgeDataDir) {
    try {
      const file = join(dirname(bridgeDataDir), "host-data", CATALOG_FILE);
      const parsed = catalogFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) value = parsed.data;
    } catch {
      // not written yet: keep the fallback
    }
  }
  cachedCatalog = { value, at: Date.now() };
  return value;
}

const EFFORT_DESCRIPTIONS: Record<ReasoningLevel, string> = {
  low: "Low reasoning effort",
  medium: "Medium reasoning effort",
  high: "High reasoning effort",
  xhigh: "Extra high reasoning effort",
  max: "Maximum reasoning effort",
};

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

function catalogEntry(model: CopilotModel, catalog: CatalogFile): Record<string, unknown> {
  const efforts = model.reasoningEfforts;
  const defaultEffort = efforts.includes(catalog.defaultReasoning)
    ? catalog.defaultReasoning
    : efforts.includes("medium")
      ? "medium"
      : (efforts[0] ?? "low"); // bb requires a value; upstream uses "low" for models without efforts
  const description = [
    model.displayName,
    model.vendor,
    model.contextWindow ? `${formatTokens(model.contextWindow)} context` : null,
    "via GitHub Copilot",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: model.id,
    model: model.id,
    displayName: model.displayName,
    description,
    reasoningDiscovery: "known",
    supportedReasoningEfforts: efforts.map((effort) => ({ reasoningEffort: effort, description: EFFORT_DESCRIPTIONS[effort] })),
    defaultReasoningEffort: defaultEffort,
    isDefault: false,
  };
}

function isCatalogEntry(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && "isDefault" in value && "supportedReasoningEfforts" in value;
}

/** Strip copilot-api's Claude compatibility prefix/suffix to compare model ids. */
function baseModelId(id: string): string {
  return id.replace(/\[1m\]$/i, "").replace(/(^|\/)my-claude-/, "$1");
}

function adjustCatalog(value: unknown, catalog: CatalogFile, key: string | null): void {
  if (Array.isArray(value)) {
    if (key === "models" && value.some(isCatalogEntry)) {
      const known = new Set(value.filter(isCatalogEntry).map((m) => baseModelId(String(m.id))));
      for (const model of catalog.models) {
        if (!known.has(baseModelId(model.id))) value.push(catalogEntry(model, catalog));
      }
      if (value.some((m) => isCatalogEntry(m) && m.id === catalog.defaultModel)) {
        for (const m of value) if (isCatalogEntry(m)) m.isDefault = m.id === catalog.defaultModel;
      }
    }
    for (const item of value) adjustCatalog(item, catalog, null);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const supported = record.supportedReasoningEfforts;
  if (
    typeof record.defaultReasoningEffort === "string" &&
    Array.isArray(supported) &&
    supported.some((s) => (s as { reasoningEffort?: unknown })?.reasoningEffort === catalog.defaultReasoning)
  ) {
    record.defaultReasoningEffort = catalog.defaultReasoning;
  }
  for (const [childKey, child] of Object.entries(record)) adjustCatalog(child, catalog, childKey);
}

function rewriteLine(line: string): string {
  if (!line.includes('"defaultReasoningEffort"') && !line.includes('"isDefault"')) return line;
  try {
    const message = JSON.parse(line) as unknown;
    adjustCatalog(message, catalogFile(), null);
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

const hostDataDir = () => (bridgeDataDir === null ? null : join(dirname(bridgeDataDir), "host-data"));

export const experimental_providerBridge = experimental_defineProviderBridge({
  ...upstreamBridge,
  start(context: ProviderBridgeContext) {
    bridgeDataDir = context.dataDir;
    patchStdout();
    const dir = hostDataDir();
    if (dir !== null) addGatewayKey(process.env, readGateway(dir));
    upstreamBridge.start?.(context);
  },
  // the gateway key goes into each command's environment here, on the host
  // (see gateway-key.ts); read per line, so a new key applies right away
  handleLine(line: string) {
    const dir = hostDataDir();
    const gateway = dir === null || !line.includes('"envVars"') ? null : readGateway(dir);
    addGatewayKey(process.env, gateway);
    upstreamBridge.handleLine(withGatewayKey(line, gateway));
  },
});

// ---------------------------------------------------------------------------
// copilot-api

/**
 * keyVersion 2: keys made after 0.1.1 stopped passing the gateway key through
 * bb's provider environment; older keys are in bb's thread events and are
 * replaced once.
 */
type ProxyState = { port: number; apiKey: string; adminKey: string; keyVersion?: number };
const KEY_VERSION = 2;

const newKeys = () => ({
  apiKey: `bbcc-${randomBytes(24).toString("hex")}`,
  adminKey: `bbcc-admin-${randomBytes(24).toString("hex")}`,
  keyVersion: KEY_VERSION,
});

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

/** Waits up to 5 s until nothing listens on the port any more. */
async function waitForPortFree(port: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// one at a time: a key rotation must not run twice
let preparing: Promise<unknown> = Promise.resolve();
function prepareHome(dataDir: string): Promise<{ home: string; state: ProxyState }> {
  const run = preparing.then(() => prepareHomeNow(dataDir));
  preparing = run.catch(() => {});
  return run;
}

async function prepareHomeNow(dataDir: string): Promise<{ home: string; state: ProxyState }> {
  const home = join(dataDir, "copilot-api");
  await mkdir(home, { recursive: true });
  const stateFile = join(dataDir, "proxy.json");
  let state = await readJson<ProxyState>(stateFile);
  let rotated = false;
  if (!state) {
    state = { port: await freePort(), ...newKeys() };
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  } else if (state.keyVersion !== KEY_VERSION) {
    state = { ...state, ...newKeys() };
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    rotated = true;
  }
  // Lock the gateway to our key; keep any other settings the user adds.
  const configFile = join(home, "config.json");
  const config = (await readJson<Record<string, unknown>>(configFile)) ?? {};
  const auth = (config.auth ?? {}) as Record<string, unknown>;
  if (JSON.stringify(auth.apiKeys) !== JSON.stringify([state.apiKey]) || auth.adminApiKey !== state.adminKey) {
    config.auth = { ...auth, apiKeys: [state.apiKey], adminApiKey: state.adminKey };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  // a running copilot-api still takes the old key; the next request starts it again
  if (rotated && (await stopProxy(dataDir))) await waitForPortFree(state.port);
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

// -- Copilot model list ------------------------------------------------------------

const MODELS_FILE = "copilot-models.json";
const MODELS_MAX_AGE_MS = 10 * 60_000;
type ModelsCache = { fetchedAt: number; models: CopilotModel[] };

/** Copilot chat models from copilot-api's /v1/models, in Claude Code's id convention. */
function toCopilotModels(body: unknown): CopilotModel[] {
  const data = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: CopilotModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const caps = (m.capabilities ?? {}) as Record<string, unknown>;
    const upstreamId = typeof m.id === "string" ? m.id : null;
    if (!upstreamId || upstreamId.includes("/")) continue; // provider-prefixed (image) models
    if ((caps.type ?? m.type) !== "chat" && caps.type !== "chat") continue;
    if (m.model_picker_enabled === false) continue;
    if (!Array.isArray(m.supported_endpoints) || m.supported_endpoints.length === 0) continue;
    const contextWindow = typeof m.context_window === "number" ? m.context_window : null;
    const inputLimit = typeof m.input_limit === "number" ? m.input_limit : null;
    const vendor = typeof m.vendor === "string" ? m.vendor : null;
    const anthropic = vendor === "Anthropic" || upstreamId.startsWith("claude-");
    // copilot-api's Claude Code convention: non-Claude names get a my-claude-
    // prefix (copilot-api strips it again) and [1m] tells Claude Code the
    // window is 1M; we add it only when the model really has 1M. Claude models
    // keep their plain ids, like the entries Claude Code lists itself.
    const id = anthropic
      ? upstreamId
      : `my-claude-${upstreamId}${contextWindow !== null && contextWindow >= 1_000_000 ? "[1m]" : ""}`;
    const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : upstreamId;
    const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : [];
    const parsed = copilotModelSchema.safeParse({
      id,
      upstreamId,
      displayName: name.replace(/\s*\(github-copilot\)$/i, ""),
      vendor,
      contextWindow,
      inputLimit,
      reasoningEfforts: REASONING_LEVELS.filter((level) => efforts.includes(level)),
    });
    if (parsed.success) models.push(parsed.data);
  }
  return models;
}

async function readModelsCache(dataDir: string): Promise<ModelsCache | null> {
  return await readJson<ModelsCache>(join(dataDir, MODELS_FILE));
}

/** Refresh the model cache from a running copilot-api when it is stale (or forced). */
async function refreshModels(dataDir: string, state: ProxyState, force = false): Promise<CopilotModel[]> {
  const cached = await readModelsCache(dataDir);
  if (!force && cached && Date.now() - cached.fetchedAt < MODELS_MAX_AGE_MS) return cached.models;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/v1/models`, {
      headers: { authorization: `Bearer ${state.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return cached?.models ?? [];
    const models = toCopilotModels(await res.json());
    if (models.length > 0) await writeFile(join(dataDir, MODELS_FILE), JSON.stringify({ fetchedAt: Date.now(), models }));
    return models.length > 0 ? models : (cached?.models ?? []);
  } catch {
    return cached?.models ?? [];
  }
}

async function writeCatalog(dataDir: string, defaults: Pick<CatalogFile, "defaultModel" | "defaultReasoning">, models: CopilotModel[]) {
  const catalog: CatalogFile = { ...defaults, models };
  await writeFile(join(dataDir, CATALOG_FILE), JSON.stringify(catalog));
}

async function ensureProxy(
  pluginDir: string,
  defaults: Pick<CatalogFile, "defaultModel" | "defaultReasoning">,
  context: ExperimentalHostRpcContext,
): Promise<ProxyStatus> {
  const dataDir = context.experimental_paths.dataDir;
  const { home, state } = await prepareHome(dataDir);
  const cachedModels = (await readModelsCache(dataDir))?.models ?? [];
  await writeCatalog(dataDir, defaults, cachedModels);
  if (!isSignedIn(home)) return statusFor(home, state, false);
  const afterStart = async (): Promise<ProxyStatus> => {
    // Keep the catalog's model list fresh; never delay the caller for it.
    void refreshModels(dataDir, state).then((models) => writeCatalog(dataDir, defaults, models)).catch(() => {});
    return statusFor(home, state, true);
  };
  if (child && child.exitCode === null) return (await healthy(state)) ? afterStart() : statusFor(home, state, false);
  if (await healthy(state)) return afterStart(); // e.g. survived a worker restart

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
    if (await healthy(state)) return afterStart();
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return (await healthy(state)) ? afterStart() : statusFor(home, state, false);
}

/** Models for settings dropdowns: refreshed when copilot-api runs, else the cache. */
async function listModels(context: ExperimentalHostRpcContext): Promise<CopilotModel[]> {
  const dataDir = context.experimental_paths.dataDir;
  const { state } = await prepareHome(dataDir);
  if (await healthy(state)) return await refreshModels(dataDir, state);
  return (await readModelsCache(dataDir))?.models ?? [];
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

/** GET a path on the embedded copilot-api with the gateway key. */
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

// -- Other local copilot-api instances (usage dashboard tabs) ---------------------

const OWN_INSTANCE_ID = "plugin";
const DB_FILE = "copilot-api.sqlite";

function defaultHome(): string {
  return join(homedir(), ".local", "share", "copilot-api");
}

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function instanceId(home: string): string {
  return createHash("sha256").update(home).digest("hex").slice(0, 12);
}

/** Running `copilot-api start` processes: their home and port. */
async function runningCopilotApis(): Promise<{ home: string; port: number | null }[]> {
  const found: { home: string; port: number | null }[] = [];
  const parse = (args: string, env: string) => {
    if (!/copilot-api/.test(args) || !/\sstart(\s|$)/.test(args)) return;
    const apiHome = /--api-home[= ](\S+)/.exec(args)?.[1] ?? /(?:^|\s)COPILOT_API_HOME=(\S+)/.exec(env)?.[1] ?? defaultHome();
    const port = Number(/(?:--port|-p)[= ](\d+)/.exec(args)?.[1] ?? "4141");
    found.push({ home: apiHome, port: Number.isFinite(port) ? port : null });
  };
  try {
    if (process.platform === "linux") {
      for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
        try {
          const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
          if (!args.includes("copilot-api")) continue;
          parse(args, readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", " "));
        } catch {
          // process gone or not ours
        }
      }
    } else if (process.platform !== "win32") {
      const out = await new Promise<string>((resolve) => {
        const ps = spawn("ps", ["-axwwE", "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
        let text = "";
        ps.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
        ps.on("close", () => resolve(text));
        ps.on("error", () => resolve(""));
      });
      for (const line of out.split("\n")) if (line.includes("copilot-api")) parse(line, line);
    }
  } catch {
    // discovery is best effort
  }
  return found;
}

async function listInstances(dataDir: string): Promise<Instance[]> {
  const ownHome = join(dataDir, "copilot-api");
  const running = await runningCopilotApis();
  const portOf = (home: string) => running.find((r) => r.home === home)?.port ?? null;
  const instances: Instance[] = [{ id: OWN_INSTANCE_ID, label: "bb plugin", home: ownHome, own: true, port: portOf(ownHome) }];
  const homes = new Set<string>([defaultHome(), ...running.map((r) => r.home)]);
  homes.delete(ownHome);
  // Other bb plugins' own copilot-api (e.g. the Claude Copilot / Claude Copilot
  // ACP sibling) belongs to that plugin's usage page, not this one.
  const pluginsRoot = dirname(dirname(dataDir)) + sep;
  for (const home of homes) {
    if (home.startsWith(pluginsRoot)) continue;
    if (!existsSync(join(home, DB_FILE))) continue;
    const port = portOf(home);
    const label = home === defaultHome() ? "copilot-api (default home)" : `copilot-api ${tildify(home)}`;
    instances.push({ id: instanceId(home), label, home, own: false, port });
  }
  return instances;
}

const TOKEN_USAGE_PATH = /^\/token-usage(\/(daily|events|sessions))?(\?[A-Za-z0-9_=&%.-]*)?$/;
const SNAPSHOT_MAX_AGE_MS = 30_000;
const snapshotJobs = new Map<string, Promise<string>>();

/** A consistent, read-only copy of another instance's usage database. */
async function snapshot(dataDir: string, id: string, home: string): Promise<string> {
  const dir = join(dataDir, "snapshots");
  const target = join(dir, `${id}.sqlite`);
  if (existsSync(target) && Date.now() - statSync(target).mtimeMs < SNAPSHOT_MAX_AGE_MS) return target;
  const running = snapshotJobs.get(id);
  if (running) return await running;
  const job = (async () => {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `${id}.${process.pid}.${Date.now()}.tmp`);
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(join(home, DB_FILE), { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await rename(temp, target);
    return target;
  })();
  snapshotJobs.set(id, job);
  try {
    return await job;
  } finally {
    snapshotJobs.delete(id);
  }
}

/** /token-usage for another instance, answered by copilot-api's own code over a snapshot. */
async function instanceUsage(pluginDir: string, id: string, path: string, context: ExperimentalHostRpcContext): Promise<ApiResponse> {
  const json = (status: number, value: unknown): ApiResponse => ({ status, contentType: "application/json", body: JSON.stringify(value) });
  if (!TOKEN_USAGE_PATH.test(path)) return json(400, { error: "Path not allowed" });
  const dataDir = context.experimental_paths.dataDir;
  const instance = (await listInstances(dataDir)).find((i) => i.id === id && !i.own);
  if (!instance) return json(404, { error: "Unknown copilot-api instance" });
  let db: string;
  try {
    db = await snapshot(dataDir, instance.id, instance.home);
  } catch (error) {
    return json(502, { error: `Could not read ${instance.home}: ${String(error)}` });
  }
  const readerHome = join(dataDir, "reader-home");
  await mkdir(readerHome, { recursive: true });
  // copilot-api's store opens the database read-write (migrations, pragmas),
  // so concurrent readers on one snapshot fail with "database is locked".
  const previous = readerQueues.get(instance.id) ?? Promise.resolve();
  const result = previous.then(() => runReader(pluginDir, path, readerHome, db));
  const tail = result.then(() => undefined);
  readerQueues.set(instance.id, tail);
  void tail.then(() => {
    if (readerQueues.get(instance.id) === tail) readerQueues.delete(instance.id);
  });
  return await result;
}

const readerQueues = new Map<string, Promise<void>>();

function runReader(pluginDir: string, path: string, readerHome: string, db: string): Promise<ApiResponse> {
  const json = (status: number, value: unknown): ApiResponse => ({ status, contentType: "application/json", body: JSON.stringify(value) });
  return new Promise<ApiResponse>((resolve) => {
    const proc = spawn(process.execPath, [join(pluginDir, "usage-reader.mjs"), pluginDir, path], {
      env: { ...copilotEnv(readerHome), COPILOT_API_SQLITE_DB_PATH: db },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { status: 200, contentType: "application/json", body: out } : json(502, { error: err.trim().slice(-500) || `reader exited ${code}` }));
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve(json(502, { error: String(error) }));
    });
  });
}

// -- Per-session usage (composer credits indicator) -------------------------------

const EMPTY_SESSION_USAGE: SessionUsage = {
  requests: 0,
  credits: 0,
  unpriced: 0,
  inputTokens: 0,
  outputTokens: 0,
  models: [],
  firstAt: null,
  lastAt: null,
};

type SqliteDb = import("node:sqlite").DatabaseSync;
let sessionDb: SqliteDb | null = null;

/** Our copilot-api's usage database, opened read-only once (WAL lets it read while copilot-api writes). */
async function ownUsageDb(dataDir: string): Promise<SqliteDb | null> {
  if (sessionDb?.isOpen) return sessionDb;
  const file = join(dataDir, "copilot-api", DB_FILE);
  if (!existsSync(file)) return null;
  const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
  sessionDb = new DatabaseSync(file, { readOnly: true });
  return sessionDb;
}

/**
 * Sum of what copilot-api recorded for one Claude Code session. copilot-api
 * keys rows by the x-claude-code-session-id header (the root session, so
 * subagent requests count too), which is the thread's providerThreadId.
 */
async function sessionUsage(sessionId: string, dataDir: string): Promise<SessionUsage> {
  let db: SqliteDb | null;
  try {
    db = await ownUsageDb(dataDir);
  } catch {
    return EMPTY_SESSION_USAGE;
  }
  if (!db) return EMPTY_SESSION_USAGE;
  const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0);
  const rows = db
    .prepare(
      `SELECT model,
              COUNT(*) AS requests,
              COALESCE(SUM(total_nano_aiu), 0) AS nano,
              SUM(CASE WHEN total_nano_aiu IS NULL THEN 1 ELSE 0 END) AS unpriced,
              COALESCE(SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              MIN(created_at_ms) AS first,
              MAX(created_at_ms) AS last
         FROM token_usage_events
        WHERE session_id = ?
        GROUP BY model
        ORDER BY nano DESC`,
    )
    .all(sessionId) as Record<string, unknown>[];
  if (rows.length === 0) return EMPTY_SESSION_USAGE;
  const credits = (nano: unknown) => num(nano) / 1e9;
  const first = Math.min(...rows.map((r) => num(r.first)));
  const last = Math.max(...rows.map((r) => num(r.last)));
  return {
    requests: rows.reduce((sum, r) => sum + num(r.requests), 0),
    credits: credits(rows.reduce((sum, r) => sum + num(r.nano), 0)),
    unpriced: rows.reduce((sum, r) => sum + num(r.unpriced), 0),
    inputTokens: rows.reduce((sum, r) => sum + num(r.input), 0),
    outputTokens: rows.reduce((sum, r) => sum + num(r.output), 0),
    models: rows.map((r) => ({ model: String(r.model ?? ""), requests: num(r.requests), credits: credits(r.nano) })),
    firstAt: first > 0 ? new Date(first).toISOString() : null,
    lastAt: last > 0 ? new Date(last).toISOString() : null,
  };
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
    ...upstreamHost.handlers,
    ensureProxy: ({ pluginDir, catalog }, context) => ensureProxy(pluginDir, catalog, context),
    models: async (_input, context) => ({ models: await listModels(context) }),
    listInstances: async (_input, context) => ({ instances: await listInstances(context.experimental_paths.dataDir) }),
    instanceUsage: ({ pluginDir, instanceId: id, path }, context) => instanceUsage(pluginDir, id, path, context),
    proxyStatus: (_input, context) => proxyStatus(context),
    stopProxy: async (_input, context) => ({ stopped: await stopProxy(context.experimental_paths.dataDir) }),
    startLogin: ({ pluginDir }, context) => startLogin(pluginDir, context),
    loginStatus: async () => login,
    signOut: async (_input, context) => ({ signedOut: await signOut(context) }),
    apiRequest: ({ path }, context) => apiRequest(path, context),
    sessionUsage: ({ sessionId }, context) => sessionUsage(sessionId, context.experimental_paths.dataDir),
    getConfig: async (_input, context) => ({ json: await getConfig(context) }),
    setConfig: ({ json }, context) => setConfig(json, context),
  },
  dispose: () => {
    sessionDb?.close();
    child?.kill("SIGTERM");
    loginProc?.kill("SIGTERM");
  },
});
