// Provider icon for "Claude Code (Copilot)": the orange Claude mark with the
// GitHub Copilot glyph in the bottom-right corner (same layout as the
// claude-bedrock plugin's AWS badge). Keep in sync with icons/claude-copilot.svg.
import { useId } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CLAUDE_MARK, COPILOT_PATHS } from "./icon-paths";

function ClaudeCopilotIcon({ className }: { className?: string }) {
  const mask = useId();
  return (
    // explicit width/height: without them WebKit (iOS app) sizes the svg at 300px
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="16" height="16" className={className} aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="1200" height="1200" fill="#fff" />
          <rect x="560" y="640" width="660" height="580" rx="170" fill="#000" />
        </mask>
      </defs>
      <path fill="#D97757" mask={`url(#${mask})`} d={CLAUDE_MARK} />
      {/* Copilot glyph in the theme's text colour */}
      <g transform="translate(624 674) scale(11.5)" fill="currentColor">
        {COPILOT_PATHS.map((d) => (
          <path key={d.slice(0, 16)} d={d} />
        ))}
      </g>
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "claude-copilot", icon: ClaudeCopilotIcon });
});
