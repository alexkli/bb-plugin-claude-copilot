// Composer indicator: Copilot AI credits the thread's Claude Code session has
// used so far, as copilot-api recorded them. Shown under the prompt next to
// bb's context-window control when that footer is found, otherwise as a
// regular composer action. Only on Claude Code (Copilot) threads. The same
// component is in the Claude Copilot ACP provider plugin.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_useRpcQuery, useComposer } from "@get-bb/plugin-sdk/app";
import { appContract, type SessionCredits, type SessionUsage } from "./contract";

const DOLLARS_PER_CREDIT = 0.01;

// The read comes from bb's shared RPC query cache. While a window shows it, the
// server watches the thread's usage and invalidates the read when it changes
// (server.ts, sessionCredits), so the app doesn't poll.
function useSessionCredits(threadId: string | null): SessionCredits | null {
  const query = experimental_useRpcQuery({
    contract: appContract,
    method: "sessionCredits",
    input: { threadId: threadId ?? "" },
    enabled: threadId !== null,
  });
  return threadId === null ? null : (query.data ?? null);
}

function formatCredits(credits: number): string {
  if (credits === 0) return "0";
  if (credits < 10) return credits.toFixed(2);
  if (credits < 100) return credits.toFixed(1);
  return Math.round(credits).toLocaleString();
}

