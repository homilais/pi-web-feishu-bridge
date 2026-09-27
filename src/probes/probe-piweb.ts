// 探针：端到端验证 Pi-Web 接口与 SSE 事件（不依赖飞书凭据）
// 用法：先启动 Pi-Web，再 npm run probe:piweb
import { loadConfig } from '../config.ts';
import { PiWebClient } from '../piweb/client.ts';
import { subscribeEvents } from '../piweb/events.ts';
import type { PiWebEvent } from '../piweb/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const project = cfg.projects[0];
  const client = new PiWebClient(cfg.piwebBaseUrl, cfg.piwebPassword);

  console.log(`[probe] pi-web @ ${cfg.piwebBaseUrl}`);
  console.log(`[probe] project=${project.label} cwd=${project.cwd}`);

  const sessions = await client.listSessions();
  console.log(`[probe] 已有 pi 会话: ${sessions.sessions?.length ?? 0} 个`);
  const running = await client.getRunning();
  console.log(`[probe] 运行中 agent: ${JSON.stringify(running.runningSessionIds)}`);

  const provider = process.env.MODEL_PROVIDER;
  const modelId = process.env.MODEL_ID;
  const ensureCmd: Record<string, unknown> = { type: 'ensure_session' };
  if (provider && modelId) { ensureCmd.provider = provider; ensureCmd.modelId = modelId; }
  const created = await client.createAgent(project.cwd, ensureCmd as any);
  if (!created.success) throw new Error(`创建 agent 失败: ${created.error ?? ''}`);
  const agentId = created.sessionId;
  console.log(`[probe] ✓ 创建 agent ${agentId} (model=${created.model?.provider}/${created.model?.modelId})`);

  const counts: Record<string, number> = {};
  let settled = false;
  let textOut = '';

  const sub = subscribeEvents(client, agentId, {
    onEvent: (ev: PiWebEvent) => {
      counts[ev.type] = (counts[ev.type] ?? 0) + 1;
      if (ev.type === 'message_update') {
        const ae = (ev as { assistantMessageEvent: { type: string; delta?: string } }).assistantMessageEvent;
        if (ae?.type === 'text_delta') {
          process.stdout.write(ae.delta ?? '');
          textOut += ae.delta ?? '';
        }
      } else if (ev.type === 'agent_settled') {
        settled = true;
        console.log('\n[probe] ✓ agent_settled（真正空闲，可发完成通知）');
      } else if (ev.type === 'connected') {
        console.log(`[probe] SSE connected isStreaming=${(ev as { isStreaming: boolean }).isStreaming}`);
      } else if (ev.type === 'extension_ui_request') {
        console.log(`\n[probe] ⚠️ 审批请求: ${(ev as { id: string; method: string; message?: string }).method} id=${(ev as { id: string }).id} ${(ev as { message?: string }).message ?? ''}`);
      } else {
        console.log(`\n[event] ${ev.type}`);
      }
    },
    onDisconnect: (r, e) => console.log(`\n[probe] disconnect ${r} ${String(e)}`),
    onReconnect: (a) => console.log(`\n[probe] reconnect #${a}`),
    onResync: (s) => console.log(`\n[probe] resync running=${s.running} streaming=${s.state.isStreaming}`),
  });

  await sleep(600);
  console.log('\n[probe] 发送 prompt: "只回复两个字：你好"');
  await client.sendPrompt(agentId, '请用一句话（不超过30字）介绍 Node.js 是什么。直接回答，不要调用任何工具。');

  for (let i = 0; i < 60 && !settled; i++) await sleep(1000);

  console.log('\n\n[probe] ===== 事件统计 =====');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
  console.log(`[probe] 收到文本: "${textOut}"`);

  // 清理：abort 后关闭订阅（会话靠 idle timeout dispose）
  await client.abort(agentId).catch(() => {});
  sub.close();
  await sleep(500);
  process.exit(0);
}

main().catch((e) => {
  console.error('[probe] 失败:', e);
  process.exit(1);
});
