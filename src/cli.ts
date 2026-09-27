#!/usr/bin/env node
// CLI 入口：`pi-web-feishu-bridge` 命令
//
// 用法：
//   pi-web-feishu-bridge                  启动桥接服务（在当前目录找 .env）
//   pi-web-feishu-bridge --help           显示帮助
//   pi-web-feishu-bridge --version        显示版本
//   pi-web-feishu-bridge --init           在当前目录生成 .env 模板
//   pi-web-feishu-bridge --env <path>     指定 .env 文件路径
//   pi-web-feishu-bridge --cwd <dir>      切换到指定目录再启动
import { main as runBridge } from './index.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const HELP = `
pi-web-feishu-bridge — 飞书远程指挥 pi 编码 agent 的桥接

用法:
  pi-web-feishu-bridge [选项]              启动桥接服务

选项:
  --help, -h              显示本帮助
  --version, -v           显示版本号
  --init                  在当前目录生成 .env 模板并退出
  --env <path>            指定 .env 文件路径（默认：当前目录 .env）
  --cwd <dir>             切换到指定目录再启动（.env 在那里找）

环境变量:
  完整清单见 .env.example。必填三项:
    PIWEB_PASSWORD        pi-web 的 Basic Auth 密码
    LARK_APP_ID           飞书应用 App ID
    LARK_APP_SECRET       飞书应用 App Secret

典型工作流:
  1. npm i -g pi-web-feishu-bridge
  2. mkdir ~/pi-bridge && cd ~/pi-bridge
  3. pi-web-feishu-bridge --init          # 生成 .env 模板
  4. cp .env .env.bak && $EDITOR .env     # 填密钥
  5. pi-web-feishu-bridge                 # 启动服务

故障排查:
  连不上 pi-web 会直接退出（exit 1），日志打印原因。
  飞书凭据错会触发节流（最长 60s），先确认 App ID / Secret 正确。

详细文档:
  https://github.com/homilais/pi-web-feishu-bridge
`.trim();

function runInit(): void {
  const envPath = './.env';
  if (existsSync(envPath)) {
    console.log(`✗ .env 已存在，不覆盖。`);
    return;
  }
  const template = `# pi-web-feishu-bridge 配置
# 完整说明见 README 与 docs/IMPLEMENTATION.md
# 本文件由 pi-web-feishu-bridge --init 生成

# ── Pi-Web 基座（必填）─────────────────────────────────────
PIWEB_PASSWORD=change-me
PIWEB_BASE_URL=http://127.0.0.1:30141

# ── 飞书应用（必填）───────────────────────────────────────
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx

# ── 可选 ──────────────────────────────────────────────────
# DEFAULT_MODEL=provider/modelId
# LARK_ALLOW_OPEN_IDS=
# LARK_GROUP_ALLOWLIST=
`;
  writeFileSync(envPath, template);
  console.log(`✓ 已生成 ${envPath}`);
  console.log(`  下一步: $EDITOR ${envPath}`);
  console.log(`  填好密钥后运行: pi-web-feishu-bridge`);
}

function loadEnvFile(path: string): void {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** 默认加载当前目录的 .env（不存在时静默跳过）。 */
function autoLoadEnv(): void {
  const envPath = './.env';
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
}

function usage(): void {
  console.error('运行 `pi-web-feishu-bridge --help` 查看用法。');
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (flag === '--help' || flag === '-h') {
    console.log(HELP);
    return;
  }
  if (flag === '--version' || flag === '-v') {
    console.log(`pi-web-feishu-bridge ${VERSION}`);
    return;
  }
  if (flag === '--init') {
    runInit();
    return;
  }
  if (flag === '--env') {
    const envPath = args[1];
    if (!envPath) {
      console.error('用法: pi-web-feishu-bridge --env <path>');
      process.exit(2);
    }
    if (!existsSync(envPath)) {
      console.error(`✗ 找不到 env 文件: ${envPath}`);
      process.exit(2);
    }
    loadEnvFile(envPath);
    await runBridge();
    return;
  }
  if (flag === '--cwd') {
    const dir = args[1];
    if (!dir) {
      console.error('用法: pi-web-feishu-bridge --cwd <dir>');
      process.exit(2);
    }
    process.chdir(resolve(dir));
    await runBridge();
    return;
  }
  if (flag && flag.startsWith('-')) {
    console.error(`未知选项: ${flag}`);
    usage();
    process.exit(2);
  }
  // 无参数：默认加载当前目录 .env 并启动
  autoLoadEnv();
  await runBridge();
}

cli().catch((e) => {
  console.error('[pi-web-feishu-bridge] 启动失败：', e);
  process.exit(1);
});
