// 探针：连接飞书长连接 → 等用户给机器人发消息 → 发测试卡片 → 验证按钮回调
// 用法：npm run probe:feishu  然后在飞书单聊里给机器人发任意消息
import { loadConfig } from '../config.ts';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { logger } from '../log.ts';

const log = logger('probe:feishu');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.lark.appId || !cfg.lark.appSecret) {
    log.error('LARK_APP_ID / LARK_APP_SECRET 未配置');
    process.exit(1);
  }

  const channel = createLarkChannel({
    appId: cfg.lark.appId,
    appSecret: cfg.lark.appSecret,
    transport: 'websocket',
    source: 'connect-probe',
    policy: { dmMode: 'open', requireMention: true },
  });

  let gotCardAction = false;
  let gotMessage = false;

  channel.on('message', async (msg) => {
    log.info(`✅ 收到消息！chat=${msg.chatId.slice(-8)} sender=${msg.senderId.slice(-8)} 内容="${msg.content.slice(0, 40)}"`);
    log.info(`   chatId 完整=${msg.chatId}（可填入 LARK_TEST_CHAT_ID 复用）`);
    if (gotMessage) return;
    gotMessage = true;

    const card = {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'Pi 桥接探针' }, template: 'blue' },
      body: {
        elements: [
          { tag: 'markdown', content: '收到你的消息！这是一张测试卡片。\n\n点击下方按钮，验证 **card.action.trigger** 是否订阅成功。' },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 按我测试回调' },
            type: 'primary',
            behaviors: [{ type: 'callback', value: { cmd: 'probe-ok', ts: Date.now() } }],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '停止' },
            type: 'danger',
            behaviors: [{ type: 'callback', value: { cmd: 'probe-stop' } }],
          },
        ],
      },
    };
    try {
      const r = await channel.send(msg.chatId, { card });
      log.info(`✅ 卡片已发送 messageId=${r.messageId}`);
      log.info('   → 现在去飞书点那个按钮，看这里是否打印回调…');
    } catch (e) {
      log.error('发卡片失败', e);
    }
  });

  channel.on('cardAction', (evt) => {
    gotCardAction = true;
    log.info(`✅✅ 收到按钮回调！value=${JSON.stringify(evt.action.value)} op=${evt.operator.openId.slice(-8)}`);
    log.info('   → card.action.trigger 订阅正常，卡片 V2 schema 正确，回调链路通！');
  });

  channel.on('error', (e) => log.error(`[lark] ${e.code}: ${e.message}`));
  channel.on('reconnecting', () => log.warn('重连中…'));
  channel.on('reconnected', () => log.info('已重连'));

  log.info('正在连接飞书长连接…');
  await channel.connect();
  log.info('✅ 长连接已建立！');
  log.info('');
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info('  现在请在飞书里找到机器人，给它发一条消息');
  log.info('  （单聊直接发；群聊需 @机器人）');
  log.info('  探针会等 120 秒');
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (gotCardAction) {
      log.info('🎉 全链路验证通过，5 秒后退出');
      await sleep(5000);
      break;
    }
  }
  if (!gotMessage) log.warn('超时未收到消息。确认：①应用已发布 ②机器人能力已启用 ③你在飞书里能搜到这个机器人');
  else if (!gotCardAction) log.warn('收到消息但没收到按钮回调。确认：后台订阅了 card.action.trigger？卡片渲染正常吗？');
  await channel.disconnect().catch(() => {});
  process.exit(gotCardAction ? 0 : 1);
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
