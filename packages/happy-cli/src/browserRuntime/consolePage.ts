/**
 * Client console served at GET /console: find the principal's open tasks on the
 * capability's profile, watch a task's events, answer approvals, take/release
 * control, resume/stop, and open the live screen through the Runtime viewer.
 * Vanilla JS, no external assets.
 *
 * Capability hand-off (D12): Desktop opens `/console#abp-cap=<abp2 token>&abp-exp=<ms>`.
 * The page reads the fragment once, removes it from the address and keeps the
 * token in memory only. About a minute before expiry it asks its host with
 * `postMessage({ type: 'abp-capability-request' }, location.origin)` (every 10 s
 * until answered) and accepts `{ type: 'abp-capability', token, expiresAtMs }`
 * only from `window.parent` on its own origin. Desktop hosts the page in a
 * `<webview>` without preload, so `window.parent === window` and the answer is
 * posted into the page by the host. A load without a fragment (reload, back
 * navigation, restored panel) asks the host at once and every 10 s until answered;
 * in the harness the token can also be pasted, still kept in memory only. An open
 * screen is reconnected with a fresh ticket after each renewal (a viewer connection
 * ends with the capability it was ticketed with). Take over/release use the selected
 * tab's own lease epoch from getTask().tabLeases.
 *
 * Studio web opens the page in a new window through its preview relay, which
 * strips the URL (fragment included) on load. There the host is `window.opener`
 * on the Studio origin: requests go to it addressed to each configured
 * `hostOrigins` entry (so another opener never hears them), and an answer is
 * accepted only from `window.opener` on one of those origins.
 *
 * Look and language follow Saycode Desktop (docs/STYLEGUIDE.md): the same semantic colour
 * tokens, type scale, radii and shadows, light or dark by `?theme=` or the system scheme, and
 * Korean or English by `?lang=` or the browser language. The element ids and the task list layout
 * (`#tasks > button` for tasks waiting for the user, the rest folded in `#tasks details`) are part of the
 * contract the real-Chrome tests drive.
 *
 * Screen first (aplus agent-browser-screen-first): the page is a column that uses the whole window.
 * The tasks live in a header menu (`#taskMenu`, a <details>; `#needCount` keeps the number of tasks
 * needing the user in view while it is closed), the selected task's state and controls are one bar,
 * and the screen takes the width and the remaining height. Fit / actual size (`#fitToggle`, `#actualSize`) is
 * noVNC's own scaleViewport on the frame's RFB object (handed over by the Runtime's viewer hook as
 * `__abpRfb`; the console's choice is read back from `__abpViewerFit` when a frame loads), so it
 * never reconnects and never asks the remote display to change size. The same hook sets noVNC's viewOnly from
 * `__abpViewerControl` (whether this console's own capability holds the shown task's lease), so without control a wheel over an
 * actual-size screen pans the frame instead of being swallowed by the canvas. Activity and Advanced are
 * buttons on that line whose panels open under the screen, closed by default.
 */
