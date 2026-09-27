// 翻译层核心：SSE 事件 → 飞书流式卡片
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { PiWebClient } from '../piweb/client.ts';
import { subscribeEvents, type SseSubscription } from '../piweb/events.ts';
import type { PendingApprovals } from './queue.ts';
import { TurnState } from './turn-state.ts';
import { streamCard, type TurnActions } from '../feishu/cards.ts';
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
  client: PiWebClient,
  chatId: string,
  agentId: string,
  prompt: string,
  pending: PendingApprovals,
  projectLabel: string,
  actions?: TurnActions,
): Promise<RunTurnResult> {
  const turnId = crypto.randomUUID();
  const turn = new TurnState(turnId, prompt);
  const startedAt = Date.now();

  let dbgCount = 0;
  const sub: SseSubscription = subscribeEvents(client, agentId, {
    onEvent: (ev) => {
      dbgCount++;
      if (ev.type === 'message_update') {
        const ae = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
        log.info(`[dbg] event#${dbgCount} ${ev.type} ae.type=${ae?.type} delta=${JSON.stringify((ae?.delta ?? '').slice(0, 20))} textLen=${turn.text.length}`);
      } else {
        log.info(`[dbg] event#${dbgCount} ${ev.type}`);
      }
      turn.handleEvent(ev, pending);
    },
    onReconnect: (a) => log.warn(`agent ${agentId} SSE 重连 #${a}`),
  });

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
                await ctl.update(streamCard(turn, projectLabel, actions)).catch((e) =>
                  log.warn('卡片更新失败', { e: String(e) }),
                );
                lastSig = sig;
              }
            }
            await ctl.update(streamCard(turn, projectLabel, actions)).catch(() => {});
          },
        },
      },
      { replyTo: undefined },
    );

    await sleep(400);
    await client.sendPrompt(agentId, prompt);
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
    sub.close();
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
