# bb-plugin-claude-copilot

**Claude Code (Copilot)** as its own bb provider: Claude Code running against
GitHub Copilot through a private, bundled
[copilot-api](https://github.com/caozhiyuan/copilot-api). It sits next to bb's
normal Claude Code provider, which keeps using your Anthropic login.

Status: experimental prototype.

## How it works

- **No fork of bb's Claude Code provider.** `server.ts` loads bb's built-in
  `provider-claude-code` server bundle from the running bb install and calls
  it with a wrapped plugin API that re-registers the provider as
  `claude-copilot` (own name, icon and sign-in copy; usage maintenance off;
  `BB_CLAUDE_CODE_EXECUTABLE` / `CLAUDE_CODE_OAUTH_TOKEN` not passed through)
  and drops its claude.ai usage RPC. `host.ts` exports a bridge that loads
  bb's own Claude Code bridge from the host-artifact cache
  (`~/.bb/plugin-host-artifacts/provider-claude-code/<digest>/host.mjs`) and
  forwards to it, and delegates `resolveNativeRoots` to the built-in host
  entry. bb updates therefore flow through. This relies on bb internals that
  are not public API.
- **Private copilot-api.** Pinned in this plugin's `package.json`, run with
  bb's own Node (`ELECTRON_RUN_AS_NODE=1`), with its own `COPILOT_API_HOME`
  (`~/.bb/plugins/claude-copilot/host-data/copilot-api`), a random port and a
  generated gateway key (`auth.apiKeys`). A machine-wide copilot-api install,
  its `~/.local/share/copilot-api` state and port 4141 are not used.
- **Thread environment.** `bb.providers.experimental_contributeEnv` gives only
  this provider `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, the Copilot model
  ids, the `DISABLE_*` flags and plain `claude` as `BB_CLAUDE_CODE_EXECUTABLE`.
  `experimental_contributeEnvHealth` reports the provider healthy while the
  proxy runs, so no claude.ai login is needed.
- **Catalog defaults.** The bridge's model catalog is adjusted on its way to
  bb so the configured default model and reasoning level (Opus 5.5, medium)
  are preselected. Claude Code's own "default" entry ignores `ANTHROPIC_MODEL`.
- **Idle stop.** copilot-api stops when no Claude Code (Copilot) thread has
  been running for the configured minutes (default 30); the next turn starts
  it again through the env resolver.
- **Plan mode** and the rest of Claude Code's bb features come from the
  reused declaration and bridge.
- **Icon.** The Claude mark with the GitHub Copilot glyph in the bottom-right
  corner (`app.tsx`; `icons/claude-copilot.svg` is the monochrome fallback).

## In bb

- **Settings → Claude Copilot**: bb's Claude Code options for this provider,
  plus default model / reasoning, the Opus/Sonnet/Haiku model mapping and the
  idle-stop minutes. The **GitHub Copilot** section signs in with a GitHub
  device code, shows the account and copilot-api state (start / stop /
  restart), and edits copilot-api's `config.json` (saving reloads it; the
  plugin-managed gateway keys are hidden and preserved).
- **Copilot usage** page and sidebar-footer button: copilot-api's usage
  dashboard for this proxy, in a sandboxed iframe whose data requests go
  through the plugin (`/viewer`, `/proxy` routes → host entry), so it works
  from bb on a phone too.
- **Provider usage card**: the Copilot premium-request quota (percent used,
  reset date). Background polls never start an idle copilot-api; they show
  the last value.

## Commands

```
bb claude-copilot status   Show the private copilot-api state
bb claude-copilot login    Sign in to GitHub Copilot (device code)
bb claude-copilot logout   Sign out of GitHub Copilot
bb claude-copilot start    Start copilot-api
bb claude-copilot stop     Stop copilot-api
```

## Develop

```
npm install
bb plugin build
bb plugin install .        # once
bb plugin reload claude-copilot
```

copilot-api's log: `~/.bb/plugins/claude-copilot/host-data/copilot-api.log`.
