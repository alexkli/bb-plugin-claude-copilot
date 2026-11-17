// copilot-api's gateway key for Claude Code, added on the host by the provider
// bridge. It never goes through bb's provider environment
// (bb.providers.experimental_contributeEnv): bb records contributed values
// as-is in each thread's provider.env-resolved event, which it stores.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Gateway = { url: string; apiKey: string };

/** The embedded copilot-api's URL and key from host-data/proxy.json, or null before it was set up. */
export function readGateway(hostDataDir: string): Gateway | null {
  try {
    const state = JSON.parse(readFileSync(join(hostDataDir, "proxy.json"), "utf8")) as { port?: unknown; apiKey?: unknown };
    if (typeof state.port !== "number" || typeof state.apiKey !== "string" || state.apiKey === "") return null;
    return { url: `http://127.0.0.1:${state.port}`, apiKey: state.apiKey };
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Adds ANTHROPIC_AUTH_TOKEN to the envVars of a bb -> bridge request
 * (`params.options.envVars` for thread and turn commands, `params.envVars`
 * for model listing; `params.config` is accepted too), only where ANTHROPIC_BASE_URL is this plugin's copilot-api, so the
 * key never goes anywhere else. Other lines are returned unchanged.
 */
export function withGatewayKey(line: string, gateway: Gateway | null): string {
  if (gateway === null || !line.includes('"envVars"')) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  const params = isObject(message) && isObject(message.params) ? message.params : null;
  let changed = false;
  const nested = (key: string) => (params !== null && isObject(params[key]) ? (params[key] as Record<string, unknown>) : null);
  for (const holder of [params, nested("options"), nested("config")]) {
    const env = holder?.envVars;
    if (isObject(env) && env.ANTHROPIC_BASE_URL === gateway.url) {
      env.ANTHROPIC_AUTH_TOKEN = gateway.apiKey;
      changed = true;
    }
  }
  return changed ? JSON.stringify(message) : line;
}

/** The same for an environment (the bridge's own, which its model and account probes use). */
export function addGatewayKey(env: NodeJS.ProcessEnv, gateway: Gateway | null): void {
  if (gateway !== null && env.ANTHROPIC_BASE_URL === gateway.url) env.ANTHROPIC_AUTH_TOKEN = gateway.apiKey;
}
