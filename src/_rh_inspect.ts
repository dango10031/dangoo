// rh_vibe_coding Visual Edit runtime (dev only)
// 装在被预览的生成 app 里。和 vibe (parent window) 通过 postMessage 通信。
//
// 协议:
//   parent -> iframe : { type: 'rh-inspect-on' | 'rh-inspect-off' }
//   iframe -> parent : { type: 'rh-inspect-pick', src, tag, text, selector }
//                      { type: 'rh-inspect-off-ack' }
//                      { type: 'rh-inspect-ready' }
//                      { type: 'rh-runtime-error', kind, message, stack?, source?, line?, col?, src? }
//                        runtime 错误冒到 vibe chat 输入框上方的"错误胶囊"。
//                        来源: window.onerror / unhandledrejection / 包装后的 fetch (非 2xx + 网络失败)。
//
// 元素的源码位置来自 babel-plugin-rh-source 注入的 data-rh-src;
// 没装该插件时降级为 css selector + 文本.

type ParentMsg =
  | { type: 'rh-inspect-on' }
  | { type: 'rh-inspect-off' };

let armed = false;
let hover: HTMLElement | null = null;

const HOVER_OUTLINE = '2px solid #38bdf8';

function setHover(el: HTMLElement | null) {
  if (hover === el) return;
  if (hover) hover.style.outline = '';
  hover = el;
  if (hover) hover.style.outline = HOVER_OUTLINE;
}

function nthOfTypeIndex(el: Element): number {
  let i = 1;
  let p: Element | null = el.previousElementSibling;
  while (p) {
    if (p.tagName === el.tagName) i++;
    p = p.previousElementSibling;
  }
  return i;
}

function cssSelector(el: Element, max = 4): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.nodeType === 1 && depth < max) {
    const tag = cur.tagName.toLowerCase();
    const id = (cur as HTMLElement).id ? `#${(cur as HTMLElement).id}` : '';
    const cls =
      (cur as HTMLElement).className && typeof (cur as HTMLElement).className === 'string'
        ? '.' + (cur as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    const nth = id || cls ? '' : `:nth-of-type(${nthOfTypeIndex(cur)})`;
    parts.unshift(`${tag}${id}${cls}${nth}`);
    if (id) break;
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

function getSrc(el: HTMLElement): string | null {
  const node = el.closest('[data-rh-src]') as HTMLElement | null;
  return node?.getAttribute('data-rh-src') ?? null;
}

function onMove(e: MouseEvent) {
  if (!armed) return;
  const t = e.target;
  if (t instanceof HTMLElement) setHover(t);
}

function onClick(e: MouseEvent) {
  if (!armed) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const src = getSrc(t);
  const tag = t.tagName.toLowerCase();
  const text = (t.innerText || t.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const selector = cssSelector(t);
  parent.postMessage(
    { type: 'rh-inspect-pick', src, tag, text, selector },
    '*',
  );
  off();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && armed) off();
}

function on() {
  if (armed) return;
  armed = true;
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.body.style.cursor = 'crosshair';
}

function off() {
  if (!armed) return;
  armed = false;
  setHover(null);
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
  document.body.style.cursor = '';
  parent.postMessage({ type: 'rh-inspect-off-ack' }, '*');
}

window.addEventListener('message', (ev: MessageEvent<ParentMsg>) => {
  const d = ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'rh-inspect-on') on();
  else if (d.type === 'rh-inspect-off') off();
});

// ---- 运行时错误上报 -----------------------------------------------------
// 任何错误都冒到 vibe chat. 包含: 未捕获同步错误, 未处理 Promise rejection,
// fetch 非 2xx 响应, fetch 网络失败.

type RuntimeErrorPayload = {
  kind: 'error' | 'unhandledrejection';
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  col?: number;
  src?: string;
};

function reportRuntimeError(payload: RuntimeErrorPayload) {
  try {
    parent.postMessage({ type: 'rh-runtime-error', ...payload }, '*');
  } catch {
    // postMessage 失败就算了, 别再抛出形成死循环
  }
}

window.addEventListener('error', (ev) => {
  const err = ev.error;
  const message = ev.message || (err && (err as Error).message) || String(err || 'Unknown error');
  reportRuntimeError({
    kind: 'error',
    message,
    source: ev.filename || undefined,
    line: typeof ev.lineno === 'number' ? ev.lineno : undefined,
    col: typeof ev.colno === 'number' ? ev.colno : undefined,
    stack: err instanceof Error ? err.stack : undefined,
  });
});

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  reportRuntimeError({
    kind: 'unhandledrejection',
    message,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

const origFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
  let url = '';
  let method = 'GET';
  try {
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    method = (init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET') || 'GET').toUpperCase();
  } catch {
    // 拿不到 url/method 也别影响主流程
  }
  try {
    const resp = await origFetch(input as RequestInfo, init);
    if (!resp.ok) {
      reportRuntimeError({
        kind: 'error',
        message: `HTTP ${resp.status} ${method} ${url}`,
        src: url,
      });
    }
    return resp;
  } catch (e) {
    const err = e as Error & { name?: string };
    // 用户主动 abort 不算错
    if (err?.name !== 'AbortError') {
      reportRuntimeError({
        kind: 'error',
        message: `Fetch failed: ${method} ${url} - ${err?.message || String(e)}`,
        src: url,
        stack: err?.stack,
      });
    }
    throw e;
  }
};

parent.postMessage({ type: 'rh-inspect-ready' }, '*');