export function renderConsolePage(opts: { hostOrigins?: readonly string[] } = {}): string {
    // JSON in an inline script: escape '<' so an origin can never close the tag.
    const hostOrigins = JSON.stringify(opts.hostOrigins ?? []).replace(/</g, '\\u003c')
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Browser</title>
<style>
/* Saycode Desktop semantic tokens (src/styles.css). Light, then dark twice: explicit theme and OS fallback, kept identical. */
:root{color-scheme:light;
--background:#FFFFFF;--foreground:#09090B;--card:#FFFFFF;--muted:#EBEBEC;--muted-foreground:#52525B;--accent:#E2E2E4;--border:#DCDCE0;--input:rgba(0,0,0,.08);
--primary:#1B64DA;--primary-hover:#1957C2;--primary-foreground:#FFFFFF;--ring:#1B64DA;--success:#10B981;--warn:#b9730a;--destructive:#EF4444;
--shadow-xs:0 1px 1.5px rgba(20,27,56,.05),0 1px 2px rgba(20,27,56,.04);--shadow-sm:0 1px 2px rgba(20,27,56,.05),0 6px 16px -6px rgba(20,27,56,.12);
--primary-text:var(--primary);--danger-text:color-mix(in srgb,var(--destructive) 82%,var(--foreground))}
:root[data-theme="dark"]{color-scheme:dark;
--background:#13161A;--foreground:#FAFAFA;--card:#22252C;--muted:#272932;--muted-foreground:#A1A1AA;--accent:#333740;--border:#3E424D;--input:rgba(255,255,255,.10);
--primary:#2470E4;--primary-hover:#1B64DA;--primary-foreground:#FFFFFF;--ring:#2470E4;--success:#10B981;--warn:#fbc04e;--destructive:#EF4444;
--shadow-xs:0 1px 2px rgba(0,0,0,.4);--shadow-sm:0 1px 2px rgba(0,0,0,.4),0 8px 20px -8px rgba(0,0,0,.55);
--primary-text:color-mix(in srgb,var(--primary) 70%,var(--foreground));--danger-text:color-mix(in srgb,var(--destructive) 80%,var(--foreground))}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;
--background:#13161A;--foreground:#FAFAFA;--card:#22252C;--muted:#272932;--muted-foreground:#A1A1AA;--accent:#333740;--border:#3E424D;--input:rgba(255,255,255,.10);
--primary:#2470E4;--primary-hover:#1B64DA;--primary-foreground:#FFFFFF;--ring:#2470E4;--success:#10B981;--warn:#fbc04e;--destructive:#EF4444;
--shadow-xs:0 1px 2px rgba(0,0,0,.4);--shadow-sm:0 1px 2px rgba(0,0,0,.4),0 8px 20px -8px rgba(0,0,0,.55);
--primary-text:color-mix(in srgb,var(--primary) 70%,var(--foreground));--danger-text:color-mix(in srgb,var(--destructive) 80%,var(--foreground))}}
/* Derived roles, the same formulas Desktop uses (tints via color-mix keep light/dark parity automatic). */
:root{--canvas:color-mix(in srgb,var(--muted) 40%,var(--background));--surface-hover:var(--accent);--surface-active:color-mix(in srgb,var(--primary) 10%,var(--background));
--border-soft:color-mix(in srgb,var(--border) 65%,transparent);--accent-soft:color-mix(in srgb,var(--primary) 10%,var(--background));
--ok:color-mix(in srgb,var(--success) 65%,var(--foreground));--ok-soft:color-mix(in srgb,var(--success) 12%,var(--background));
--warn-text:color-mix(in srgb,var(--warn) 78%,var(--foreground));--warn-soft:color-mix(in srgb,var(--warn) 12%,var(--background));
--danger-soft:color-mix(in srgb,var(--destructive) 10%,var(--background));
--radius-sm:10px;--radius-md:12px;--radius-lg:14px;--ease:cubic-bezier(.22,.61,.18,1);
--font-sans:"Inter var",Inter,"Pretendard Variable",Pretendard,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--font-mono:"SF Mono","JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--canvas);color:var(--foreground);font:13px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01","calt","kern";text-rendering:optimizeLegibility}
svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted-foreground) 35%,transparent);border-radius:3px}
[hidden]{display:none!important}
/* Header: brand mark, the task menu and the capability state. */
header{display:flex;align-items:center;gap:12px;height:52px;flex:none;padding:0 16px;border-bottom:1px solid var(--border-soft);background:var(--card);position:relative;z-index:2}
header h1{display:flex;align-items:center;gap:10px;margin:0;flex:0 1 auto;min-width:0;overflow:hidden;font-size:14px;font-weight:600;line-height:1.2;white-space:nowrap}
.brand-mark{width:28px;height:28px;border-radius:8px;background:var(--accent-soft);color:var(--primary);display:grid;place-items:center;flex:none}
.brand-text{display:flex;flex-direction:column;min-width:0;overflow:hidden}
.brand-text>span{overflow:hidden;text-overflow:ellipsis}
.brand-sub{font-size:11px;font-weight:400;color:var(--muted-foreground);margin-top:1px;overflow:hidden;text-overflow:ellipsis}
.pill{min-width:0;overflow:hidden;display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 10px 0 8px;border-radius:999px;font-size:11.5px;font-weight:500;color:var(--muted-foreground);
background:color-mix(in srgb,var(--muted) 60%,var(--background));border:1px solid var(--border-soft);white-space:nowrap;transition:background-color .15s var(--ease),color .15s var(--ease),border-color .15s var(--ease)}
.pill>span{overflow:hidden;text-overflow:ellipsis}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--muted-foreground);opacity:.6;flex:none}
.pill.on{color:var(--ok);background:var(--ok-soft);border-color:color-mix(in srgb,var(--success) 25%,transparent)}
.pill.on i{background:var(--success);opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--success) 18%,transparent)}
.pill.bad{color:var(--danger-text);background:var(--danger-soft);border-color:color-mix(in srgb,var(--destructive) 25%,transparent)}.pill.bad i{background:var(--destructive);opacity:1}
.spacer{flex:1}
/* Layout: one column; the screen takes the remaining height, folds sit under it, the page scrolls only when they are open. */
main{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:12px 16px;overflow:auto}
main>*{min-width:0;flex:none}
#detail{display:flex;flex-direction:column;gap:12px}
@media (max-width:600px){main{padding:10px 12px;gap:10px}header{padding:0 12px;gap:8px}.brand-text{display:none}}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;box-shadow:var(--shadow-xs)}
.card h2{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.card>h2{margin-bottom:12px}
.card h2 svg{color:var(--muted-foreground)}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;margin-bottom:12px}
.muted{color:var(--muted-foreground)}.small{font-size:12px}.mono{font-family:var(--font-mono);font-size:11.5px}
/* Controls: 34px, one filled primary per card, outline for the rest, danger text only on Stop. */
button{font:inherit;font-size:13px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:var(--radius-sm);
border:1px solid var(--border);background:var(--card);color:var(--foreground);cursor:pointer;white-space:nowrap;transition:border-color .15s var(--ease),background-color .15s var(--ease),color .15s var(--ease)}
button:hover{border-color:color-mix(in srgb,var(--primary) 35%,var(--border))}
button:active{background:var(--surface-hover)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
button.primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}button.primary:active{background:var(--primary-hover)}
button.danger{color:var(--danger-text)}
button.danger:hover{border-color:color-mix(in srgb,var(--destructive) 40%,var(--border));background:var(--danger-soft)}
button.icon{width:30px;height:30px;padding:0;border-color:transparent;background:transparent;color:var(--muted-foreground)}
button.icon:hover{background:var(--surface-hover);color:var(--foreground);border-color:transparent}
.row{display:flex;flex-wrap:wrap;gap:8px}
#stop{margin-left:auto}
@media (max-width:480px){.bar .row>button,#approvalBox .row>button{flex:1 1 calc(50% - 4px)}#stop{margin-left:0}}
input{font:inherit;font-size:13px;width:100%;height:34px;padding:0 10px;margin:4px 0 10px;border-radius:var(--radius-sm);border:1px solid var(--input);background:var(--background);color:var(--foreground);
transition:border-color .15s var(--ease),box-shadow .15s var(--ease)}
input:hover{border-color:var(--border)}
input:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 20%,transparent)}
label{display:block;font-size:12px;font-weight:500;color:var(--muted-foreground)}
.adv-block{margin-top:12px}
/* Task list: a row per task, the status first to the eye, the id underneath (DOM order keeps the id first). */
/* Task menu: a <details> in the header; the summary is the button (focusable, Enter/Space), the panel drops under it. */
.menu{position:relative;min-width:0;flex:0 1 auto}
.menu>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;height:32px;max-width:min(440px,100%);padding:0 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--card);
font-size:12.5px;font-weight:500;user-select:none;transition:border-color .15s var(--ease),background-color .15s var(--ease)}
.menu>summary:hover{border-color:color-mix(in srgb,var(--primary) 35%,var(--border))}
.menu[open]>summary{border-color:var(--primary);background:var(--surface-active)}
.menu>summary svg{color:var(--muted-foreground)}
.menu>summary::after{content:"";width:6px;height:6px;margin:0 2px 3px;border-right:1.5px solid var(--muted-foreground);border-bottom:1.5px solid var(--muted-foreground);transform:rotate(45deg);flex:none;transition:transform .15s var(--ease)}
.menu[open]>summary::after{transform:rotate(-135deg);margin-bottom:-2px}
#taskMenuLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--warn-soft);color:var(--warn-text);font-size:11px;font-weight:600;flex:none}
.menu-panel{position:absolute;top:calc(100% + 6px);left:0;z-index:5;width:min(380px,calc(100vw - 24px));max-height:min(70vh,560px);overflow:auto;padding:12px;
background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm)}
/* A list failure is never only inside the closed menu: this line stays in view above the task, with a retry. */
.notice{display:flex;align-items:center;gap:10px;padding:10px 14px;border-color:color-mix(in srgb,var(--destructive) 35%,var(--border));background:var(--danger-soft);color:var(--danger-text)}
.notice>span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.notice>button{flex:none;height:30px;font-size:12px}
#tasks{display:flex;flex-direction:column;gap:6px}
#tasks.muted{padding:10px 4px;font-size:12px;color:var(--muted-foreground)}
#tasks button{display:grid;grid-template-columns:8px minmax(0,1fr);grid-template-areas:"dot what" ". tid";column-gap:10px;row-gap:3px;align-items:center;width:100%;height:auto;text-align:left;
padding:10px 12px;border-radius:var(--radius-md);line-height:1.35;font-weight:400}
#tasks button:hover{border-color:var(--border);background:color-mix(in srgb,var(--muted) 50%,var(--background))}
#tasks button.sel{border-color:var(--primary);background:var(--surface-active)}
#tasks button .dot{grid-area:dot;width:8px;height:8px;border-radius:50%;background:var(--border)}
#tasks button .dot.warn{background:var(--warn)}#tasks button .dot.run{background:var(--primary)}#tasks button .dot.ok{background:var(--success)}
#tasks button .tid{grid-area:tid;display:block;font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#tasks button .what{grid-area:what;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
#tasks button .when{font-size:11px;color:var(--muted-foreground);font-weight:400;flex:none}
#tasks details{margin-top:4px}
#tasks summary{cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--muted-foreground);padding:6px 4px;border-radius:8px;list-style:none;user-select:none}
#tasks summary:hover{color:var(--foreground)}
#tasks summary::before{content:"";width:5px;height:5px;margin:0 3px 1px 3px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s var(--ease)}
#tasks details[open] summary::before{transform:rotate(45deg)}
#tasks details button{margin-top:6px}
.chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.01em;background:var(--muted);color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip.warn{background:var(--warn-soft);color:var(--warn-text)}.chip.run{background:var(--accent-soft);color:var(--primary-text)}.chip.ok{background:var(--ok-soft);color:var(--ok)}
.empty{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;padding:28px 12px;color:var(--muted-foreground);font-size:12px}
.empty svg{width:40px;height:40px;padding:10px;border-radius:12px;background:var(--muted);color:var(--muted-foreground);margin-bottom:6px}
.empty b{color:var(--foreground);font-size:14px;font-weight:600}
#placeholder .empty{padding:28px 16px}
.warn-text{color:var(--danger-text)}
/* Selected task: one bar — what it waits for, in words, with a tone tile, then the controls. */
.bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;padding:10px 14px}
.bar .row{flex:none;margin-left:auto}
.bar #actionResult{flex:1 1 100%;margin-top:0}
.title{display:flex;align-items:center;gap:12px;flex:1 1 260px;min-width:0}
.title-text{min-width:0;flex:1}
.tile{width:40px;height:40px;border-radius:var(--radius-md);display:grid;place-items:center;flex:none;background:var(--muted);color:var(--muted-foreground)}
.tile svg{width:20px;height:20px}
.tile.warn{background:var(--warn-soft);color:var(--warn-text)}.tile.run{background:var(--accent-soft);color:var(--primary-text)}.tile.ok{background:var(--ok-soft);color:var(--ok)}
.title h2{font-size:14px;font-weight:600;line-height:1.3;min-height:18px}
.reason{margin:2px 0 0;font-size:12px;color:var(--muted-foreground)}
#detailId{margin:2px 0 0;font-family:var(--font-mono);font-size:11px;line-height:1.4;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:600px){.bar .row{margin-left:0;flex:1 1 100%}}
#approvalBox{border-color:color-mix(in srgb,var(--warn) 35%,var(--border));background:color-mix(in srgb,var(--warn) 6%,var(--card))}
#approvalBox h2{color:var(--warn-text)}#approvalBox h2 svg{color:var(--warn-text)}
#approval{margin:0 0 14px}#approval .desc{font-size:14px;font-weight:500;line-height:1.45;color:var(--foreground);white-space:pre-wrap;word-break:break-word}
#approval .meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:12px;color:var(--muted-foreground)}
#actionResult:empty{display:none}
#actionResult{margin-top:10px;font-size:12px;padding:8px 12px;border-radius:var(--radius-sm);background:var(--canvas);border:1px solid var(--border-soft);color:var(--foreground)}
#actionResult.ok{background:var(--ok-soft);color:var(--ok);border-color:color-mix(in srgb,var(--success) 25%,transparent)}
#actionResult.err{background:var(--danger-soft);color:var(--danger-text);border-color:color-mix(in srgb,var(--destructive) 25%,transparent)}
/* Live screen: a small head line (title, hint, fit / actual size, open), then the viewer filling what is left. */
.screen-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;min-height:34px}
.screen-head h2{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.screen-head h2 svg{color:var(--muted-foreground)}
.screen-hint{margin:0;font-size:12px;color:var(--muted-foreground);flex:1 1 200px;min-width:0}
.screen-head .row{flex:none;margin-left:auto}
/* Fit / actual size: a two-button group; the pressed one is the current size. */
.seg{display:inline-flex;flex:none}
.seg>button{border-radius:0}.seg>button:first-child{border-radius:var(--radius-sm) 0 0 var(--radius-sm)}.seg>button:last-child{border-radius:0 var(--radius-sm) var(--radius-sm) 0;margin-left:-1px}
.seg>button[aria-pressed="true"]{border-color:var(--primary);background:var(--surface-active);color:var(--primary-text);position:relative;z-index:1}
@media (max-width:480px){.screen-head .row{margin-left:0;flex:1 1 100%}.screen-head .seg{margin-left:auto}}
#screenBox{flex:1 1 auto;min-height:240px;border-radius:var(--radius-md);overflow:hidden;border:1px solid var(--border);background:#000;box-shadow:var(--shadow-sm)}
#screen{display:block;width:100%;height:100%;border:0;background:#000}
#screenEmpty{flex:1 1 auto;min-height:160px;display:flex;align-items:center;justify-content:center}
/* Folds: Activity and Advanced are buttons in the screen's head line; their panels open under the screen, closed by default. */
button.fold{height:30px;padding:0 10px;font-size:12px;color:var(--muted-foreground);border-color:transparent;background:transparent}
button.fold:hover{background:var(--surface-hover);color:var(--foreground);border-color:transparent}
button.fold[aria-expanded="true"]{background:var(--surface-active);color:var(--primary-text)}
button.fold::after{content:"";width:5px;height:5px;margin:0 1px 2px 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform .15s var(--ease)}
button.fold[aria-expanded="true"]::after{transform:rotate(-135deg);margin-bottom:-2px}
.fold-panel h2{margin:0 0 10px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.fold-panel h2 svg{color:var(--muted-foreground)}
#events{max-height:320px;overflow:auto;display:flex;flex-direction:column}
#events:empty::before{content:attr(data-empty);display:block;padding:14px 4px;font-size:12px;color:var(--muted-foreground);text-align:center}
#events div{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:10px;align-items:baseline;font-size:12px;padding:7px 4px;border-bottom:1px solid var(--border-soft)}
#events div:last-child{border-bottom:0}
#events .t{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);min-width:28px}#events .k{font-weight:600}
#events .d{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:11.5px;line-height:1.5;background:var(--canvas);border:1px solid var(--border-soft);color:var(--foreground);padding:10px 12px;border-radius:var(--radius-sm);max-height:240px;overflow:auto}
pre.muted{color:var(--muted-foreground)}
summary::-webkit-details-marker{display:none}
.menu-panel .head{margin-bottom:8px}
.menu-panel h2{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.menu-panel h2 svg{color:var(--muted-foreground)}
@media (prefers-reduced-motion:reduce){*,::before,::after{transition:none!important;animation:none!important}}
</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></symbol>
<symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></symbol>
<symbol id="i-hand" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></symbol>
<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>
<symbol id="i-activity" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-inbox" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></symbol>
</defs></svg>
<header><h1><span class="brand-mark"><svg aria-hidden="true"><use href="#i-globe"/></svg></span><span class="brand-text"><span data-t="title">Agent Browser</span><span class="brand-sub" data-t="subtitle">Runtime console</span></span></h1>
<details class="menu" id="taskMenu"><summary id="taskMenuButton" aria-expanded="false"><svg aria-hidden="true"><use href="#i-list"/></svg><span id="taskMenuLabel" data-t="pickTask">Pick a task</span><span id="needCount" class="badge" hidden></span></summary>
<div class="menu-panel"><div class="head"><h2><svg aria-hidden="true"><use href="#i-list"/></svg><span data-t="tasks">Tasks</span></h2>
<button id="refreshTasks" class="icon" type="button" data-tt="refresh" title="Refresh"><svg aria-hidden="true"><use href="#i-refresh"/></svg></button></div>
<div id="tasks" class="muted">not connected</div></div></details>
<span class="spacer"></span>
<span id="capState" class="pill"><i></i><span>not connected</span></span></header>
<main>
<div class="card notice" id="notice" role="alert" hidden><svg aria-hidden="true"><use href="#i-shield"/></svg><span id="noticeText"></span><button id="noticeRetry" type="button" data-t="retry">Retry</button></div>
<section class="card" id="placeholder"><div class="empty"><svg aria-hidden="true"><use href="#i-inbox"/></svg><b data-t="pickTitle">Pick a task</b><span data-t="pickBody">Tasks that need you are in the task menu above.</span></div></section>
<div id="detail" hidden>
<section class="card" id="approvalBox" hidden><h2><svg aria-hidden="true"><use href="#i-shield"/></svg><span data-t="approvalTitle">Approval required</span></h2>
<div id="approval"></div>
<div class="row"><button id="approve" class="primary" type="button" data-t="approve">Approve</button><button id="reject" type="button" data-t="reject">Reject</button></div></section>
<section class="card bar"><div class="title"><span class="tile" id="detailTile"><svg aria-hidden="true"><use id="detailIcon" href="#i-globe"/></svg></span>
<div class="title-text"><h2 id="detailTitle"></h2><p id="detailReason" class="reason"></p><p class="mono muted" id="detailId"></p></div></div>
<div class="row"><button id="takeOver" class="primary" type="button" data-t="takeOver">Take over</button><button id="release" type="button" data-t="release">Release</button>
<button id="resume" type="button" data-t="resume">Resume</button><button id="stop" class="danger" type="button" data-t="stop">Stop</button></div>
<div id="actionResult"></div></section>
</div>
<div class="screen-head"><h2><svg aria-hidden="true"><use href="#i-monitor"/></svg><span data-t="screen">Screen</span></h2>
<p class="screen-hint" data-t="screenHint">input reaches the page only while you hold take over</p>
<div class="row"><button id="eventsToggle" class="fold" type="button" aria-expanded="false" aria-controls="eventsPanel" data-t="events">Activity</button><button id="advancedToggle" class="fold" type="button" aria-expanded="false" aria-controls="advanced" data-t="advanced">Advanced</button>
<span class="seg" id="viewGroup" role="group" aria-label="Screen size"><button id="fitToggle" type="button" aria-pressed="true" data-t="fit">Fit to screen</button><button id="actualSize" type="button" aria-pressed="false" data-t="actual">Actual size</button></span>
<button id="openScreen" type="button" data-t="openScreen">Open screen</button></div></div>
<div id="screenBox" hidden><iframe id="screen" title="Browser screen" referrerpolicy="no-referrer"></iframe></div>
<section class="card" id="screenEmpty"><div class="empty"><svg aria-hidden="true"><use href="#i-monitor"/></svg><b data-t="screenEmptyTitle">The screen is not open</b><span data-t="screenEmptyBody">Open screen shows the agent's browser here. Take over to use the page yourself (login, verification); release it and the agent continues.</span></div></section>
<section class="card fold-panel" id="eventsPanel" hidden><h2><svg aria-hidden="true"><use href="#i-activity"/></svg><span data-t="events">Activity</span></h2><div id="events"></div></section>
<section class="card fold-panel" id="advanced" hidden><h2><svg aria-hidden="true"><use href="#i-settings"/></svg><span data-t="advanced">Advanced</span></h2>
<label><span data-t="taskId">Task id</span><input id="taskId" autocomplete="off"></label>
<label><span data-t="tabId">Tab id (for take over / release)</span><input id="tabId" autocomplete="off"></label>
<div class="row"><button id="connect" type="button" data-t="watch">Watch task</button><span id="conn" class="muted small"></span></div>
<div id="manual" class="adv-block"><label><span data-t="paste">Paste a capability token</span><input id="token" type="password" autocomplete="off"></label>
<button id="useToken" type="button" data-t="useToken">Use token</button></div>
<div class="adv-block"><label data-t="rawTask">Task details</label><pre id="task" class="muted">not connected</pre></div>
</section>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var S={cursor:0,seen:{},task:null,tasks:[],pendingTasks:null,listSeq:0,gen:0,token:'',expiresAtMs:0,profileId:'',principalId:'',viewerSessionId:'',renewTimer:0,screenOpen:false,screenSeq:0,fit:true};
var RENEW_BEFORE_MS=60000,RENEW_RETRY_MS=10000,HOST_ORIGINS=${hostOrigins};
var Q=new URLSearchParams(location.search),THEME=Q.get('theme');
if(THEME==='dark'||THEME==='light')document.documentElement.setAttribute('data-theme',THEME);
var LANG=(Q.get('lang')||navigator.language||'en').toLowerCase().indexOf('ko')===0?'ko':'en';
var M={en:{title:'Agent Browser',subtitle:'Runtime console',tasks:'Tasks',refresh:'Refresh',advanced:'Advanced',taskId:'Task id',tabId:'Tab id (for take over / release)',watch:'Watch task',
 paste:'Paste a capability token',useToken:'Use token',rawTask:'Task details',pickTitle:'Pick a task',pickBody:'Tasks that need you are in the task menu above.',pickTask:'Pick a task',
 needCount:function(n){return n+(n>1?' tasks need you':' task needs you')},tasksFailed:'Could not load the tasks',retry:'Retry',viewMode:'Screen size',fit:'Fit to screen',actual:'Actual size',
 fitHint:'The whole screen, scaled to fit the frame',actualHint:'1:1 pixels. Without control the wheel pans the frame; with control it reaches the page (drag the scrollbars to pan)',
 screenEmptyTitle:'The screen is not open',screenEmptyBody:"Open screen shows the agent's browser here. Take over to use the page yourself (login, verification); release it and the agent continues.",
 approvalTitle:'Approval required',approve:'Approve',reject:'Reject',takeOver:'Take over',release:'Release',resume:'Resume',stop:'Stop',screen:'Screen',openScreen:'Open screen',
 screenHint:'input reaches the page only while you hold take over',events:'Activity',noEvents:'No activity yet',
 notConnected:'not connected',waitingHost:'Waiting for Saycode',connected:'Connected',until:'until',unreadable:'capability is not readable',loading:'loading',
 noTasksTitle:'Nothing needs you',noTasks:'no open tasks',others:function(n){return n+' other open task'+(n>1?'s':'')},live:'live',retrying:'retrying',
 needApproval:'Needs your approval',needLogin:'Login needed',needCaptcha:'Human verification needed',needHandoff:'Waiting for you',userControl:'You have control',
 running:'Running',paused:'Paused',awaitingUser:'Needs you',awaitingAgent:'Waiting for the agent',released:'Released',succeeded:'Finished',failed:'Failed',cancelled:'Cancelled',releaseNeeded:'Release control',
 rLogin:'Take over, sign in on the screen, then release.',rCaptcha:'Take over and complete the verification on the screen, then release.',
 rHandoff:'The agent handed the page to you. Take over to continue.',rApproval:'The agent wants to do something that needs your approval.',
 rControl:'Your input reaches the page. Release when you are done so the agent continues.',rRunning:'The agent is working on it.',
 rReleased:'Resume to hand the page back to the agent, or wait for it to continue.',rLeaseAfterEnd:'This task is over, but the input control is still with this console: release it so the agent can use the browser again.',
 origin:'Site',expires:'Expires',ok:'Done'},
 ko:{title:'에이전트 브라우저',subtitle:'런타임 콘솔',tasks:'작업',refresh:'새로고침',advanced:'고급',taskId:'작업 ID',tabId:'탭 ID (제어권 가져오기/반납용)',watch:'작업 보기',
 paste:'권한 토큰 붙여넣기',useToken:'토큰 사용',rawTask:'작업 상세',pickTitle:'작업을 고르세요',pickBody:'확인이 필요한 작업은 위 작업 메뉴에 나타나요.',pickTask:'작업 선택',
 needCount:function(n){return '확인 필요 '+n+'개'},tasksFailed:'작업 목록을 불러오지 못했어요',retry:'다시 시도',viewMode:'화면 크기',fit:'화면 맞춤',actual:'실제 크기',
 fitHint:'화면 전체가 보이도록 틀에 맞춰 축소해요',actualHint:'1:1 크기로 보여요. 제어권이 없을 때는 휠로 틀을 이동하고, 제어권을 가지면 휠이 페이지에 전달돼요(틀 이동은 스크롤바)',
 screenEmptyTitle:'화면이 아직 열리지 않았어요',screenEmptyBody:'화면 보기를 누르면 에이전트의 브라우저가 여기에 보여요. 로그인이나 사람 확인처럼 직접 해야 할 때 제어권을 가져오고, 반납하면 에이전트가 이어서 진행해요.',
 approvalTitle:'승인이 필요해요',approve:'승인',reject:'거절',takeOver:'제어권 가져오기',release:'제어권 반납',resume:'계속 진행',stop:'작업 중지',screen:'화면',openScreen:'화면 보기',
 screenHint:'제어권을 가진 동안에만 입력이 화면에 전달돼요.',events:'활동 기록',noEvents:'아직 활동이 없어요',
 notConnected:'연결 안 됨',waitingHost:'Saycode 연결 대기 중',connected:'연결됨',until:'까지',unreadable:'권한을 읽을 수 없어요',loading:'불러오는 중',
 noTasksTitle:'지금 확인할 작업이 없어요',noTasks:'열린 작업이 없어요',others:function(n){return '다른 작업 '+n+'개'},live:'실시간 연결됨',retrying:'다시 시도 중',
 needApproval:'승인 필요',needLogin:'로그인 필요',needCaptcha:'사람 확인 필요',needHandoff:'직접 조작 대기',userControl:'내가 제어 중',
 running:'진행 중',paused:'일시 정지',awaitingUser:'확인 필요',awaitingAgent:'에이전트 대기',released:'제어권 반납됨',succeeded:'완료됨',failed:'실패',cancelled:'취소됨',releaseNeeded:'제어권 반납 필요',
 rLogin:'제어권을 가져와 화면에서 로그인한 뒤 반납하세요.',rCaptcha:'제어권을 가져와 화면에서 확인을 마친 뒤 반납하세요.',
 rHandoff:'에이전트가 화면을 넘겼어요. 제어권을 가져와 이어서 진행하세요.',rApproval:'에이전트가 승인이 필요한 작업을 하려고 해요.',
 rControl:'입력이 화면에 전달되고 있어요. 다 하면 반납해야 에이전트가 이어서 진행해요.',rRunning:'에이전트가 작업하고 있어요.',
 rReleased:'계속 진행을 눌러 에이전트에게 넘기거나, 에이전트가 이어서 진행하기를 기다리세요.',rLeaseAfterEnd:'이 작업은 끝났지만 입력 제어권이 아직 이 콘솔에 있어요. 반납해야 에이전트가 브라우저를 다시 쓸 수 있어요.',
 origin:'사이트',expires:'만료',ok:'완료했어요'}};
var T=M[LANG];document.documentElement.lang=LANG;
document.querySelectorAll('[data-t]').forEach(function(el){var v=T[el.getAttribute('data-t')];if(typeof v==='string')el.textContent=v});
document.querySelectorAll('[data-tt]').forEach(function(el){var v=T[el.getAttribute('data-tt')];if(typeof v==='string'){el.title=v;el.setAttribute('aria-label',v)}});
document.title=T.title;$('events').setAttribute('data-empty',T.noEvents);
function capPill(text,cls){var p=$('capState');p.className='pill'+(cls?' '+cls:'');p.lastChild.textContent=text}
/* The task menu: a <details> whose summary is the button. Escape closes it back to the button; a click outside closes it; picking a task closes it. */
var menu=$('taskMenu'),menuBtn=$('taskMenuButton'),menuPanel=menu.querySelector('.menu-panel');
/** Under its button when there is room; slid left (never past 12px from the edge) in a narrow window. */
function placeMenu(){if(!menu.open)return;menuPanel.style.left='0px';var r=menuPanel.getBoundingClientRect(),over=r.right-(document.documentElement.clientWidth-12);
 if(over>0)menuPanel.style.left=(-Math.min(over,Math.max(0,r.left-12)))+'px'}
menu.addEventListener('toggle',function(){menuBtn.setAttribute('aria-expanded',menu.open?'true':'false');placeMenu()});
window.addEventListener('resize',placeMenu);
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&menu.open){menu.open=false;menuBtn.focus()}});
function closeMenu(){if(menu.open)menu.open=false}
document.addEventListener('pointerdown',function(e){if(menu.open&&!menu.contains(e.target))closeMenu()});
// A click on the screen lands in the viewer frame, where this document sees no pointer event: the frame's own
// document closes the menu too (same origin; armed on every load, so a reconnected frame keeps it), and the window
// losing focus to the frame (or to anything else) closes it as well.
window.addEventListener('blur',closeMenu);
$('screen').addEventListener('load',function(){try{var d=this.contentDocument;if(d)d.addEventListener('pointerdown',closeMenu,true)}catch(e){}applyControl()});
/** A list failure is shown in the notice line above the task, with a retry, not only inside the closed menu. */
function notice(text){var n=$('notice'),el=$('noticeText');if(el.textContent!==(text||''))el.textContent=text||'';n.hidden=!text}
$('noticeRetry').onclick=function(){listTasks()};
function menuLabel(){var t=S.task;$('taskMenuLabel').textContent=t?describe(t).label+' · '+t.taskId:T.pickTask;menuName()}
function needCount(n){var b=$('needCount');b.textContent=String(n);b.hidden=!n;b.title=n?T.needCount(n):'';menuName()}
/** The summary's accessible name: the label plus how many tasks need the user (a number alone says little). */
function menuName(){var n=Number($('needCount').textContent)||0;menuBtn.setAttribute('aria-label',$('taskMenuLabel').textContent+(n?', '+T.needCount(n):''))}
menuName();
capPill(T.notConnected);$('tasks').textContent=T.notConnected;$('task').textContent=T.notConnected;
function rid(){return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random())}
function decodePart(p){try{return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')))}catch(e){return null}}
function askHost(){clearTimeout(S.renewTimer);window.parent.postMessage({type:'abp-capability-request'},location.origin);
 if(window.opener)HOST_ORIGINS.forEach(function(o){try{window.opener.postMessage({type:'abp-capability-request'},o)}catch(e){}});
 if(!S.token)capPill(T.waitingHost);
 S.renewTimer=setTimeout(askHost,RENEW_RETRY_MS)}
function fromHost(event){return (event.source===window.parent&&event.origin===location.origin)
 ||(!!window.opener&&event.source===window.opener&&HOST_ORIGINS.indexOf(event.origin)>=0)}
function hhmm(ms){var d=new Date(ms);return isFinite(d.getTime())?d.toLocaleTimeString(LANG==='ko'?'ko-KR':'en-US',{hour:'2-digit',minute:'2-digit'}):''}
function setCapability(token,expiresAtMs){var renewal=!!S.token;
 var parts=String(token||'').split('.');var payload=parts.length>=3?decodePart(parts[parts.length===4?2:1]):null;
 if(!payload||typeof payload.profileId!=='string'){capPill(T.unreadable,'bad');return false}
 S.token=token;S.profileId=payload.profileId;S.expiresAtMs=Number(expiresAtMs)||Number(payload.expiresAtMs)||0;
 // Who this console is, for the lease check: the Runtime binds a takeover to (principal, viewer session).
 S.principalId=typeof payload.principalId==='string'?payload.principalId:'';S.viewerSessionId=typeof payload.viewerSessionId==='string'?payload.viewerSessionId:'';
 capPill(T.connected+(S.expiresAtMs?' · '+(LANG==='ko'?hhmm(S.expiresAtMs)+' '+T.until:T.until+' '+hhmm(S.expiresAtMs)):''),'on');
 $('capState').title='profile '+S.profileId;
 scheduleRenewal();if(renewal&&S.screenOpen)openScreen();return true}
function scheduleRenewal(){clearTimeout(S.renewTimer);if(!S.expiresAtMs)return;
 var wait=Math.max(0,S.expiresAtMs-RENEW_BEFORE_MS-Date.now());
 S.renewTimer=setTimeout(askHost,wait)}
window.addEventListener('message',function(event){
 if(!fromHost(event))return;
 var d=event.data;if(!d||d.type!=='abp-capability'||typeof d.token!=='string'||typeof d.expiresAtMs!=='number')return;
 // The first capability lists the tasks; a renewal lists them again only when the last attempt failed (the alert is up).
 var first=!S.token;if(setCapability(d.token,d.expiresAtMs)&&(first||!$('notice').hidden))listTasks()});
/** The fragment is read on load and again on a later change (the host reopens the same page with a new capability). */
function readFragment(){var h=location.hash.replace(/^#/,'');if(!h)return false;var q=new URLSearchParams(h);
 var token=q.get('abp-cap'),used=!!token&&token!==S.token&&setCapability(token,Number(q.get('abp-exp')));
 history.replaceState(null,'',location.pathname+location.search);return used}
readFragment();
window.addEventListener('hashchange',function(){if(readFragment())listTasks()});
function op(name,body){return fetch('/v1/ops/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+S.token},body:JSON.stringify(body)})
 .then(function(r){return r.json()}).then(function(j){if(!j.ok){var e=new Error(j.error.code+': '+j.error.message);e.body=j.error;throw e}return j.result})}
/**
 * What the task is waiting for, in the user's words, how loud to show it and which icon stands for it.
 * The Runtime keeps waitReason after the wait ends (released, expired), so it counts only while the
 * user is still awaited: the same rule as waitsForUser.
 */
function describe(t){
 // A finished task keeps its last pause/wait reason on the view: the end comes first. A lease of ours that outlived
 // it is the one thing left to do on it, and the loud one: it fences the profile for the agent until given back.
 if(finished(t)&&ownLease(t))return {label:T.releaseNeeded,tone:'warn',reason:T.rLeaseAfterEnd,icon:'i-hand'};
 if(finished(t))return {label:T[t.status],tone:t.status==='succeeded'?'ok':'',reason:'',icon:'i-globe'};
 if(t.pendingApproval&&!t.cancelRequested)return {label:T.needApproval,tone:'warn',reason:T.rApproval,icon:'i-shield'};
 if(t.pauseReason==='user-control')return {label:T.userControl,tone:'ok',reason:T.rControl,icon:'i-hand'};
 if(t.pauseReason==='user-input-complete')return {label:T.released,tone:'ok',reason:T.rReleased,icon:'i-hand'};
 var waiting=t.status==='awaiting-user'||t.pauseReason==='grant-expired';
 if(waiting&&t.waitReason==='login')return {label:T.needLogin,tone:'warn',reason:T.rLogin,icon:'i-hand'};
 if(waiting&&t.waitReason==='captcha')return {label:T.needCaptcha,tone:'warn',reason:T.rCaptcha,icon:'i-hand'};
 if(waiting&&t.waitReason==='handoff')return {label:T.needHandoff,tone:'warn',reason:T.rHandoff,icon:'i-hand'};
 if(t.status==='awaiting-user')return {label:T.awaitingUser,tone:'warn',reason:'',icon:'i-hand'};
 if(t.status==='running')return {label:T.running,tone:'run',reason:T.rRunning,icon:'i-activity'};
 if(t.pauseReason==='awaiting-agent')return {label:T.awaitingAgent,tone:'',reason:'',icon:'i-activity'};
 if(t.status==='paused')return {label:T.paused,tone:'',reason:'',icon:'i-globe'};
 return {label:t.status||'',tone:'',reason:'',icon:'i-globe'}}
/** The Runtime's terminal statuses: listTasks leaves them out, so the menu does too. */
function finished(t){return t.status==='succeeded'||t.status==='failed'||t.status==='cancelled'}
function chip(el,d){el.className='chip'+(d.tone?' '+d.tone:'');el.textContent=d.label}
function showTask(t){S.task=t;$('task').textContent=JSON.stringify({status:t.status,pauseReason:t.pauseReason,waitReason:t.waitReason,stateVersion:t.stateVersion,tabs:t.tabs,cancelRequested:t.cancelRequested,uncertainActions:t.uncertainActions},null,2);
 // The tab the controls name must be this task's: coming back from another task (or a typed id) must not send
 // the other task's tab (SCOPE_DENIED) — an empty or foreign id falls back to the task's first tab.
 if(t.tabs&&t.tabs.length&&t.tabs.indexOf($('tabId').value.trim())<0)$('tabId').value=t.tabs[0];
 var d=describe(t);$('placeholder').hidden=true;$('detail').hidden=false;
 $('detailTitle').textContent=d.label||t.taskId; $('detailReason').textContent=d.reason;$('detailReason').hidden=!d.reason;$('detailId').textContent=t.taskId;
 $('detailTile').className='tile'+(d.tone?' '+d.tone:'');$('detailIcon').setAttribute('href','#'+d.icon);menuLabel();
 // The control a user is most likely to need next is the loud one.
 var done=finished(t),mine=ownLease(t),released=!done&&t.pauseReason==='user-input-complete';
 $('takeOver').className=done||mine||released?'':'primary';$('release').className=mine?'primary':'';$('resume').className=released?'primary':'';
 // A finished task takes no control, resume or stop (the Runtime answers CONFLICT); a lease of ours that outlived it
 // is still given back here, since it keeps the profile fenced for the agent until then.
 ['takeOver','resume','stop'].forEach(function(id){$(id).disabled=done});$('release').disabled=done&&!mine;
 syncTask(t);markSelected(t.taskId);applyControl();
 // An approval left on a stopped task is nothing to decide (the Runtime answers CONFLICT): the card goes with the task.
 var a=!done&&t.pendingApproval;$('approvalBox').hidden=!a;if(a)renderApproval(a)}
/**
 * Whether this user holds the shown task's control decides what the viewer does with the wheel and the keys: without
 * control noVNC is view-only, so a wheel over an actual-size screen pans the frame (and keys are not grabbed); with
 * control they reach the page. The server's lease decides what is actually accepted; this only keeps the viewer honest.
 */
function applyControl(){var mine=holding();window.__abpViewerControl=mine;
 try{var w=$('screen').contentWindow;if(w&&w.__abpRfb)w.__abpRfb.viewOnly=!mine}catch(e){}}
function renderApproval(a){var box=$('approval');box.textContent='';var d=document.createElement('div');d.className='desc';d.textContent=a.description;
 var m=document.createElement('div');m.className='meta';var o=document.createElement('span');o.textContent=T.origin+' · '+a.origin;
 var x=document.createElement('span');x.textContent=T.expires+' · '+hhmm(a.expiresAtMs);m.appendChild(o);m.appendChild(x);box.appendChild(d);box.appendChild(m)}
function markSelected(id){Array.prototype.forEach.call(document.querySelectorAll('#tasks button'),function(b){b.classList.toggle('sel',b.getAttribute('data-task')===id)})}
function emptyState(box,title,body){box.textContent='';var e=document.createElement('div');e.className='empty';
 e.innerHTML='<svg aria-hidden="true"><use href="#i-inbox"/></svg>';var b=document.createElement('b');b.textContent=title;var s=document.createElement('span');s.textContent=body;
 e.appendChild(b);e.appendChild(s);box.appendChild(e)}
/** A task card. Its text starts with the task id (the tests read it that way); the grid shows the status above it. */
function taskButton(t){var b=document.createElement('button');b.type='button';b.setAttribute('data-task',t.taskId);fillTaskButton(b,t);return b}
/** The card's content; a card that is reused across renders (focus, scroll) gets its state redrawn in place. */
function fillTaskButton(b,t){var d=describe(t);b.textContent='';
 var dot=document.createElement('i');dot.className='dot'+(d.tone?' '+d.tone:'');dot.setAttribute('aria-hidden','true');
 var id=document.createElement('span');id.className='tid';id.textContent=t.taskId;
 var what=document.createElement('span');what.className='what';var c=document.createElement('span');chip(c,d);
 var when=document.createElement('span');when.className='when';when.textContent=hhmm(t.updatedAtMs);
 what.appendChild(c);what.appendChild(document.createTextNode(' '));what.appendChild(when);
 b.appendChild(dot);b.appendChild(id);b.appendChild(document.createTextNode(' '));b.appendChild(what);
 b.onclick=function(){if(menu.open){menu.open=false;menuBtn.focus()}$('taskId').value=t.taskId;$('tabId').value=(t.tabs&&t.tabs[0])||'';watch()}}
/**
 * quiet: a background refresh keeps the list on screen instead of showing "loading", and a failure touches only the
 * notice line, never the cards. Only the latest request's answer counts: an older one still in flight is dropped.
 */
function listTasks(quiet){if(!S.token)return;quiet=quiet===true;var seq=++S.listSeq;if(!quiet){$('tasks').className='muted';$('tasks').textContent=T.loading}
 op('listTasks',{profileId:S.profileId}).then(function(r){if(seq!==S.listSeq)return;notice('');applyTasks(r.tasks,quiet)},
  function(e){if(seq!==S.listSeq)return;if(!quiet){$('tasks').textContent=e.message;$('tasks').className='warn-text small'}notice(T.tasksFailed+' · '+e.message)})}
/**
 * A list answer reaches the cards and the badge. The shown task is subscribed and so may be fresher than the list that
 * was answered a moment ago: its own state wins unless the list carries a newer version. A quiet answer landing while
 * the menu is open waits for it to close — the cards under the user's keyboard or pointer stay put.
 */
function applyTasks(tasks,quiet){var shown=S.task;
 if(shown)tasks=tasks.map(function(t){return t.taskId===shown.taskId&&(Number(shown.stateVersion)||0)>=(Number(t.stateVersion)||0)?shown:t});
 tasks=tasks.filter(function(t){return !finished(t)||ownLease(t)});
 // The Runtime lists open tasks only: a finished one whose lease is still ours is carried over from what we know,
 // ahead of the rest (nothing of the agent's moves until it is given back).
 [shown].concat(S.tasks).forEach(function(k){if(k&&finished(k)&&ownLease(k)&&!tasks.some(function(t){return t.taskId===k.taskId}))tasks.unshift(k)});
 if(quiet&&menu.open){S.pendingTasks=tasks;return}
 S.pendingTasks=null;S.tasks=tasks;var first=renderTasks();applyControl();
 // Opened to deal with something (or the shown task is over, holds nothing of ours and no other pick is under way):
 // show the first task that needs the user. A finished task whose lease is still ours stays until it is given back.
 var typed=$('taskId').value.trim();
 if(first&&(S.task?finished(S.task)&&!ownLease(S.task)&&(!typed||typed===S.task.taskId):!typed)){$('taskId').value=first.taskId;$('tabId').value=(first.tabs&&first.tabs[0])||'';watch()}}
menu.addEventListener('toggle',function(){if(!menu.open&&S.pendingTasks)applyTasks(S.pendingTasks,false)});
/**
 * The menu's list and the badge, from S.tasks. Returns the first task that needs the user. Cards are reused by task id
 * and redrawn in place, the "other tasks" fold keeps its open state and the focused card stays focused: a render in the
 * middle of a keyboard pick (an event on the shown task, a background refresh) must not throw the user out of the menu.
 */
function renderTasks(){var box=$('tasks'),old={},others=box.querySelector(':scope>details'),focused=document.activeElement&&document.activeElement.getAttribute?document.activeElement.getAttribute('data-task'):null;
 Array.prototype.forEach.call(box.querySelectorAll('button[data-task]'),function(b){old[b.getAttribute('data-task')]=b});
 Array.prototype.forEach.call(Array.prototype.slice.call(box.childNodes),function(c){if(c.tagName!=='BUTTON'&&c!==others)c.remove()});
 box.className='';
 if(!S.tasks.length){box.textContent='';emptyState(box,T.noTasksTitle,T.noTasks);needCount(0);return null}
 if(!others){others=document.createElement('details');others.appendChild(document.createElement('summary'))}
 var open=others.open,summary=others.firstChild,folded=0,first=null,need=0;
 // Tasks waiting for the user come first; the others (running, parked for the agent) are folded away.
 S.tasks.forEach(function(t){var b=old[t.taskId];if(b){fillTaskButton(b,t);delete old[t.taskId]}else b=taskButton(t);
  if(waitsForUser(t)){box.insertBefore(b,others.parentNode===box?others:null);need++;if(!first)first=t}else{others.appendChild(b);folded++}});
 Object.keys(old).forEach(function(id){old[id].remove()});
 needCount(need);
 if(folded){summary.textContent=T.others(folded);if(others.parentNode!==box)box.appendChild(others);others.open=open}else others.remove();
 if(focused){var again=box.querySelector('button[data-task="'+focused+'"]');
  // A card that moved into the closed fold is unfocusable there: open the fold so the user's place is kept.
  if(again&&again.parentNode===others&&!others.open)others.open=true;if(again&&document.activeElement!==again)again.focus()}
 if(S.task)markSelected(S.task.taskId);return first}
// Only the shown task is subscribed: the other tasks (and new ones) reach the list and the badge through a periodic
// refresh while the page is visible, and one more when it becomes visible again. Not while the menu is open — a
// refresh under the user's pointer could move the card they are about to pick.
var LIST_REFRESH_MS=15000;
setInterval(function(){if(S.token&&!menu.open&&document.visibilityState!=='hidden')listTasks(true)},LIST_REFRESH_MS);
document.addEventListener('visibilitychange',function(){if(S.token&&!menu.open&&document.visibilityState==='visible')listTasks(true)});
/** A task's new state (an action's answer, a subscription refresh) reaches the list and the badge, not only the bar. */
function syncTask(t){var i=-1;for(var k=0;k<S.tasks.length;k++)if(S.tasks[k].taskId===t.taskId)i=k;
 var old=i>=0?S.tasks[i]:null;
 // A finished task leaves the list — unless a lease of ours outlived it: then it stays, loud, until given back, so the
 // user can get back to it from any other task (its own tab is the only one the release can name).
 if(finished(t)&&!ownLease(t)){if(i>=0){S.tasks.splice(i,1);renderTasks()}return}
 if(i>=0)S.tasks[i]=t;else S.tasks.push(t);
 if(!old||waitsForUser(old)!==waitsForUser(t)||describe(old).label!==describe(t).label)renderTasks()}
/**
 * Whether THIS console holds the shown task's control: a tab lease owned by this capability's principal and viewer
 * session (the Runtime binds a takeover to both; another console of the same user is a different viewer session and
 * its lease is not ours). A view without lease detail falls back to the task's pause reason.
 */
function holding(){var t=S.task;if(!t)return false;
 // The Runtime admits input while every user lease of the profile is this viewer's: a lease of ours on another task of
 // the profile (opened to look at it) counts too, and so does one on a finished task — it fences the profile until given back.
 if(ownLease(t))return true;for(var k=0;k<S.tasks.length;k++)if(S.tasks[k].taskId!==t.taskId&&ownLease(S.tasks[k]))return true;return false}
function ownLease(t){var leases=t.tabLeases;
 // A lease outlives the task's end (stopping a task reclaims only the agent's leases): an own lease on a finished
 // task is still ours to give back, so it is not read from the pause reason alone.
 if(!leases||!leases.length)return !finished(t)&&t.pauseReason==='user-control';
 for(var i=0;i<leases.length;i++){var o=leases[i].owner;if(o&&o.kind==='user'&&(!S.viewerSessionId||o.viewerSessionId===S.viewerSessionId)&&(!S.principalId||o.principalId===S.principalId))return true}
 return false}
/** Same rule as the Runtime's sessionWaiting: the user's move now (a stale approval on a task being cancelled is not). */
function waitsForUser(t){if(finished(t))return ownLease(t);if(t.cancelRequested)return false;return !!t.pendingApproval||t.status==='awaiting-user'||t.pauseReason==='user-control'
 ||(t.pauseReason==='grant-expired'&&(t.waitReason==='login'||t.waitReason==='captcha'||t.waitReason==='handoff'))}
/** The Runtime checks the selected tab's own lease epoch, not a global maximum. */
function tabEpoch(){var tab=$('tabId').value.trim();var leases=(S.task&&S.task.tabLeases)||[];for(var i=0;i<leases.length;i++)if(leases[i].tabId===tab)return leases[i].leaseEpoch;return 0}
function addEvent(e){if(S.seen[e.seq])return;S.seen[e.seq]=1;if(e.seq>S.cursor)S.cursor=e.seq;
 var line=document.createElement('div');var t=document.createElement('span');t.className='t';t.textContent='#'+e.seq;
 var k=document.createElement('span');k.className='k';k.textContent=e.type;var d=document.createElement('span');d.className='d';
 var data=JSON.stringify(e.data);d.textContent=data;d.title=data;line.appendChild(t);line.appendChild(k);line.appendChild(d);$('events').prepend(line)}
/** A late answer for a task the user has since left (an automatic pick racing a manual one) is dropped. */
function refresh(){return op('getTask',{taskId:$('taskId').value.trim()}).then(function(t){if(t&&t.taskId===$('taskId').value.trim())showTask(t)})}
function loop(gen){if(gen!==S.gen)return;
 op('subscribe',{taskId:$('taskId').value.trim(),afterSeq:S.cursor,waitMs:25000}).then(function(r){
  if(gen!==S.gen)return;$('conn').textContent=T.live;
  if(r.kind==='snapshot-required'){S.cursor=r.highWatermarkSeq;S.seen={};showTask(r.snapshot)}
  else if(r.events.length){r.events.forEach(addEvent);return refresh()}
 }).then(function(){loop(gen)},function(e){$('conn').textContent=e.message+' ('+T.retrying+')';setTimeout(function(){loop(gen)},2000)})}
function watch(){S.cursor=0;S.seen={};$('events').textContent='';var gen=++S.gen;refresh().then(function(){loop(gen)},function(e){$('conn').textContent=e.message})}
$('useToken').onclick=function(){if(setCapability($('token').value.trim()))listTasks();$('token').value=''};
$('refreshTasks').onclick=listTasks;$('connect').onclick=watch;
function act(p){var out=$('actionResult');out.className='';out.textContent='…';
 p.then(function(r){var v=r.status||r.outcome||r.owner;out.className='ok';out.textContent=typeof v==='string'?T.ok+' · '+v:T.ok;if(r.task)showTask(r.task);return refresh()})
 // Giving back the lease of a finished task leaves nothing to do on it: the list says where to go next, now.
 .then(function(){if(S.task&&finished(S.task)&&!ownLease(S.task))listTasks(true)})
 .catch(function(e){out.className='err';out.textContent=e.message;if(e.body&&e.body.code==='STALE_LEASE')refresh()})}
function decide(d){var a=S.task&&S.task.pendingApproval;if(!a)return;act(op('approve',{taskId:S.task.taskId,approvalId:a.approvalId,bindingHash:a.bindingHash,requestId:rid(),decision:d}))}
$('approve').onclick=function(){decide('approve')};$('reject').onclick=function(){decide('reject')};
$('takeOver').onclick=function(){act(op('takeOver',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:tabEpoch(),requestId:rid()}))};
$('release').onclick=function(){act(op('releaseControl',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:tabEpoch(),requestId:rid()}))};
$('resume').onclick=function(){if(S.task)act(op('resume',{taskId:S.task.taskId,expectedVersion:S.task.stateVersion,requestId:rid()}))};
$('stop').onclick=function(){act(op('cancel',{taskId:$('taskId').value.trim(),requestId:rid()}))};
/** A viewer connection is bound to the capability it was ticketed with: renewal reconnects it. */
/** The screen counts as open from the click, so a renewal during the first ticket request reopens it; only the latest reply is shown. */
function openScreen(){S.screenOpen=true;var n=++S.screenSeq;op('viewerTicket',{profileId:S.profileId}).then(function(r){if(n!==S.screenSeq)return;
 var path='v1/viewer/websockify?ticket='+encodeURIComponent(r.ticket);window.__abpViewerPath=path;window.__abpViewerFit=S.fit;window.__abpViewerControl=holding();
 // scale=1 only as a fallback for a client without the Runtime's hook: the hook reads the choice from __abpViewerFit.
 $('screen').src='/viewer/vnc_lite.html?path='+encodeURIComponent(path)+(S.fit?'&scale=1':'');$('screenBox').hidden=false;$('screenEmpty').hidden=true
},function(e){if(n!==S.screenSeq)return;S.screenOpen=false;var out=$('actionResult');out.className='err';out.textContent=e.message})}
$('openScreen').onclick=openScreen;
/**
 * Fit (whole screen scaled into the frame, aspect kept) or actual size (1:1, scrolled): noVNC's scaleViewport on the open
 * frame's RFB object, in place. The choice is also left on this window for the next frame (renewal reconnect). Never
 * resizeSession: the remote display keeps its size whatever the frame is.
 */
function applyFit(){$('fitToggle').setAttribute('aria-pressed',S.fit?'true':'false');$('actualSize').setAttribute('aria-pressed',S.fit?'false':'true');window.__abpViewerFit=S.fit;
 try{var w=$('screen').contentWindow;if(w&&w.__abpRfb)w.__abpRfb.scaleViewport=S.fit}catch(e){}}
$('fitToggle').onclick=function(){S.fit=true;applyFit()};$('actualSize').onclick=function(){S.fit=false;applyFit()};
$('fitToggle').title=T.fitHint;$('actualSize').title=T.actualHint;$('viewGroup').setAttribute('aria-label',T.viewMode);
applyFit();
function fold(btn){btn.onclick=function(){var panel=$(btn.getAttribute('aria-controls'));panel.hidden=!panel.hidden;btn.setAttribute('aria-expanded',panel.hidden?'false':'true')}}
fold($('eventsToggle'));fold($('advancedToggle'));
// Reload, back navigation or a restored panel arrive without a fragment: ask the host now.
if(S.token)listTasks();else askHost();
})();
</script></body></html>`
}
