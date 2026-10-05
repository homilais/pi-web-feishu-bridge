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
    const modelRef = ctx.model ? `${ctx.model.provider ?? ''}/${ctx.model.id}`.replace(/^\//, '') : undefined;

    // 1. 注册会话
    try {
      await fetch(`${base}/terminal/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          cwd,
          label: cwd.split('/').filter(Boolean).pop(),
          model: modelRef,
          pid: process.pid,
          version: '0.1',
        }),
      });
    } catch (e) {
      noticeOnce(ctx);
      return;
    }

    // 2. 保持下行命令流（桥接经此下发 prompt/abort/...）
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
              };
              if (cmd.type === 'prompt' && cmd.text) {
                // followUp：排队，不插队当前轮（与 pi-web 后端一致）
                await pi.sendUserMessage(cmd.text, { deliverAs: 'followUp' });
              }
              // T5 再接 abort / setModel
            } catch {
              /* 忽略坏帧 */
            }
          }
        }
      } catch {
        /* 断开即断开，桥接侧会把该会话标为离线 */
      }
    })();

    // 3. 周期上报状态（仅状态，不含对话内容）
    const timer = setInterval(() => {
      void fetch(`${base}/terminal/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ sessionId, seq: 0, kind: 'heartbeat', busy: !ctx.isIdle() }]),
      }).catch(() => {});
    }, 5_000);

    pi.on('session_shutdown', () => {
      clearInterval(timer);
      controller.abort();
    });
  });
}