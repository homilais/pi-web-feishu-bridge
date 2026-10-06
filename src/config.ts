// 配置解析：YAML 多机器人配置（v3）+ .env 单机器人回退（向后兼容）
//
// 配置文件格式见 docs/REQUIREMENTS.md §9.2。
// 关键规则：
//   - 默认机器人（cwds 缺省/空）≤ 1 个，可绑 pi-web 全集（减去限定机器人声明的 cwd）
//   - 限定机器人必须指定 cwds，可绑 = 自身 cwds ∩ pi-web
//   - 一个 cwd 在所有限定机器人 cwds 合集中只能出现一次（配置级独占）
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { logger } from './log.ts';

const log = logger('config');

/** 机器人类型：
 *  - `piweb-pool`   默认机器人（cwds 为空），可绑 pi-web 全集减去他人声明的
 *  - `piweb-scoped` 限定机器人，可绑自身 cwds ∩ pi-web
 *  - `pi-terminal`  终端感知机器人，可绑已注册的终端 pi 会话（不声明 cwds）
 *  kind 缺省时按 cwds 推断（空→piweb-pool / 非空→piweb-scoped），保证既有配置无需修改。 */
export type BotKind = 'piweb-pool' | 'piweb-scoped' | 'pi-terminal';

export interface BotConfig {
  id: string;
  kind: BotKind;
  appId: string;
  appSecret: string;
  /** 该机器人绑定的 cwd 列表（已 resolve 规范化）。仅 piweb-scoped 非空。 */
  cwds: string[];
  allowOpenIds: string[];
  groupAllowlist: string[];
  /** 是否为默认机器人（kind === 'piweb-pool'）。 */
  readonly isDefault: boolean;
}

export interface AppConfig {
  piwebBaseUrl: string;
  piwebPassword: string;
  defaultModel?: { provider: string; modelId: string };
  bots: BotConfig[];
  configPath?: string;
  /** 配置来源：yaml 文件 / env 回退。 */
  source: 'yaml' | 'env';
}

/** 项目稳定 id：basename 的 slug 化（非字母数字 → -）。 */
export function projectSlug(cwd: string): string {
  const base = resolve(cwd).split('/').filter(Boolean).pop() ?? 'project';
  return base.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

/** 项目显示名：basename。 */
export function projectLabel(cwd: string): string {
  return resolve(cwd).split('/').filter(Boolean).pop() ?? cwd;
}

/** ${ENV_VAR} 插值：把字符串里的 ${NAME} 替换为 process.env[NAME]（未设置则空）。 */
function interpolate(val: string): string {
  return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`[config] 缺少环境变量 ${key}`);
  return v;
}

