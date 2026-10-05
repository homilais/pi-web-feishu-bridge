// 翻译层核心：SSE 事件 → 飞书流式卡片
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentSession } from './agent-session.ts';
import type { PendingApprovals } from './queue.ts';
import { TurnState } from './turn-state.ts';
import { streamCard } from '../feishu/cards.ts';
import type { LiveProgress } from '../piweb/types.ts';
import { logger } from '../log.ts';

const log = logger('streamer');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunTurnResult {
  turnId: string;
  messageId?: string;
  text: string;
  status: string;
  error?: string;
  durationMs: number;
}

/** 运行一轮：建立 SSE → 发起流式卡片 → 发 prompt → 跟随事件更新卡片 → settled 终态。 */
export async function runTurn(
  channel: LarkChannel,
  session: AgentSession,
  chatId: string,
  prompt: string,
  pending: PendingApprovals,
  projectLabel: string,
): Promise<RunTurnResult> {
  const agentId = session.sessionId;
  const turnId = crypto.randomUUID();
  const turn = new TurnState(turnId, prompt);
  const startedAt = Date.now();

  let dbgCount = 0;
  const unsubscribe = session.onEvent(
    (ev) => {
      dbgCount++;
      if (ev.type === 'message_update') {
        const ae = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
        log.info(`[dbg] event#${dbgCount} ${ev.type} ae.type=${ae?.type} delta=${JSON.stringify((ae?.delta ?? '').slice(0, 20))} textLen=${turn.text.length}`);
      } else {
        log.info(`[dbg] event#${dbgCount} ${ev.type}`);
      }
      turn.handleEvent(ev, pending);
    },
    {
      onReconnect: (a) => log.warn(`agent ${agentId} SSE 重连 #${a}`),
    },
  );

  let messageId: string | undefined;
  try {
    const streamP = channel.stream(
      chatId,
      {
        card: {
          initial: streamCard(turn, projectLabel),
          producer: async (ctl) => {
            let lastSig = '';
            while (!turn.done && Date.now() < turn.deadline) {
              await sleep(450);
              const sig = turn.signature();
              if (sig !== lastSig) {
                await ctl.update(streamCard(turn, projectLabel)).catch((e) =>
                  log.warn('卡片更新失败', { e: String(e) }),
                );
                lastSig = sig;
              }
            }
            await ctl.update(streamCard(turn, projectLabel)).catch(() => {});
          },
        },
      },
      { replyTo: undefined },
    );

    await sleep(400);
    await session.prompt(prompt);
    const result = await streamP;
    messageId = result.messageId;

    // 超时兜底
    if (!turn.done) {
      log.warn(`turn ${turnId} 超时（未收到 agent_settled）`);
      turn.status = 'error';
      turn.error = '超时未收到 agent_settled';
      turn.done = true;
    }
    log.info(`[dbg] 总事件 ${dbgCount} 个，turn.text=${turn.text.length}字 status=${turn.status}`);
  } finally {
    unsubscribe();
  }

  return {
    turnId,
    messageId,
    text: turn.text,
    status: turn.status,
    error: turn.error,
    durationMs: Date.now() - startedAt,
  };
}

/** 挂接一个**已在运行**的轮次（`/last` 在执行中时使用）。
 *  不发 prompt，只建立 SSE 订阅 → 跟随事件持续更新一张流式卡片 → 轮次结束/超时返回。
 *  并发安全：pi-web 的 SSE 端点支持同一 session 多订阅（已实测）。 */
export async function attachRunningTurn(
  channel: LarkChannel,
  session: AgentSession,
  chatId: string,
  pending: PendingApprovals,
  projectLabel: string,
  snapshot: LiveProgress,
): Promise<RunTurnResult> {
  const agentId = session.sessionId;
  const turnId = crypto.randomUUID();
  const turn = new TurnState(turnId, snapshot.prompt, snapshot.startedAt);
  // 预填已有进展，卡片一出现就不是空白
  turn.seedProgress(snapshot);
  const startedAt = Date.now();

  const unsubscribe = session.onEvent(
    (ev) => {
      turn.handleEvent(ev, pending);
      // agent_settled / agent_end 到达即收尾
      if (ev.type === 'agent_settled') turn.done = true;
    },
    {
      onReconnect: (a) => log.warn(`agent ${agentId} 挂接 SSE 重连 #${a}`),
    },
  );

  let messageId: string | undefined;
  try {
    const streamP = channel.stream(
      chatId,
      {
        card: {
          initial: streamCard(turn, projectLabel),
          producer: async (ctl) => {
            let lastSig = turn.signature();
            // 已 done 也至少更新一次（把预填快照刷成终态）
            while (!turn.done && Date.now() < turn.deadline) {
              await sleep(450);
              const sig = turn.signature();
              if (sig !== lastSig) {
                await ctl.update(streamCard(turn, projectLabel)).catch(() => {});
                lastSig = sig;
              }
            }
            await ctl.update(streamCard(turn, projectLabel)).catch(() => {});
          },
        },
      },
      { replyTo: undefined },
    );

    const result = await streamP;
    messageId = result.messageId;

    // 超时兜底（与 runTurn 一致）
    if (!turn.done) {
      log.warn(`挂接轮次 ${turnId} 超时（未收到 agent_settled）`);
      turn.status = 'error';
      turn.error = '超时未收到 agent_settled';
      turn.done = true;
    }
  } finally {
    unsubscribe();
  }

  return {
    turnId,
    messageId,
    text: turn.text,
    status: turn.status,
    error: turn.error,
    durationMs: Date.now() - startedAt,
  };
}
