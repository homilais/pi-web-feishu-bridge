// 单轮对话状态机：消费 SSE 事件 → 维护可渲染的「有序时间线」
import type { PiWebEvent } from '../piweb/types.ts';
import type { PendingApprovals } from './queue.ts';

export type ToolStatus = 'calling' | 'running' | 'done' | 'error';

/** 时间线片段：文字块或工具调用，按发生顺序排列。 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; status: ToolStatus };

export type TurnStatus = 'thinking' | 'running' | 'awaiting_approval' | 'done' | 'error';

export interface ApprovalCtx {
  requestId: string;
  method: string;
  message?: string;
}

export class TurnState {
  done = false;
  /** 有序时间线（文字/工具交错）。 */
  segments: Segment[] = [];
  status: TurnStatus = 'thinking';
  pendingApproval?: ApprovalCtx;
  error?: string;
  aborted = false;
  readonly turnId: string;
  readonly prompt: string;
  readonly startedAt: number;
  readonly deadline: number;

  constructor(turnId: string, prompt: string, startedAt?: number) {
    this.turnId = turnId;
    this.prompt = prompt;
    this.startedAt = startedAt ?? Date.now();
    this.deadline = this.startedAt + 10 * 60 * 1000; // 10 分钟安全上限
  }

  /** 用执行进展快照预填时间线（/last 挂接进行中的轮次时用，避免卡片初始空白）。 */
  seedProgress(p: { steps?: Array<{ toolName: string }>; currentText?: string }): void {
    if (p.currentText?.trim()) this.segments.push({ kind: 'text', text: p.currentText });
    for (const s of p.steps ?? []) {
      this.segments.push({ kind: 'tool', id: `seed-${this.segments.length}-${s.toolName}`, name: s.toolName, status: 'done' });
    }
    if (this.segments.length) this.status = 'running';
  }

  /** 全部文字片段拼接（兼容旧字段 / 完成通知用）。 */
  get text(): string {
    return this.segments
      .filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
      .map((s) => s.text)
      .join('');
  }

  /** 最后一段非空文字（通常是最终答复）。 */
  get lastText(): string {
    const texts = this.segments.filter(
      (s): s is { kind: 'text'; text: string } => s.kind === 'text' && s.text.trim().length > 0,
    );
    return texts.length ? texts[texts.length - 1].text : '';
  }

  /** 工具片段（兼容旧字段）。 */
  get tools(): { id: string; name: string; status: ToolStatus }[] {
    return this.segments.filter((s): s is { kind: 'tool'; id: string; name: string; status: ToolStatus } => s.kind === 'tool');
  }

  /** 用于增量更新判重。 */
  signature(): string {
    const seg = this.segments
      .map((s) => (s.kind === 'text' ? `t${s.text.length}` : `T${s.id}:${s.status}`))
      .join(',');
    return `${this.status}|${seg}|${this.pendingApproval?.requestId ?? ''}|${this.error ?? ''}`;
  }

  private lastTextSeg(): { kind: 'text'; text: string } | undefined {
    const last = this.segments[this.segments.length - 1];
    return last && last.kind === 'text' ? last : undefined;
  }

  private ensureTextSeg(): { kind: 'text'; text: string } {
    let s = this.lastTextSeg();
    if (!s) {
      s = { kind: 'text', text: '' };
      this.segments.push(s);
    }
    return s;
  }

  private findTool(id: string): { kind: 'tool'; id: string; name: string; status: ToolStatus } | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.kind === 'tool' && s.id === id) return s;
    }
    return undefined;
  }

  handleEvent(ev: PiWebEvent, pending: PendingApprovals): void {
    switch (ev.type) {
      case 'agent_start':
        this.status = 'running';
        break;
      case 'message_update': {
        const ae = (ev as {
          assistantMessageEvent: { type: string; delta?: string; id?: string; toolName?: string };
        }).assistantMessageEvent;
        if (ae.type === 'text_start') {
          // 新文字块开始：若上一段已是文字块且非空，则另起一段
          const last = this.lastTextSeg();
          if (last && last.text.length > 0) this.segments.push({ kind: 'text', text: '' });
          else if (!last) this.segments.push({ kind: 'text', text: '' });
        } else if (ae.type === 'text_delta' && ae.delta) {
          this.ensureTextSeg().text += ae.delta;
        } else if (ae.type === 'toolcall_start' && ae.id && ae.toolName) {
          if (!this.findTool(ae.id)) {
            this.segments.push({ kind: 'tool', id: ae.id, name: ae.toolName, status: 'calling' });
          }
        }
        break;
      }
      case 'message_end': {
        // 兜底：用完整消息文本校正最后一段文字（防止 delta 丢包）
        const m = (ev as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } }).message;
        if (m?.role === 'assistant' && Array.isArray(m.content)) {
          const full = m.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text as string)
            .join('');
          if (full.trim()) {
            const seg = this.lastTextSeg();
            if (seg && full.length >= seg.text.length) seg.text = full;
            else this.segments.push({ kind: 'text', text: full });
          }
        }
        break;
      }
      case 'tool_execution_start': {
        const e = ev as { id?: string; toolName?: string };
        if (e.id) {
          const t = this.findTool(e.id);
          if (t) t.status = 'running';
          else this.segments.push({ kind: 'tool', id: e.id, name: e.toolName ?? 'tool', status: 'running' });
        }
        break;
      }
      case 'tool_execution_end': {
        const e = ev as { id?: string; error?: unknown };
        if (e.id) {
          const t = this.findTool(e.id);
          if (t) t.status = e.error ? 'error' : 'done';
        }
        break;
      }
      case 'extension_ui_request': {
        const r = ev as { id: string; method: string; message?: string };
        this.pendingApproval = { requestId: r.id, method: r.method, message: r.message };
        this.status = 'awaiting_approval';
        new Promise<{ approved: boolean; payload: Record<string, unknown> }>((resolve) => {
          pending.register(r.id, resolve);
        }).then(({ approved }) => {
          this.pendingApproval = undefined;
          this.status = approved ? 'running' : 'done';
          if (!approved) {
            this.aborted = true;
            this.done = true;
          }
        });
        break;
      }
      case 'agent_settled':
        if (!this.done) {
          this.status = this.error ? 'error' : 'done';
          this.done = true;
        }
        break;
      case 'startup_error':
      case 'agent_error': {
        const e = ev as { errorMessage?: string };
        this.error = e.errorMessage ?? '未知错误';
        this.status = 'error';
        break;
      }
      default:
        break;
    }
  }
}