function formatDollars(credits: number): string {
  return `$${(credits * DOLLARS_PER_CREDIT).toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function CoinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

function Details({ usage, sessionId }: { usage: SessionUsage; sessionId: string }) {
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{formatCredits(usage.credits)} AI credits</span>
        <span className="text-muted-foreground">{formatDollars(usage.credits)}</span>
      </div>
      <div className="text-muted-foreground">
        {usage.requests} requests · {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
        {usage.unpriced > 0 && <> · {usage.unpriced} without a credit amount</>}
      </div>
      {usage.models.length > 0 && (
        <table className="w-full">
          <tbody>
            {usage.models.map((m) => (
              <tr key={m.model}>
                <td className="truncate pr-3 font-mono">{m.model}</td>
                <td className="pr-3 text-right text-muted-foreground">{m.requests}×</td>
                <td className="text-right tabular-nums">{formatCredits(m.credits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="text-muted-foreground">
        This thread's Claude Code session, subagents included, as the plugin's copilot-api recorded it. Not an invoice.
      </div>
      <code className="truncate text-[10px] text-muted-foreground">{sessionId}</code>
    </div>
  );
}

function CreditControl({ credits }: { credits: SessionCredits }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ right: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect) setPosition({ right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8 });
    };
    place();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (credits.status === "unsupported") return null;
  const usage = credits.status === "ok" ? credits.usage : null;
  const label = usage ? formatCredits(usage.credits) : "–";
  const title =
    credits.status === "ok"
      ? `Copilot credits this session: ${formatCredits(credits.usage.credits)} (${formatDollars(credits.usage.credits)}), ${credits.usage.requests} requests`
      : credits.status === "pending"
        ? "Copilot credits: no requests yet"
        : `Copilot credits unavailable: ${credits.message}`;

  return (
    <>
      <button
        ref={button}
        type="button"
        title={open ? undefined : title}
        aria-label={title}
        aria-expanded={open}
        disabled={!usage}
        // the composer focuses its editor on mousedown otherwise
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground disabled:hover:bg-transparent"
        data-testid="claude-copilot-session-credits"
      >
        <CoinIcon />
        <span>{label}</span>
      </button>
      {open &&
        usage &&
        credits.status === "ok" &&
        position &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="Copilot session credits"
            data-bb-plugin-root=""
            data-bb-plugin="claude-copilot"
            onMouseDown={(event) => event.stopPropagation()}
            style={{ position: "fixed", right: position.right, bottom: position.bottom, zIndex: 50 }}
            className="w-80 max-w-[calc(100vw-16px)] rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
          >
            <Details usage={usage} sessionId={credits.sessionId} />
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Placement under the prompt
//
// bb has no SDK slot for the composer footer (where the context-window control
// sits) yet. Like the community "Copilot session credits" plugin (MIT,
// github.com/lalitjeevanrao/bb-plugins), we move only our own portal container
// into that footer, right before the context-window button, and fall back to
// the regular composer action slot when the footer does not look as expected.
// Replace this when bb adds a footer slot.

// Several plugins may put their container in front of the context-window
// button (or at the end of the group while bb shows no button). A container
// counts as placed when only other plugins' containers stand between it and
// the button, so containers never move each other, but bb's own controls that
// mount later (session options, permission selector) can't end up after it.
// One that has to be moved over and over anyway (another plugin fighting for
// the exact spot) gives up and renders in place, so the page can never loop.
const MAX_MOVES = 20;
const MOVE_WINDOW_MS = 2000;

/** Whether only plugin containers stand between `node` and `end` (null: the end of its parent). */
function onlyPluginRootsUntil(node: Node, end: Element | null): boolean {
  for (let next = node.nextSibling; next !== end; next = next.nextSibling) {
    if (!(next instanceof Element) || !next.hasAttribute("data-bb-plugin-root")) return false;
  }
  return true;
}

function attachFooterTarget(anchor: HTMLElement | null, change: (target: HTMLElement | null) => void): () => void {
  const root = anchor?.closest("[data-app-composer]");
  if (!anchor || !root) {
    change(null);
    return () => {};
  }
  let host: HTMLElement | null = null;
  let moves: number[] = [];
  let gaveUp = false;
  const ours = (el: Element) => el.closest("[data-app-composer]") === root;
  const detach = () => {
    host?.remove();
    host = null;
    change(null);
  };
  const sync = () => {
    if (gaveUp) return;
    const footers = Array.from(root.querySelectorAll("[data-follow-up-composer-footer]")).filter(ours);
    const footer = footers.length === 1 ? footers[0]! : null;
    const group = footer?.lastElementChild ?? null;
    const buttons = footer ? Array.from(footer.querySelectorAll('button[aria-label^="Context window"]')).filter(ours) : [];
    const button = buttons[0] ?? null;
    const valid =
      !!footer &&
      !!group &&
      footer.children.length === 2 &&
      Array.from(footer.children).every((child) => child.tagName === "DIV") &&
      group.classList.contains("items-center") &&
      buttons.length <= 1 &&
      (!button || button.parentNode === group);
    if (!valid) return detach();
    if (!host) {
      host = anchor.ownerDocument.createElement("span");
      host.setAttribute("data-bb-plugin-root", "");
      host.setAttribute("data-bb-plugin", "claude-copilot");
      host.style.display = "contents";
    }
    const placed = host.parentNode === group && onlyPluginRootsUntil(host, button);
    if (!placed) {
      const now = Date.now();
      moves = [...moves.filter((t) => now - t < MOVE_WINDOW_MS), now];
      if (moves.length > MAX_MOVES) {
        gaveUp = true;
        observer.disconnect();
        return detach();
      }
      group.insertBefore(host, button);
    }
    change(host);
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
  sync();
  return () => {
    observer.disconnect();
    host?.remove();
  };
}

/** Attaches to bb's composer footer only on this provider's threads; elsewhere renders nothing. */
function CreditPlacement() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const credits = useSessionCredits(threadId);
  if (!credits || credits.status === "unsupported") return null;
  return <FooterPlacement credits={credits} />;
}

function FooterPlacement({ credits }: { credits: SessionCredits }) {
  const anchor = useRef<HTMLSpanElement>(null);
  // undefined: not measured yet; null: no footer, render in place
  const [target, setTarget] = useState<HTMLElement | null>();
  useEffect(() => attachFooterTarget(anchor.current, setTarget), []);
  return (
    <>
      <span hidden ref={anchor} />
      {target ? createPortal(<CreditControl credits={credits} />, target) : target === null ? <CreditControl credits={credits} /> : null}
    </>
  );
}

/** Composer action (expanded layout). */
export function SessionCreditsAction() {
  return useComposer().layout === "compact" ? null : <CreditPlacement />;
}

/** Bare banner (compact layout, where actions are not shown). */
export function SessionCreditsCompact() {
  return useComposer().layout === "compact" ? <CreditPlacement /> : null;
}
