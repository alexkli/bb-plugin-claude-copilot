import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

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

const pluginDirInput = z.object({ pluginDir: z.string().min(1) }).strict();

export const hostContract = defineRpcContract({
  // bb calls this on the plugin's host entry because the wrapped Claude Code
  // declaration sets experimental_resolvesNativeRoots; we delegate it.
  ...experimental_nativeRootsHostContract,
  ensureProxy: { input: pluginDirInput, output: proxyStatusSchema },
  stopProxy: { input: z.object({}).strict(), output: z.object({ stopped: z.boolean() }) },
  startLogin: { input: pluginDirInput, output: loginStatusSchema },
  loginStatus: { input: z.object({}).strict(), output: loginStatusSchema },
});
