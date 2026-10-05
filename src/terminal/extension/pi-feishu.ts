// pi 扩展：把终端 pi 的会话注册到桥接，使其可被飞书发现与对话控制。
//
// 设计要点（见 specs/terminal-bot.md）：
//   - pi 没有入站端口，故由扩展主动外连
//   - 桥接不在场时**静默降级**：完全不介入，不打扰本地使用
//   - 终端上的人机对话**不上报**，仅上报状态（T2 只需要这点）
//   - 生命周期资源从 session_start 起，session_shutdown 幂等收尾
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 与桥接侧 protocol.ts 对应的常量（扩展随包分发，不跨包 import 以免路径耦合）
const DISCOVERY_DIR = '.pi-bridge';
const DISCOVERY_FILE = 'bridge.json';
const NOTICE = 'ℹ️ 未检测到 pi-bridge，飞书远程控制未启用（不影响本地使用）';

interface BridgeDiscovery {
  port: number;
  pid: number;
  version?: string;
}

/** 上行批次周期（spec 定为 200ms）。 */
const FLUSH_MS = 200;
/** 积压保护阈值。 */
const MAX_BACKLOG = 400;

/** 透传给桥接的 pi 事件（形状与桥接侧 TurnState 一致）。 */
type PiEvent = { type: string; [k: string]: unknown };

/** 合并相邻的增量文本 —— 追加语义，丢字即永久丢失，故只能拼不能丢。 */
function coalesce(events: PiEvent[]): PiEvent[] {
  const isDelta = (e: PiEvent): boolean =>
    e.type === 'message_update' &&
    (e.assistantMessageEvent as { type?: string } | undefined)?.type === 'text_delta';
  const out: PiEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (isDelta(ev) && prev && isDelta(prev)) {
      const a = prev.assistantMessageEvent as { type: string; delta: string; [k: string]: unknown };
      const b = ev.assistantMessageEvent as { type: string; delta: string };
      out[out.length - 1] = {
        ...prev,
        assistantMessageEvent: { ...a, delta: `${a.delta ?? ''}${b.delta ?? ''}` },
      };
      continue;
    }
    out.push(ev);
  }
  return out;
}

/** 把请求响应回传给桥接（pullState / setModel）。 */
function respond(base: string, sessionId: string, requestId: string, payload: Record<string, unknown>): void {
  void fetch(`${base}/terminal/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, requestId, ...payload }),
  }).catch(() => {});
}

/**
 * 双通道审批：终端弹窗与飞书卡片**同时**出现，先响应者胜，另一侧经 AbortSignal 撤销。
 *
 * 依赖 pi 的 `ExtensionUIDialogOptions.signal` —— 官方注释为
 * “AbortSignal to programmatically dismiss the dialog”，即弹窗可被程序化撤除。
 *
 * 仅在飞书发起的回合才对飞书开放（用户自己在终端发起的回合，飞书看不到也不可代批）。
 */
async function dualChannelConfirm(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  base: string,
  sessionId: string,
  title: string,
  message: string,
  remoteTurn: boolean,
): Promise<boolean> {
  const ac = new AbortController();
  const terminal = ctx.ui.confirm(title, message, { signal: ac.signal });

  if (!remoteTurn) {
    // 用户终端发起的回合：只在终端审批，飞书不参与
    return terminal;
  }

  const requestId = crypto.randomUUID();
  // 告知飞书有一笔待审批；桥接渲染审批卡
  void fetch(`${base}/terminal/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      seq: 0,
      events: [{ type: 'extension_ui_request', id: requestId, method: 'confirm', message }],
    }),
  }).catch(() => {});

  // 等飞书侧回一个 resolveApproval 命令（由下行流消费）
  const remote = waitForRemoteApproval(requestId);
  const winner = await Promise.race([
    terminal.then((ok) => ({ side: 'terminal' as const, ok })),
    remote.then((ok) => ({ side: 'feishu' as const, ok })),
  ]);
  // 先到者胜 → 撤掉另一侧
  if (winner.side === 'feishu') ac.abort();
  return winner.ok;
}

