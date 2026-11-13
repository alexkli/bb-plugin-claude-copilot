// Server side of bb-plugin-claude-copilot.
//
// Registers "Claude Code (Copilot)" by running bb's own built-in Claude Code
// provider plugin (loaded at runtime from the bb install, so it follows bb
// updates) against a lightly rewritten plugin API:
//   - provider id/name/icon/strings changed, usage maintenance off,
//     BB_CLAUDE_CODE_EXECUTABLE / CLAUDE_CODE_OAUTH_TOKEN not passed through;
//   - its provider-usage RPC dropped (it only serves provider-claude-code).
// The thread environment points Claude Code at this plugin's private
// copilot-api, which the host entry runs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type ProxyStatus } from "./contract.js";

const PROVIDER_ID = "claude-copilot";
const BUILTIN_ID = "provider-claude-code";

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

type ProviderDeclaration = Parameters<BbPluginApi["providers"]["register"]>[0];

function rewriteDeclaration(declaration: ProviderDeclaration): ProviderDeclaration {
  const d = { ...(declaration as unknown as Record<string, unknown>) };
  delete d.internal_DO_NOT_USE_guidedSignIn; // that flow signs in to claude.ai
  const strings = (d.strings ?? {}) as Record<string, unknown>;
  const maintenance = (d.maintenance ?? {}) as Record<string, unknown>;
  const env = (d.env ?? {}) as { passthrough?: string[] };
  return {
    ...d,
    id: PROVIDER_ID,
    displayName: "Claude Code (Copilot)",
    icon: "./icons/claude-copilot.svg",
    strings: {
      ...strings,
      signInHint: "Run `bb claude-copilot login` to sign in to GitHub Copilot.",
      expiredHint: "Your GitHub Copilot sign-in expired. Run `bb claude-copilot login`, then reload.",
      installUrl: "https://claude.com/claude-code",
    },
    // Claude Code's usage check reads the claude.ai subscription, which is not
    // what this provider spends.
    maintenance: { ...maintenance, usage: false },
    env: {
      ...env,
      passthrough: (env.passthrough ?? []).filter(
        (name) => name !== "BB_CLAUDE_CODE_EXECUTABLE" && name !== "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    },
  } as unknown as ProviderDeclaration;
}

function wrapApi(bb: BbPluginApi): BbPluginApi {
  const providers = new Proxy(bb.providers, {
    get(target, key, receiver) {
      if (key === "register") {
        return (declaration: ProviderDeclaration) => target.register(rewriteDeclaration(declaration));
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rpc = new Proxy(bb.rpc, {
    get(target, key, receiver) {
      if (key === "register") {
        return () => {}; // the built-in's provider-usage source; not ours
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(bb, {
    get(target, key, receiver) {
      if (key === "providers") return providers;
      if (key === "rpc") return rpc;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default async function plugin(bb: BbPluginApi) {
  const builtin = (await import(`${pathToFileURL(builtinServerPath()).href}?instance=${PROVIDER_ID}`)) as {
    default: (bb: BbPluginApi) => unknown;
  };
  await builtin.default(wrapApi(bb));

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const ensure = (hostId: string): Promise<ProxyStatus> =>
    host.call("ensureProxy", { pluginDir: PLUGIN_DIR }, { hostId });

  bb.providers.experimental_contributeEnv(PROVIDER_ID, async ({ hostId }) => {
    const status = await ensure(hostId);
    const entries = [
      { name: "ANTHROPIC_BASE_URL", value: `http://127.0.0.1:${status.port}`, reason: "Route Claude Code through the plugin's copilot-api" },
      { name: "ANTHROPIC_AUTH_TOKEN", value: status.apiKey, reason: "Gateway key of the plugin's copilot-api" },
      { name: "ANTHROPIC_MODEL", value: "claude-opus-5-5", reason: "Default model: Opus 5.5" },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "claude-opus-5-5", reason: "Copilot model id" },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: "claude-sonnet-5-5", reason: "Copilot model id" },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "claude-haiku-5-5", reason: "Copilot model id" },
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "0", reason: "Use the Anthropic API shape" },
      { name: "CLAUDE_CODE_AUTO_MODE_SERVER", value: "0", reason: "copilot-api has no auto-mode endpoint" },
      { name: "DISABLE_NON_ESSENTIAL_MODEL_CALLS", value: "1", reason: "Save Copilot requests" },
      { name: "DISABLE_TELEMETRY", value: "1", reason: "No Anthropic telemetry for Copilot sessions" },
      { name: "DISABLE_ERROR_REPORTING", value: "1", reason: "No Anthropic error reporting for Copilot sessions" },
      { name: "DISABLE_FEEDBACK_COMMAND", value: "1", reason: "Feedback goes to Anthropic" },
      { name: "CLAUDE_COPILOT_SESSION", value: "1", reason: "Lets the statusline detect Copilot mode" },
    ];
    if (status.claudePath) {
      entries.push({
        name: "BB_CLAUDE_CODE_EXECUTABLE",
        value: status.claudePath,
        reason: "Plain claude, not a machine-wide wrapper",
      });
    }
    return entries;
  });

  bb.providers.experimental_contributeEnvHealth(PROVIDER_ID, async ({ hostId }) => {
    const status = await ensure(hostId);
    return status.running
      ? { label: "GitHub Copilot", statusMessage: "Signed in through the plugin's copilot-api." }
      : null;
  });

  async function localHostId(): Promise<string> {
    const hosts = (await bb.sdk.hosts.list()) as { id: string; role?: string }[];
    const host = hosts.find((h) => h.role === "server") ?? hosts[0];
    if (!host) throw new Error("No machine is enrolled.");
    return host.id;
  }

  const usage = [
    "bb claude-copilot status   Show the private copilot-api state",
    "bb claude-copilot login    Sign in to GitHub Copilot (device code)",
    "bb claude-copilot start    Start copilot-api",
    "bb claude-copilot stop     Stop copilot-api",
  ].join("\n");

  bb.cli.register({
    name: "claude-copilot",
    summary: "Manage the Claude Code (Copilot) provider's private copilot-api",
    commands: [
      { name: "status", summary: "Show copilot-api state", usage: "bb claude-copilot status" },
      { name: "login", summary: "Sign in to GitHub Copilot", usage: "bb claude-copilot login" },
      { name: "start", summary: "Start copilot-api", usage: "bb claude-copilot start" },
      { name: "stop", summary: "Stop copilot-api", usage: "bb claude-copilot stop" },
    ],
    async run(argv) {
      const [command] = argv;
      const hostId = await localHostId();
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
        case "start":
          return { exitCode: 0, stdout: show(await ensure(hostId)) };
        case "stop": {
          const { stopped } = await host.call("stopProxy", {}, { hostId });
          return { exitCode: 0, stdout: stopped ? "Stopped." : "Not running." };
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
