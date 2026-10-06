#!/usr/bin/env node
// CLI 入口：`pi-web-feishu-bridge` 命令
//
// 用法：
//   pi-web-feishu-bridge                  启动桥接服务（找 ./config.yaml，否则回退 .env）
//   pi-web-feishu-bridge --config <path>  指定配置文件（yaml/json）
//   pi-web-feishu-bridge --init           在当前目录生成 config.yaml 模板
//   pi-web-feishu-bridge --help           显示帮助
//   pi-web-feishu-bridge --version        显示版本
//   pi-web-feishu-bridge --env <path>     指定 .env 文件（用于 PIWEB_PASSWORD 等环境变量）
//   pi-web-feishu-bridge --cwd <dir>      切换到指定目录再启动
import { main as runBridge } from './index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configYamlTemplate } from './config.js';

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
pi-web-feishu-bridge — 飞书远程指挥 pi 编码 agent 的桥接（多机器人）

用法:
  pi-web-feishu-bridge [选项]              启动桥接服务

选项:
  --help, -h              显示本帮助
  --version, -v           显示版本号
  --init                  在当前目录生成 config.yaml 模板并退出
  --config <path>         指定配置文件（yaml/json，默认 ./config.yaml）
  --install-extension     把 pi 扩展装到 ~/.pi/agent/extensions/ 并退出
  --env <path>            指定 .env 文件（用于 PIWEB_PASSWORD 等环境变量）
  --cwd <dir>             切换到指定目录再启动

配置:
  多机器人用 config.yaml（见 --init 生成的模板，或 docs/REQUIREMENTS.md §9）。
  仅当无 config.yaml 时，回退到 .env 中的单默认机器人（向后兼容）。
  密码等敏感值可用 \${PIWEB_PASSWORD} 在 yaml 中引用环境变量。

典型工作流:
  1. npm i -g pi-web-feishu-bridge
  2. mkdir ~/pi-bridge && cd ~/pi-bridge
  3. pi-web-feishu-bridge --init          # 生成 config.yaml 模板
  4. $EDITOR config.yaml                 # 填飞书凭据与 cwd
  5. PIWEB_PASSWORD=xxx pi-web-feishu-bridge   # 启动服务

用终端感知机器人（不依赖 pi-web）:
  1. pi-web-feishu-bridge --install-extension   # 装 pi 扩展
  2. config.yaml 中配一个 kind: pi-terminal 的机器人
  3. 启动桥接后直接跑 pi，终端会话会出现在飞书 /agents

故障排查:
  连不上 pi-web 会直接退出（exit 1），日志打印原因。
  飞书凭据错会触发节流，先确认 App ID / Secret 正确。
  cwd 配置重复会启动报错，按提示修改 config.yaml。

详细文档:
  https://github.com/homilais/pi-web-feishu-bridge
`.trim();

function runInit(): void {
  const path = './config.yaml';
  if (existsSync(path)) {
    console.log(`✗ ${path} 已存在，不覆盖。`);
    return;
  }
  writeFileSync(path, configYamlTemplate());
  console.log(`✓ 已生成 ${path}`);
  console.log(`  下一步: $EDITOR ${path}`);
  console.log(`  填好飞书凭据与 cwd 后运行: PIWEB_PASSWORD=xxx pi-web-feishu-bridge`);
}

function runInstallExtension(): void {
  const src = resolve(__dirname, 'terminal/extension/pi-feishu.ts');
  if (!existsSync(src)) {
    console.error(`✗ 包内缺少扩展文件：${src}`);
    console.error('  可能未完成构建，请重新安装或先运行 npm run build。');
    process.exit(1);
  }
  const dir = join(homedir(), '.pi', 'agent', 'extensions');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'pi-feishu.ts');

  // 内容一致则不重复写入，避免无谓地改用户文件时间戳
  if (existsSync(dest) && readFileSync(dest, 'utf8') === readFileSync(src, 'utf8')) {
    console.log(`✓ 扩展已是最新：${dest}`);
  } else {
    const overwrote = existsSync(dest);
    copyFileSync(src, dest);
    console.log(`✓ ${overwrote ? '已更新' : '已安装'}扩展：${dest}`);
  }
  console.log('');
  console.log('接下来：');
  console.log('  1. 启动桥接（需在 config.yaml 里配置一个 kind: pi-terminal 机器人）');
  console.log('  2. 直接运行 pi —— 终端会话会自动注册，在飞书 /agents 中即可选中');
  console.log('');
  console.log('桥接未启动时扩展会静默降级，不影响本地使用（提示一次，可用 PI_FEISHU_QUIET=1 静音）。');
}

function loadEnvFile(path: string): void {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** 默认加载当前目录的 .env（不存在时静默跳过）。用于 PIWEB_PASSWORD 等环境变量。 */
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

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`pi-web-feishu-bridge ${VERSION}`);
    return;
  }
  if (args.includes('--init')) {
    runInit();
    return;
  }
  if (args.includes('--install-extension')) {
    runInstallExtension();
    return;
  }

  // 解析 --config <path>
  let configPath: string | undefined;
  const configIdx = args.indexOf('--config');
  if (configIdx >= 0) {
    configPath = args[configIdx + 1];
    if (!configPath) {
      console.error('用法: pi-web-feishu-bridge --config <path>');
      process.exit(2);
    }
    if (!existsSync(configPath)) {
      console.error(`✗ 找不到配置文件: ${configPath}`);
      process.exit(2);
    }
  }

  // 解析 --env <path>（加载环境变量，不影响 configPath）
  const envIdx = args.indexOf('--env');
  if (envIdx >= 0) {
    const envPath = args[envIdx + 1];
    if (!envPath) {
      console.error('用法: pi-web-feishu-bridge --env <path>');
      process.exit(2);
    }
    if (!existsSync(envPath)) {
      console.error(`✗ 找不到 env 文件: ${envPath}`);
      process.exit(2);
    }
    loadEnvFile(envPath);
  }

  // 解析 --cwd <dir>（在加载配置前切换，使 config.yaml/.env 相对路径生效）
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx >= 0) {
    const dir = args[cwdIdx + 1];
    if (!dir) {
      console.error('用法: pi-web-feishu-bridge --cwd <dir>');
      process.exit(2);
    }
    process.chdir(resolve(dir));
  }

  // 检查未知选项
  const known = new Set([
    '--help', '-h', '--version', '-v', '--init', '--install-extension',
    '--config', '--env', '--cwd',
  ]);
  for (const a of args) {
    if (a.startsWith('-') && !known.has(a)) {
      console.error(`未知选项: ${a}`);
      usage();
      process.exit(2);
    }
  }

  // .env 提供环境变量，供 config.yaml 中的 ${...} 插值（与配置文件本身正交）。
  // 只要没显式指定 --env，就自动加载当前目录 .env（此时已 chdir 完成）。
  if (envIdx < 0) autoLoadEnv();
  await runBridge({ configPath });
}

cli().catch((e) => {
  console.error('[pi-web-feishu-bridge] 启动失败：', e?.message ?? e);
  process.exit(1);
});
