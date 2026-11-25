// Settings owned by this plugin and rendered by its settings section (not
// bb's declarative form), so the page can show sign-in first and model
// dropdowns from the live Copilot model list.
//
// Two groups, persisted in bb.storage.kv:
// - copilot: this plugin's own settings (models, reasoning, idle stop);
// - claude: the settings of the wrapped Claude Code provider
//   (vendor/provider-claude-code). Their descriptors come from it at load time
//   (so new ones from an upstream sync appear), and their values reach it
//   through deriveProviderOptions.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  copilotSettingsSchema,
  type CopilotSettings,
  type SettingField,
  type SettingValue,
} from "./contract.js";

export const COPILOT_DEFAULTS: CopilotSettings = {
  defaultModel: "claude-opus-5-5",
  defaultReasoning: "medium",
  opusModel: "claude-opus-5-5",
  sonnetModel: "claude-sonnet-5-5",
  haikuModel: "claude-haiku-5-5",
  idleStopMinutes: 30,
  promptOnSandboxEscape: false,
};

const STORAGE_KEY = "settings.v1";

type Stored = { copilot?: Partial<CopilotSettings>; claude?: Record<string, SettingValue> };

/** A serializable field from a bb setting descriptor; null for unsupported types. */
export function toSettingField(key: string, descriptor: unknown): SettingField | null {
  const d = descriptor as Record<string, unknown>;
  const type = d.type;
  if (type !== "boolean" && type !== "string" && type !== "number" && type !== "select") return null;
  if (d.secret === true) return null; // never round-trip secrets through the frontend
  const value = d.default;
  return {
    key,
    type,
    label: typeof d.label === "string" ? d.label : key,
    description: typeof d.description === "string" ? d.description : null,
    options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === "string") : null,
    optionLabels:
      d.experimental_optionLabels && typeof d.experimental_optionLabels === "object"
        ? (d.experimental_optionLabels as Record<string, string>)
        : null,
    default: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null,
  };
}

export class SettingsStore {
  private stored: Stored = {};
  private listeners = new Set<() => void>();
  claudeFields: SettingField[] = [];

  constructor(private readonly bb: BbPluginApi) {}

  async load(): Promise<void> {
    this.stored = (await this.bb.storage.kv.get<Stored>(STORAGE_KEY)) ?? {};
  }

  setClaudeDescriptors(descriptors: Record<string, unknown>): void {
    this.claudeFields = Object.entries(descriptors)
      .map(([key, descriptor]) => toSettingField(key, descriptor))
      .filter((field): field is SettingField => field !== null);
  }

  copilot(): CopilotSettings {
    const parsed = copilotSettingsSchema.safeParse({ ...COPILOT_DEFAULTS, ...this.stored.copilot });
    return parsed.success ? parsed.data : COPILOT_DEFAULTS;
  }

  /** Built-in Claude Code settings: defaults overlaid with stored values. Synchronous for deriveProviderOptions. */
  claudeValues(): Record<string, SettingValue> {
    const values: Record<string, SettingValue> = {};
    for (const field of this.claudeFields) {
      const stored = this.stored.claude?.[field.key];
      if (stored !== undefined) values[field.key] = stored;
      else if (field.default !== null) values[field.key] = field.default;
    }
    return values;
  }

  async setCopilot(patch: Partial<CopilotSettings>): Promise<void> {
    const next = copilotSettingsSchema.parse({ ...this.copilot(), ...patch });
    this.stored = { ...this.stored, copilot: next };
    await this.save();
  }

  async setClaude(key: string, value: SettingValue): Promise<void> {
    const field = this.claudeFields.find((f) => f.key === key);
    if (!field) throw new Error(`Unknown setting: ${key}`);
    const valid =
      field.type === "boolean"
        ? typeof value === "boolean"
        : field.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : field.type === "select"
            ? typeof value === "string" && (field.options ?? []).includes(value)
            : typeof value === "string";
    if (!valid) throw new Error(`Invalid value for ${field.label}.`);
    this.stored = { ...this.stored, claude: { ...this.stored.claude, [key]: value } };
    await this.save();
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private async save(): Promise<void> {
    await this.bb.storage.kv.set(STORAGE_KEY, this.stored);
    for (const listener of this.listeners) listener();
  }
}