const remoteApprovals = new Map<string, (ok: boolean) => void>();
function waitForRemoteApproval(requestId: string): Promise<boolean> {
  return new Promise((resolve) => remoteApprovals.set(requestId, resolve));
}
/** 供下行命令处理器调用：飞书侧已给出审批结论。 */
export function resolveRemoteApproval(requestId: string, approved: boolean): void {
  const fn = remoteApprovals.get(requestId);
  if (fn) {
    remoteApprovals.delete(requestId);
    fn(approved);
  }
}

/** 桥接在不在？读发现文件 + 校验 pid 存活 + 端口可连。 */
async function probeBridge(): Promise<number | null> {
  try {
    const path = join(homedir(), DISCOVERY_DIR, DISCOVERY_FILE);
    const info = JSON.parse(readFileSync(path, 'utf8')) as BridgeDiscovery;
    if (!info?.port) return null;
    try {
      process.kill(info.pid, 0); // 信号 0 = 仅探活
    } catch {
      return null; // 桥接进程已不在
    }
    return info.port;
  } catch {
    return null;
  }
}

/** 提示只出一次，且可用环境变量静音。 */
let noticed = false;
function noticeOnce(ctx: ExtensionContext): void {
  if (noticed || process.env.PI_FEISHU_QUIET === '1') return;
  noticed = true;
  ctx.ui.notify?.(NOTICE, 'info');
}

