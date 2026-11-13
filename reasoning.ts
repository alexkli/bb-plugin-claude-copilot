// Shared by the server, host and app bundles (kept free of SDK imports so the
// app bundle stays browser-only).
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
