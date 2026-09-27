// 连通性诊断：不用启动桥接，直接检查 Pi-Web + 飞书 + 本地进程状态。
// 用法：npm run probe:health  （或 node --env-file-if-exists=.env src/probes/probe-health.ts）
import { loadConfig } from '../config.ts';
import { PiWebClient } from '../piweb/client.ts';

const OK = '✅';
const NO = '❌';
const INFO = 'ℹ️ ';

const cfg = loadConfig();
let bad = 0;
const fail = (s: string) => {
  console.log(`  ${NO} ${s}`);
  bad++;
};

console.log('\n━━ 桥接连通性诊断 ━━');

// ── 1. Pi-Web ────────────────────────────────────────────
console.log(`\n[${cfg.piwebBaseUrl}]`);
const client = new PiWebClient(cfg.piwebBaseUrl, cfg.piwebPassword);
try {
  const r = await client.getRunning();
  console.log(`  ${OK} Pi-Web 已启动，鉴权通过，运行中 agent ${r.runningSessionIds.length} 个`);
  const sess = await client.listSessions();
  const cwds = [...new Set(sess.sessions.map((s) => s.cwd))];
  console.log(`  ${OK} 会话文件 ${sess.sessions.length} 个，覆盖 ${cwds.length} 个项目空间`);
  for (const c of cwds.slice(0, 5)) console.log(`       · ${c}`);
  const models = await client.getModels();
  console.log(
    `  ${OK} 模型 ${models.providers.reduce((n, p) => n + (p.models?.length ?? 0), 0)} 个（${models.providers.map((p) => p.name).join('、')}）`,
  );
} catch (e) {
  fail(`Pi-Web 不通：${String(e).slice(0, 120)}`);
  console.log(`       检查：pi-web 是否启动、PIWEB_BASE_URL、PIWEB_PASSWORD（用户名固定 pi）`);
}

// ── 2. 飞书应用凭据 ──────────────────────────────────────
console.log(`\n[飞书]`);
if (!cfg.lark.appId || !cfg.lark.appSecret) {
  fail('LARK_APP_ID / LARK_APP_SECRET 未配置（见 .env）');
} else {
  try {
    const sdk = await import('@larksuiteoapi/node-sdk');
    const client = new sdk.Client({ appId: cfg.lark.appId, appSecret: cfg.lark.appSecret });
    // urlPath 是 SDK 内部请求的实际字段（类型声明为 AxiosRequestConfig，故断言）
    await client.request(
      { method: 'GET', urlPath: '/open-apis/auth/v3/app_access_token/internal' } as never,
    );
    console.log(`  ${OK} 应用凭据有效，可换取 token（${cfg.lark.appId.slice(0, 8)}…）`);
  } catch (e) {
    fail(`飞书凭据无效：${String(e).slice(0, 120)}`);
    console.log(`       检查 App ID / App Secret 是否复制完整`);
  }
}
console.log(`  ${INFO} 收消息/卡片回调还需后台订阅 im.message.receive_v1 + card.action.trigger`);
console.log(`  ${INFO} 权限改动必须「创建版本并发布」才生效`);

// ── 3. 桥接进程 ─────────────────────────────────────────
console.log(`\n[本地进程]`);
const { execFileSync } = await import('node:child_process');
const pid = (() => {
  try {
    return execFileSync('pgrep', ['-f', 'src/index\.ts']).toString().trim();
  } catch {
    return '';
  }
})();
if (pid) {
  console.log(`  ${OK} 桥接正在运行（pid ${pid}）`);
  console.log(`       停止：kill ${pid}`);
} else {
  console.log(`  ${INFO} 桥接未在运行（不影响上面两项诊断）`);
  console.log(`       启动：npm start`);
}

// ── 4. 结论 ─────────────────────────────────────────────
console.log(
  bad
    ? `\n❌ ${bad} 项未通过，修复后重试。`
    : `\n✅ 全部通过。启动桥接：npm start`,
);
process.exit(bad ? 1 : 0);