export default function (pi: ExtensionAPI): void {
  // 不在 factory 里起 socket —— 某些调用加载扩展但不开会话
  pi.on('session_start', async (_ev, ctx) => {
    const port = await probeBridge();
    if (port === null) {
      noticeOnce(ctx);
      return;
    }
    const base = `http://127.0.0.1:${port}`;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    const currentModelRef = (): string | undefined =>
      ctx.model ? `${ctx.model.provider ?? ''}/${ctx.model.id}`.replace(/^\//, '') : undefined;

    // 1. 注册会话
    try {
      await fetch(`${base}/terminal/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          cwd,
          label: cwd.split('/').filter(Boolean).pop(),
          model: currentModelRef(),
          pid: process.pid,
          version: '0.1',
        }),
      });
    } catch (e) {
      noticeOnce(ctx);
      return;
    }

    // 2. 往返状态（先于 SSE 声明，供下行回调置位）
    let backlog: PiEvent[] = [];
    let seq = 0;
    let remoteTurn = false; // 是否在飞书发起的回合中（D2：只报飞书回合）
    const FORWARD_MAX = 400;

    // 3. 保持下行命令流（桥接经此下发 prompt/abort/...）
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${base}/terminal/stream?session=${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // 手写 SSE 分帧：按空行切分，只取 data 行
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try {
              const cmd = JSON.parse(line.slice(5).trim()) as {
                type: string;
                text?: string;
                provider?: string;
                modelId?: string;
                requestId?: string;
                approved?: boolean;
              };
              if (cmd.type === 'prompt' && cmd.text) {
                // followUp：排队，不插队当前轮（与 pi-web 后端一致）
                remoteTurn = true;
                await pi.sendUserMessage(cmd.text, { deliverAs: 'followUp' });
              } else if (cmd.type === 'abort') {
                // T5：中止 —— 飞书可中止任何回合（含用户在终端发起的）
                ctx.abort?.();
              } else if (cmd.type === 'setModel' && cmd.provider && cmd.modelId) {
                try {
                  await ctx.setModel?.(cmd.provider, cmd.modelId);
                  respond(base, sessionId, cmd.requestId, { ok: true });
                } catch (e) {
                  respond(base, sessionId, cmd.requestId, { ok: false, error: String(e).slice(0, 120) });
                }
              } else if (cmd.type === 'resolveApproval') {
                // T6：飞书侧已给出审批结论 → 参与竞速
                resolveRemoteApproval(cmd.requestId, cmd.approved);
              } else if (cmd.type === 'pullState') {
                // T5：/last 所需的真实会话历史 + 当前模型 + 空闲态
                const entries = ctx.sessionManager.getEntries();
                respond(base, sessionId, cmd.requestId, {
                  ok: true,
                  entries: entries as unknown[],
                  model: currentModelRef(),
                  idle: ctx.isIdle(),
                });
              }
            } catch {
              /* 忽略坏帧 */
            }
          }
        }
      } catch {
        /* 断开即断开，桥接侧会把该会话标为离线 */
      }
    })();

    // 4. 事件上行：缓冲 → 每 200ms 合并后 POST
    const FORWARD = new Set([
      'agent_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'agent_end',
      'agent_settled',
    ]);

    const flush = async (): Promise<void> => {
      if (!backlog.length) return;
      const batch = coalesce(backlog);
      backlog = [];
      await fetch(`${base}/terminal/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          seq: ++seq,
          events: batch,
          busy: !ctx.isIdle(),
        }),
      }).catch(() => {});
    };
    // 200ms 定时 flush；单发送者 + drain（on 上方 await），避免并发 POST
    let flushing = false;
    const timer = setInterval(() => {
      if (!backlog.length || flushing) return;
      flushing = true;
      void flush().finally(() => {
        flushing = false;
      });
    }, FLUSH_MS);

    // 注册事件转发
    const offEvent = pi.on('message_update' as never, ((ev: unknown) => {
      if (!FORWARD.has('message_update')) return;
      if (!remoteTurn) return; // 用户终端的回合不上报
      const e = ev as PiEvent;
      const ame = (e.assistantMessageEvent as { type?: string } | undefined)?.type;
      // thinking 噪声大且不进卡片文本，略过以省带宽
      if (ame === 'thinking_delta' || ame === 'thinking_start') return;
      backlog.push(e);
      if (backlog.length > FORWARD_MAX) backlog = backlog.slice(-FORWARD_MAX);
    }) as never);

    pi.on('tool_execution_start' as never, ((ev: unknown) => {
      if (!remoteTurn) return;
      backlog.push(ev as PiEvent);
    }) as never);
    pi.on('tool_execution_end' as never, ((ev: unknown) => {
      if (!remoteTurn) return;
      backlog.push(ev as PiEvent);
    }) as never);
    pi.on('agent_settled' as never, (() => {
      // 终态总是转发：否则卡片永不收尾
      backlog.push({ type: 'agent_settled' });
      remoteTurn = false;
    }) as never);

    pi.on('session_shutdown', () => {
      clearInterval(timer);
      offEvent?.();
      controller.abort();
    });

    // 4b. 工具执行审批闸门（可选）
    //
    // pi 本身**没有**内置的工具审批 —— `extension_ui_request` 只在扩展主动调
    // `ctx.ui.confirm` 时产生。所以要让终端回合出现审批，pi-feishu 必须自己充当
    // 那个「权限扩展」。这会改变用户本地 pi 的行为，故默认关闭，需显式开启：
    //   PI_FEISHU_GATE=1 pi
    if (process.env.PI_FEISHU_GATE === '1') {
      pi.on('tool_call', async (event, tctx) => {
        const hints = pi.getAllTools?.().find((t) => t.name === (event as { toolName?: string }).toolName)?.annotations;
        const needsApproval =
          hints?.destructiveHint === true ||
          (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
        if (!needsApproval) return;
        const ok = await dualChannelConfirm(pi, tctx, base, sessionId, '允许工具调用？', (event as { toolName?: string }).toolName ?? 'tool', remoteTurn);
        if (!ok) {
          return { block: true, reason: `${(event as { toolName?: string }).toolName ?? 'tool'} was not approved` };
        }
      });
    }
  });
}