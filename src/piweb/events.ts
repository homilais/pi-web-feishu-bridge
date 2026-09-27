import type { PiWebClient } from './client.ts';
import type { AgentStateResponse, PiWebEvent } from './types.ts';
import { logger } from '../log.ts';

const log = logger('sse');

export interface SseHandlers {
  onEvent?: (ev: PiWebEvent) => void;
  onDisconnect?: (reason: 'error' | 'closed', err?: unknown) => void;
  onReconnect?: (attempt: number) => void;
  onResync?: (state: AgentStateResponse) => void;
}

export interface SseSubscription {
  close(): void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** 单次 SSE 连接：client.sse + 手动解析（因原生 EventSource 不支持自定义 Authorization 头）。 */
async function connectOnce(
  client: PiWebClient,
  agentId: string,
  handlers: SseHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await client.sse(agentId, signal);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        if (dataLines.length) {
          const raw = dataLines.join('\n');
          dataLines = [];
          try {
            handlers.onEvent?.(JSON.parse(raw) as PiWebEvent);
          } catch (e) {
            log.warn('无法解析 SSE data', { raw: raw.slice(0, 120), e: String(e) });
          }
        }
        continue;
      }
      if (line.startsWith(':')) continue; // keepalive / comment
      if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      else if (line.startsWith('data:')) dataLines.push(line.slice(5));
      // pi-web 不使用 event:/id: 行，忽略
    }
  }
  handlers.onDisconnect?.('closed');
}

/** 订阅 SSE，自动重连 + 重连后拉状态对齐。 */
export function subscribeEvents(
  client: PiWebClient,
  agentId: string,
  handlers: SseHandlers,
  externalSignal?: AbortSignal,
): SseSubscription {
  const ctrl = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  (async () => {
    let attempt = 0;
    while (!ctrl.signal.aborted) {
      try {
        await connectOnce(client, agentId, handlers, ctrl.signal);
        attempt = 0; // 正常关闭后也重连（除非已 abort）
        if (ctrl.signal.aborted) break;
      } catch (e) {
        if (ctrl.signal.aborted) break;
        handlers.onDisconnect?.('error', e);
        attempt++;
        const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 15000);
        log.warn(`连接断开，${delay}ms 后重连 (#${attempt})`, { e: String(e) });
        handlers.onReconnect?.(attempt);
        await sleep(delay, ctrl.signal);
        // 重连后拉状态对齐
        try {
          const st = await client.getState(agentId);
          handlers.onResync?.(st);
        } catch (e2) {
          log.warn('重连后状态对齐失败', { e: String(e2) });
        }
      }
    }
    log.info(`agent ${agentId} 订阅已停止`);
  })();
  return { close: () => ctrl.abort() };
}
