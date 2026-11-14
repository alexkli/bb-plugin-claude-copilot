import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

import { REASONING_LEVELS } from "./reasoning.js";

export { REASONING_LEVELS, type ReasoningLevel } from "./reasoning.js";

export const proxyStatusSchema = z.object({
  running: z.boolean(),
  signedIn: z.boolean(),
  port: z.number().int(),
  apiKey: z.string(),
  claudePath: z.string().nullable(),
  home: z.string(),
  error: z.string().nullable(),
});
export type ProxyStatus = z.infer<typeof proxyStatusSchema>;

export const loginStatusSchema = z.object({
  state: z.enum(["idle", "waiting", "succeeded", "failed"]),
  userCode: z.string().nullable(),
  url: z.string().nullable(),
  message: z.string().nullable(),
});
export type LoginStatus = z.infer<typeof loginStatusSchema>;

/** A Copilot chat model as the catalog and settings use it. */
export const copilotModelSchema = z.object({
  /** Model id Claude Code sends (copilot-api convention: my-claude- prefix, [1m] suffix). */
  id: z.string().min(1),
  /** Copilot's own model id. */
  upstreamId: z.string().min(1),
  displayName: z.string().min(1),
  vendor: z.string().nullable(),
  contextWindow: z.number().int().nullable(),
  inputLimit: z.number().int().nullable(),
  reasoningEfforts: z.array(z.enum(REASONING_LEVELS)),
});
export type CopilotModel = z.infer<typeof copilotModelSchema>;

/** What the provider bridge reads to adjust the model catalog it reports. */
export const catalogFileSchema = z
  .object({
    defaultModel: z.string().min(1).max(300),
    defaultReasoning: z.enum(REASONING_LEVELS),
    models: z.array(copilotModelSchema),
  })
  .strict();
export type CatalogFile = z.infer<typeof catalogFileSchema>;

export const apiResponseSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.string(),
});
export type ApiResponse = z.infer<typeof apiResponseSchema>;

export const instanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  home: z.string().min(1),
  own: z.boolean(),
  /** Port of a running copilot-api process using this home, if known. */
  port: z.number().int().nullable(),
});
export type Instance = z.infer<typeof instanceSchema>;

/** Copilot usage copilot-api recorded for one Claude Code session (subagents included). */
export const sessionUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  /** AI credits (1 credit = $0.01); copilot-api's total_nano_aiu / 1e9. */
  credits: z.number().nonnegative(),
  /** Requests without a reported credit amount (counted, not priced). */
  unpriced: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  models: z.array(z.object({ model: z.string(), requests: z.number().int().nonnegative(), credits: z.number().nonnegative() })),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/** Claude Code session ids are UUIDs. */
