import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

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

export const catalogDefaultsSchema = z
  .object({
    defaultModel: z.string().min(1).max(200),
    defaultReasoning: z.enum(REASONING_LEVELS),
  })
  .strict();
export type CatalogDefaults = z.infer<typeof catalogDefaultsSchema>;

export const apiResponseSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.string(),
});
export type ApiResponse = z.infer<typeof apiResponseSchema>;

const pluginDirInput = z.object({ pluginDir: z.string().min(1) }).strict();

/** Server <-> host entry. */
export const hostContract = defineRpcContract({
  // bb calls this on the plugin's host entry because the wrapped Claude Code
  // declaration sets experimental_resolvesNativeRoots; we delegate it.
  ...experimental_nativeRootsHostContract,
  ensureProxy: {
    input: z.object({ pluginDir: z.string().min(1), catalog: catalogDefaultsSchema }).strict(),
    output: proxyStatusSchema,
  },
  proxyStatus: { input: z.object({}).strict(), output: proxyStatusSchema },
  stopProxy: { input: z.object({}).strict(), output: z.object({ stopped: z.boolean() }) },
  startLogin: { input: pluginDirInput, output: loginStatusSchema },
  loginStatus: { input: z.object({}).strict(), output: loginStatusSchema },
  signOut: { input: z.object({}).strict(), output: z.object({ signedOut: z.boolean() }) },
  /** GET a path on the private copilot-api, with the gateway key. */
  apiRequest: {
    input: z.object({ path: z.string().min(1).max(4096) }).strict(),
    output: apiResponseSchema,
  },
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
});
