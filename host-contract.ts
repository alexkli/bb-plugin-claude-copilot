// Server <-> host entry contract. Its own module because it imports the SDK's
// host entry (Node only); contract.ts stays importable from the app.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { REASONING_LEVELS } from "./reasoning.js";
import { apiResponseSchema, claudeSessionIdSchema, copilotModelSchema, instanceSchema, loginStatusSchema, proxyStatusSchema, sessionUsageSchema } from "./contract.js";

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
