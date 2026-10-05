// 上行事件合并：把一个批次内**相邻**的增量文本拼成一条，其余事件按序原样保留。
//
// 为什么必须合并（见 specs/terminal-bot.md）：
//   `text_delta` 在 TurnState 里是 `seg.text += delta` 的**追加**语义，丢弃即永久丢字。
//   其余事件要么幂等（toolcall_start / tool_execution_start 重复设置无害），
//   要么不可丢（tool_execution_end 丢了状态卡在 running；agent_settled 丢了卡片永不收尾；
//   extension_ui_request 丢了审批死锁）。
import type { PiWebEvent } from '../piweb/types.ts';

/** AssistantMessageEvent 末尾有 `type: string` 兜底成员，无法靠判别联合收窄，故用自定义守卫。 */
interface TextDeltaEvent {
  type: 'message_update';
  assistantMessageEvent: { type: 'text_delta'; delta: string; [k: string]: unknown };
}

function isTextDelta(ev: PiWebEvent): ev is TextDeltaEvent {
  const ame = ev.type === 'message_update' ? (ev as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent : undefined;
  return ame?.type === 'text_delta' && typeof ame.delta === 'string';
}

/** 把相邻的 text_delta 合并；其余事件原样保留。**无损**。 */
export function coalesceEvents(events: PiWebEvent[]): PiWebEvent[] {
  const out: PiWebEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (isTextDelta(ev) && prev && isTextDelta(prev)) {
      // 相邻 → 拼接。顺序不变，只是把 N 条变 1 条
      out[out.length - 1] = {
        type: 'message_update',
        assistantMessageEvent: {
          ...prev.assistantMessageEvent,
          delta: prev.assistantMessageEvent.delta + ev.assistantMessageEvent.delta,
        },
      } as PiWebEvent;
      continue;
    }
    out.push(ev);
  }
  return out;
}

/** 积压保护：超过阈值时进一步塌缩，防止极端网络下缓冲无限增长。 */
export function compactUnderPressure(events: PiWebEvent[], max = 400): PiWebEvent[] {
  if (events.length <= max) return events;
  const kept: PiWebEvent[] = [];
  let textRun: PiWebEvent[] = [];
  const flushText = (): void => {
    if (!textRun.length) return;
    kept.push(...coalesceEvents(textRun));
    textRun = [];
  };
  for (const ev of events) {
    if (isTextDelta(ev)) {
      textRun.push(ev);
      continue;
    }
    flushText();
    kept.push(ev);
  }
  flushText();
  // 仍超量：截断头部，但**保留尾部**（最新状态最重要），且不丢 settled
  if (kept.length > max) {
    const tail = kept.slice(-max);
    const hasSettled = events.some((e) => e.type === 'agent_settled');
    return hasSettled && !tail.some((e) => e.type === 'agent_settled') ? [...tail, events[events.length - 1]] : tail;
  }
  return kept;
}