export const claudeSessionIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const sessionCreditsSchema = z.discriminatedUnion("status", [
  /** Not a Claude Code (Copilot) thread: show nothing. */
  z.object({ status: z.literal("unsupported") }),
  /** No Claude Code session yet (thread not started). */
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("ok"), sessionId: z.string(), usage: sessionUsageSchema }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type SessionCredits = z.infer<typeof sessionCreditsSchema>;

const pluginDirInput = z.object({ pluginDir: z.string().min(1) }).strict();

/** Server <-> host entry. */
export const hostContract = defineRpcContract({
  // bb calls this on the plugin's host entry because the wrapped Claude Code
  // declaration sets experimental_resolvesNativeRoots; we delegate it.
  ...experimental_nativeRootsHostContract,
  ensureProxy: {
    input: z
      .object({
        pluginDir: z.string().min(1),
        catalog: z.object({ defaultModel: z.string().min(1).max(300), defaultReasoning: z.enum(REASONING_LEVELS) }).strict(),
      })
      .strict(),
    output: proxyStatusSchema,
  },
  proxyStatus: { input: z.object({}).strict(), output: proxyStatusSchema },
  stopProxy: { input: z.object({}).strict(), output: z.object({ stopped: z.boolean() }) },
  startLogin: { input: pluginDirInput, output: loginStatusSchema },
  loginStatus: { input: z.object({}).strict(), output: loginStatusSchema },
  signOut: { input: z.object({}).strict(), output: z.object({ signedOut: z.boolean() }) },
  /** GET a path on the embedded copilot-api, with the gateway key. */
  apiRequest: {
    input: z.object({ path: z.string().min(1).max(4096) }).strict(),
    output: apiResponseSchema,
  },
  /** Copilot chat models (cached from the last running copilot-api). */
  models: { input: z.object({}).strict(), output: z.object({ models: z.array(copilotModelSchema) }) },
  /** Local copilot-api homes with a usage database. */
  listInstances: { input: z.object({}).strict(), output: z.object({ instances: z.array(instanceSchema) }) },
  /** token-usage read for another instance, from a read-only snapshot of its database. */
  instanceUsage: {
    input: z.object({ pluginDir: z.string().min(1), instanceId: z.string().min(1), path: z.string().min(1).max(2048) }).strict(),
    output: apiResponseSchema,
  },
  /** Usage this plugin's copilot-api recorded for one Claude Code session. */
  sessionUsage: { input: z.object({ sessionId: claudeSessionIdSchema }).strict(), output: sessionUsageSchema },
  /** copilot-api's config.json without the plugin-managed auth keys. */
  getConfig: { input: z.object({}).strict(), output: z.object({ json: z.string() }) },
  setConfig: {
    input: z.object({ json: z.string().max(1_000_000) }).strict(),
    output: z.object({ reloaded: z.boolean(), message: z.string().nullable() }),
  },
});

export const appStatusSchema = z.object({
  hostName: z.string().nullable(),
  proxy: proxyStatusSchema.omit({ apiKey: true }).nullable(),
  login: loginStatusSchema,
  account: z.string().nullable(),
  plan: z.string().nullable(),
  error: z.string().nullable(),
});
export type AppStatus = z.infer<typeof appStatusSchema>;

// -- Settings (owned by this plugin, rendered by its settings section) --------

export const settingValueSchema = z.union([z.string().max(10_000), z.number(), z.boolean()]);
export type SettingValue = z.infer<typeof settingValueSchema>;

/** A serializable copy of a declared setting (the built-in Claude Code ones). */
export const settingFieldSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["boolean", "string", "number", "select"]),
  label: z.string(),
  description: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  optionLabels: z.record(z.string(), z.string()).nullable(),
  default: settingValueSchema.nullable(),
});
export type SettingField = z.infer<typeof settingFieldSchema>;

export const copilotSettingsSchema = z
  .object({
    defaultModel: z.string().trim().min(1).max(300),
    defaultReasoning: z.enum(REASONING_LEVELS),
    opusModel: z.string().trim().min(1).max(300),
    sonnetModel: z.string().trim().min(1).max(300),
    haikuModel: z.string().trim().min(1).max(300),
    idleStopMinutes: z.number().int().min(0).max(24 * 60),
  })
  .strict();
export type CopilotSettings = z.infer<typeof copilotSettingsSchema>;

export const settingsViewSchema = z.object({
  copilot: copilotSettingsSchema,
  claudeFields: z.array(settingFieldSchema),
  claudeValues: z.record(z.string(), settingValueSchema),
  models: z.array(copilotModelSchema),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

/** Frontend <-> server. */
export const appContract = defineRpcContract({
  status: { input: z.null(), output: appStatusSchema },
  startLogin: { input: z.null(), output: loginStatusSchema },
  signOut: { input: z.null(), output: z.object({ signedOut: z.boolean() }) },
  start: { input: z.null(), output: appStatusSchema },
  stop: { input: z.null(), output: appStatusSchema },
  restart: { input: z.null(), output: appStatusSchema },
  getConfig: { input: z.null(), output: z.object({ json: z.string() }) },
  setConfig: {
    input: z.object({ json: z.string().max(1_000_000) }).strict(),
    output: z.object({ reloaded: z.boolean(), message: z.string().nullable() }),
  },
  getSettings: { input: z.null(), output: settingsViewSchema },
  setCopilotSettings: { input: copilotSettingsSchema.partial(), output: settingsViewSchema },
  setClaudeSetting: {
    input: z.object({ key: z.string().min(1).max(100), value: settingValueSchema }).strict(),
    output: settingsViewSchema,
  },
  listInstances: { input: z.null(), output: z.object({ instances: z.array(instanceSchema) }) },
  /** Copilot credits the thread's Claude Code session used so far. */
  sessionCredits: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: sessionCreditsSchema },
});
