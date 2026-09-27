import { resolve } from 'node:path';

export interface ProjectConfig {
  id: string; // slug
  cwd: string; // absolute path
  label: string; // display name
}

export interface AppConfig {
  piwebBaseUrl: string;
  piwebPassword: string;
  projects: ProjectConfig[];
  defaultModel?: { provider: string; modelId: string };
  lark: {
    appId: string;
    appSecret: string;
    allowOpenIds: string[];
    groupAllowlist: string[];
  };
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`[config] 缺少环境变量 ${key}`);
  return v;
}

function slugFromCwd(cwd: string): string {
  return projectSlug(cwd);
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

export function loadConfig(): AppConfig {
  const piwebBaseUrl = process.env.PIWEB_BASE_URL ?? 'http://127.0.0.1:30141';
  const piwebPassword = requireEnv('PIWEB_PASSWORD');
  const projectsRaw = process.env.PROJECTS ?? '';
  const projects: ProjectConfig[] = projectsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cwd) => ({ id: slugFromCwd(cwd), cwd: resolve(cwd), label: slugFromCwd(cwd) }));
  // PROJECTS 未指定 → 空数组（不再默认到 process.cwd()），由桥接在 /info 卡片提示用户选择
  const defaultModelRaw = process.env.DEFAULT_MODEL ?? '';
  let defaultModel: { provider: string; modelId: string } | undefined;
  if (defaultModelRaw) {
    const slash = defaultModelRaw.indexOf('/');
    if (slash > 0) defaultModel = { provider: defaultModelRaw.slice(0, slash), modelId: defaultModelRaw.slice(slash + 1) };
  }
  const lark = {
    appId: process.env.LARK_APP_ID ?? '',
    appSecret: process.env.LARK_APP_SECRET ?? '',
    allowOpenIds: (process.env.LARK_ALLOW_OPEN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    groupAllowlist: (process.env.LARK_GROUP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  return { piwebBaseUrl, piwebPassword, projects, defaultModel, lark };
}
