// 入口：装配 Pi-Web 客户端 + 飞书 Channel + Bridge，长驻运行
// 本模块 **只导出 main**，不自动执行 ——
//   CLI 入口在 src/cli.ts（已带 shebang，作为 npm bin）；
//   开发时可直接 `node --watch --env-file-if-exists=.env src/cli.ts`。
import { loadConfig } from './config.ts';
import { PiWebClient } from './piweb/client.ts';
import { Registry } from './bridge/registry.ts';
import { QueueMap, PendingApprovals } from './bridge/queue.ts';
import { Bridge } from './bridge/bridge.ts';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { logger } from './log.ts';

const log = logger('main');

export async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info(`Pi-Web @ ${cfg.piwebBaseUrl}，项目 ${cfg.projects.length} 个`);
  for (const p of cfg.projects) log.info(`  · ${p.id}  ${p.cwd}`);

  const client = new PiWebClient(cfg.piwebBaseUrl, cfg.piwebPassword);
  try {
    const r = await client.getRunning();
    log.info(`Pi-Web 连接正常，运行中 agent ${r.runningSessionIds.length} 个`);
  } catch (e) {
    log.error('无法连接 Pi-Web，请确认已启动且 PIWEB_PASSWORD 正确', e);
    process.exit(1);
  }

  const registry = new Registry(
    'registry.json',
    Object.fromEntries(cfg.projects.map((p) => [p.id, p.cwd])),
  );
  const queues = new QueueMap();
  const pending = new PendingApprovals();

  // 先建 channel（仅需凭据），再建 bridge（带 channel），最后挂事件
  const channel = createLarkChannel({
    appId: cfg.lark.appId,
    appSecret: cfg.lark.appSecret,
    transport: 'websocket',
    source: 'connect-bridge',
    policy: {
      dmMode: cfg.lark.allowOpenIds.length ? 'allowlist' : 'open',
      dmAllowlist: cfg.lark.allowOpenIds,
      groupAllowlist: cfg.lark.groupAllowlist,
      requireMention: true,
    },
    safety: { dedup: { ttl: 60_000 }, chatQueue: { enabled: true } },
  });

  const bridge = new Bridge({
    client,
    channel,
    registry,
    queues,
    pending,
    staticProjects: cfg.projects,
    defaultModel: cfg.defaultModel,
    allowOpenIds: cfg.lark.allowOpenIds,
    groupAllowlist: cfg.lark.groupAllowlist,
  });

  channel.on('message', (msg) => void bridge.onMessage(msg));
  channel.on('cardAction', (evt) => void bridge.onCardAction(evt));
  channel.on('reject', (evt) => log.warn(`[lark] 消息被策略拒绝: ${JSON.stringify(evt).slice(0, 200)}`));
  channel.on('error', (e) => log.error(`[lark] ${e.code}: ${e.message}`));
  channel.on('reconnecting', () => log.warn('飞书长连接重连中…'));
  channel.on('reconnected', () => log.info('飞书长连接已重连'));

  log.info('连接飞书长连接…');
  await channel.connect();
  log.info('✅ 桥接已就绪。在飞书里给机器人发消息试试。');

  const shutdown = async (sig: string) => {
    log.info(`收到 ${sig}，关闭中…`);
    pending.rejectAll();
    await channel.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
