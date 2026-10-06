// 入口：装配 Pi-Web 客户端（共享）+ 每机器人独立的 Channel/Registry/Bridge，长驻运行
// 本模块 **只导出 main**，不自动执行 ——
//   CLI 入口在 src/cli.ts（已带 shebang，作为 npm bin）；
//   开发时可直接 `node --watch --env-file-if-exists=.env src/cli.ts`。
import { loadConfig, scopedCwdsOf, type BotConfig } from './config.ts';
import { PiWebClient } from './piweb/client.ts';
import { Registry } from './bridge/registry.ts';
import { QueueMap, PendingApprovals } from './bridge/queue.ts';
import { Bridge } from './bridge/bridge.ts';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './log.ts';
import { TerminalServer } from './terminal/server.ts';

const log = logger('main');

export interface MainOptions {
  configPath?: string;
}

/** 启动单个机器人：建 channel/registry/queues/bridge，挂事件，连接。 */
async function startBot(
  bot: BotConfig,
  client: PiWebClient,
  scopedCwdsGlobal: string[],
  defaultModel: { provider: string; modelId: string } | undefined,
  terminal?: TerminalServer,
): Promise<{ channel: ReturnType<typeof createLarkChannel>; disconnect: () => Promise<void> }> {
  // 默认机器人：若 registry.<id>.json 不存在但旧 registry.json 存在，做一次性迁移
  const regPath = resolve(`registry.${bot.id}.json`);
  if (bot.isDefault && !existsSync(regPath) && existsSync('registry.json')) {
    copyFileSync('registry.json', regPath);
    log.info(`[bot=${bot.id}] 从旧 registry.json 迁移到 ${regPath}`);
  }
  const registry = new Registry(regPath, {});
  const queues = new QueueMap();
  const pending = new PendingApprovals();

  const channel = createLarkChannel({
    appId: bot.appId,
    appSecret: bot.appSecret,
    transport: 'websocket',
    source: 'connect-bridge',
    policy: {
      dmMode: bot.allowOpenIds.length ? 'allowlist' : 'open',
      dmAllowlist: bot.allowOpenIds,
      groupAllowlist: bot.groupAllowlist,
      requireMention: true,
    },
    safety: { dedup: { ttl: 60_000 }, chatQueue: { enabled: true } },
  });

  const scopeDesc = bot.isDefault
    ? `默认（pi-web 全集 − ${scopedCwdsGlobal.length} 个限定 cwd）`
    : `限定（${bot.cwds.length} 个 cwd）`;

  const bridge = new Bridge({
    client,
    channel,
    registry,
    queues,
    pending,
    botId: bot.id,
    isDefault: bot.isDefault,
    declaredCwds: bot.cwds,
    scopedCwdsGlobal,
    defaultModel,
    allowOpenIds: bot.allowOpenIds,
    groupAllowlist: bot.groupAllowlist,
    terminal,
  });

  channel.on('message', (msg) => void bridge.onMessage(msg));
  channel.on('cardAction', (evt) => void bridge.onCardAction(evt));
  channel.on('reject', (evt) =>
    log.warn(`[bot=${bot.id}] 消息被策略拒绝: ${JSON.stringify(evt).slice(0, 200)}`),
  );
  channel.on('error', (e) => log.error(`[bot=${bot.id}] [lark] ${e.code}: ${e.message}`));
  channel.on('reconnecting', () => log.warn(`[bot=${bot.id}] 飞书长连接重连中…`));
  channel.on('reconnected', () => log.info(`[bot=${bot.id}] 飞书长连接已重连`));

  log.info(`[bot=${bot.id}] 连接飞书长连接…（${scopeDesc}）`);
  await channel.connect();

  return { channel, disconnect: () => channel.disconnect().catch(() => {}) };
}

export async function main(opts: MainOptions = {}): Promise<void> {
  const cfg = loadConfig({ configPath: opts.configPath });
  log.info(`Pi-Web @ ${cfg.piwebBaseUrl}`);
  for (const b of cfg.bots) {
    log.info(`  · bot=${b.id} ${b.isDefault ? '默认' : '限定'} ${b.cwds.length ? b.cwds.join(',') : ''}`);
  }

  const client = new PiWebClient(cfg.piwebBaseUrl, cfg.piwebPassword);
  try {
    const r = await client.getRunning();
    log.info(`Pi-Web 连接正常，运行中 agent ${r.runningSessionIds.length} 个`);
  } catch (e) {
    log.error('无法连接 Pi-Web，请确认已启动且 PIWEB_PASSWORD 正确', e);
    process.exit(1);
  }

  const scopedCwdsGlobal = scopedCwdsOf(cfg.bots);

  // 存在终端感知机器人时才启动本机监听（仅 127.0.0.1，无 token）
  const needsTerminal = cfg.bots.some((b) => b.kind === 'pi-terminal');
  let terminal: TerminalServer | undefined;
  if (needsTerminal) {
    terminal = new TerminalServer();
    try {
      await terminal.start();
    } catch (e) {
      log.error('终端接入服务启动失败（端口被占用？），桥接退出', e);
      process.exit(1);
    }
  }

  // 启动每个机器人
  const bots: Awaited<ReturnType<typeof startBot>>[] = [];
  for (const bot of cfg.bots) {
    bots.push(
      await startBot(
        bot,
        client,
        scopedCwdsGlobal,
        cfg.defaultModel,
        // 只给终端感知机器人注入；其余 bot 的 deps.terminal 保持 undefined，
        // 否则 pi-web 机器人会误走终端分支（其 cwd/会话与终端无关）
        bot.kind === 'pi-terminal' ? terminal : undefined,
      ),
    );
  }

  log.info(`✅ 桥接已就绪。${cfg.bots.length} 个机器人。在飞书里给机器人发消息试试。`);

  const shutdown = async (sig: string) => {
    log.info(`收到 ${sig}，关闭中…`);
    if (terminal) await terminal.stop().catch(() => {});
    await Promise.all(bots.map((b) => b.disconnect()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