/** 查找默认配置文件：./config.yaml → ./config.json。返回绝对路径或 undefined。 */
function findConfigFile(): string | undefined {
  for (const name of ['config.yaml', 'config.yml', 'config.json']) {
    const p = resolve(name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

interface RawBot {
  id?: string;
  /** 可选；缺省时按 cwds 推断。 */
  kind?: string;
  appId?: string;
  appSecret?: string;
  cwds?: string[];
  allowOpenIds?: string[];
  groupAllowlist?: string[];
}

interface RawConfig {
  piweb?: { baseUrl?: string; password?: string };
  defaultModel?: string;
  bots?: RawBot[];
}

/** 解析并校验 YAML 配置。 */
function loadFromYaml(path: string): AppConfig {
  const rawText = readFileSync(path, 'utf8');
  const raw = yamlLoad(rawText) as RawConfig | null;
  if (!raw || !Array.isArray(raw.bots) || raw.bots.length === 0) {
    throw new Error(`[config] ${path}: 缺少 bots 配置或为空`);
  }
  const piwebBaseUrl = raw.piweb?.baseUrl?.trim() || process.env.PIWEB_BASE_URL || 'http://127.0.0.1:30141';
  const piwebPasswordRaw = raw.piweb?.password ?? '';
  const piwebPassword = interpolate(String(piwebPasswordRaw));
  const defaultModel = parseDefaultModel(raw.defaultModel ?? process.env.DEFAULT_MODEL);

  const bots = raw.bots.map((b) => normalizeBot(b));
  validateBots(bots, piwebPassword, path);

  log.info(`配置来源：YAML（${path}），${bots.length} 个机器人`);
  return { piwebBaseUrl, piwebPassword, defaultModel, bots, configPath: path, source: 'yaml' };
}

/** 回退：从 .env / 环境变量构造单默认机器人（向后兼容旧用法）。 */
function loadFromEnv(): AppConfig {
  const appId = process.env.LARK_APP_ID ?? '';
  const appSecret = process.env.LARK_APP_SECRET ?? '';
  const piwebBaseUrl = process.env.PIWEB_BASE_URL ?? 'http://127.0.0.1:30141';
  const piwebPassword = requireEnv('PIWEB_PASSWORD');
  const defaultModel = parseDefaultModel(process.env.DEFAULT_MODEL);

  const bot: BotConfig = {
    id: 'default',
    kind: 'piweb-pool',
    appId,
    appSecret,
    cwds: [],
    allowOpenIds: (process.env.LARK_ALLOW_OPEN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    groupAllowlist: (process.env.LARK_GROUP_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    isDefault: true,
  };
  const bots = [bot];
  validateBots(bots, piwebPassword, '.env');
  log.info('配置来源：env 回退（单默认机器人）');
  return { piwebBaseUrl, piwebPassword, defaultModel, bots, source: 'env' };
}

function normalizeBot(b: RawBot): BotConfig {
  const id = (b.id ?? '').trim();
  const appId = (b.appId ?? '').trim();
  const appSecret = (b.appSecret ?? '').trim();
  const cwds = (b.cwds ?? []).map((c) => resolve(String(c).trim())).filter(Boolean);
  const kind = resolveKind(b.kind, cwds, id);
  return {
    id,
    kind,
    appId,
    appSecret,
    cwds,
    allowOpenIds: (b.allowOpenIds ?? []).map((s) => String(s).trim()).filter(Boolean),
    groupAllowlist: (b.groupAllowlist ?? []).map((s) => String(s).trim()).filter(Boolean),
    isDefault: kind === 'piweb-pool',
  };
}

const BOT_KINDS: BotKind[] = ['piweb-pool', 'piweb-scoped', 'pi-terminal'];

/** kind 缺省时按现有规则推断，保持既有配置零修改。 */
function resolveKind(raw: string | undefined, cwds: string[], botId: string): BotKind {
  if (!raw || !raw.trim()) return cwds.length === 0 ? 'piweb-pool' : 'piweb-scoped';
  const k = raw.trim() as BotKind;
  if (!BOT_KINDS.includes(k)) {
    throw new Error(
      `[config] 机器人 ${botId} 的 kind="${raw}" 无效，可选：${BOT_KINDS.join(' / ')}`,
    );
  }
  return k;
}

function parseDefaultModel(raw?: string): { provider: string; modelId: string } | undefined {
  if (!raw) return undefined;
  const slash = raw.indexOf('/');
  if (slash <= 0) {
    log.warn(`DEFAULT_MODEL 格式应为 provider/modelId，收到：${raw}，忽略`);
    return undefined;
  }
  return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

/** 启动前严格校验，任一不过即抛错退出（fail fast）。 */
function validateBots(bots: BotConfig[], piwebPassword: string, source: string): void {
  if (bots.length === 0) throw new Error(`[config] ${source}: 至少需要 1 个机器人`);
  if (!piwebPassword) throw new Error(`[config] piweb.password 未配置（或 ${'$'}{PIWEB_PASSWORD} 未设置）`);

  // id 唯一 + 非空
  const ids = new Set<string>();
  for (const b of bots) {
    if (!b.id) throw new Error(`[config] 机器人缺少 id`);
    if (ids.has(b.id)) throw new Error(`[config] 机器人 id 重复：${b.id}`);
    ids.add(b.id);
  }
  // appId 唯一 + 非空
  const appIds = new Map<string, string>(); // appId → botId
  for (const b of bots) {
    if (!b.appId) throw new Error(`[config] 机器人 ${b.id} 缺少 appId`);
    if (!b.appSecret) throw new Error(`[config] 机器人 ${b.id} 缺少 appSecret`);
    const prev = appIds.get(b.appId);
    if (prev) throw new Error(`[config] 机器人 ${b.id} 与 ${prev} 使用了相同的 appId（${b.appId}），不允许`);
    appIds.set(b.appId, b.id);
  }
  // 默认机器人 ≤ 1
  const defaults = bots.filter((b) => b.isDefault);
  if (defaults.length > 1) {
    throw new Error(
      `[config] 默认机器人（不指定 cwds）最多 1 个，现有 ${defaults.length} 个：${defaults.map((b) => b.id).join(', ')}`,
    );
  }
  // 终端感知机器人 ≤ 1，且不得声明 cwds（语义冲突）
  const terminals = bots.filter((b) => b.kind === 'pi-terminal');
  if (terminals.length > 1) {
    throw new Error(
      `[config] 终端感知机器人（kind: pi-terminal）最多 1 个，现有 ${terminals.length} 个：${terminals.map((b) => b.id).join(', ')}`,
    );
  }
  for (const b of terminals) {
    if (b.cwds.length) {
      throw new Error(
        `[config] 机器人 ${b.id} 同时声明了 kind: pi-terminal 与 cwds，语义冲突。\n  终端感知机器人自动发现终端 pi 会话，不应配置 cwds。`,
      );
    }
  }
  // 限定机器人 cwds 全局不重复（一个 cwd 只归属一个机器人）
  const cwdOwner = new Map<string, string>(); // cwd → botId
  for (const b of bots) {
    if (b.kind !== 'piweb-scoped') continue;
    for (const cwd of b.cwds) {
      const prev = cwdOwner.get(cwd);
      if (prev) {
        throw new Error(
          `[config] cwd 重复配置：\n  「${cwd}」\n    同时出现在机器人 ${prev} 和 ${b.id} 的 cwds 中\n  一个 cwd 只允许归属一个机器人，请修改配置后重试。`,
        );
      }
      cwdOwner.set(cwd, b.id);
    }
  }
}

/** 加载配置。configPath 优先；否则查默认 config.yaml/json；都没有则回退 env。 */
export function loadConfig(opts: { configPath?: string } = {}): AppConfig {
  const path = opts.configPath ? resolve(opts.configPath) : findConfigFile();
  if (path) {
    if (!existsSync(path)) throw new Error(`[config] 指定的配置文件不存在：${path}`);
    return loadFromYaml(path);
  }
  return loadFromEnv();
}

/** 所有限定机器人声明的 cwd 合集（供默认机器人排除用）。 */
export function scopedCwdsOf(bots: BotConfig[]): string[] {
  return bots.filter((b) => !b.isDefault).flatMap((b) => b.cwds);
}

/** 生成 config.yaml 模板字符串。 */
export function configYamlTemplate(): string {
  return `# pi-web-feishu-bridge 多机器人配置
# 完整说明见 docs/REQUIREMENTS.md §9
# 本文件由 pi-web-feishu-bridge --init 生成（请勿提交 git）

piweb:
  baseUrl: http://127.0.0.1:30141
  password: \${PIWEB_PASSWORD}   # 引用环境变量，避免明文；也可直接填字面量

# 默认模型（可选）
# defaultModel: provider/modelId

bots:
  # ── 默认机器人（不指定 cwds，最多 1 个，可省略）──
  # 可绑 pi-web 全集（减去下方限定机器人声明的 cwd）
  - id: default
    appId: cli_xxx
    appSecret: yyy
    # allowOpenIds: [ou_xxx]        # 私聊白名单；空=开放
    # groupAllowlist: [oc_xxx]     # 群白名单；空=任意群

  # ── 限定机器人（必须指定 cwds，可多个）──
  # 只能绑配置的 cwd；这些 cwd 对其他机器人不可见、不可绑
  - id: alpha
    appId: cli_aaa
    appSecret: bbb
    cwds:
      - /Users/you/project/alpha
  # - id: docs
  #   appId: cli_ccc
  #   appSecret: ddd
  #   cwds:
  #     - /path/a
  #     - /path/b
  #   groupAllowlist: [oc_xxx]
`;
}

/** 把模板写到指定路径（默认 ./config.yaml）。已存在不覆盖。 */
export function writeConfigTemplate(path = './config.yaml'): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, configYamlTemplate());
  return true;
}

