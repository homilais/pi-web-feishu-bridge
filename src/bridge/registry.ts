// 飞书会话 ↔ 项目(cwd) ↔ pi-web agent 的绑定（持久化，v2）
// v2 关键变化：agent 按「项目(cwd)」共享，不再按飞书 chatId 独占。
//   chats:  chatId → {cwd, createdAt}        （飞书会话当前在指挥哪个项目）
//   agents: cwd    → {agentId, cwd}          （项目 → 复用的 agent；跨会话共享）
import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../log.ts';

const log = logger('registry');

export interface ChatBinding {
  chatId: string;
  cwd: string; // 当前指挥的项目目录
  createdAt: number;
}
export interface ProjectAgent {
  agentId: string;
  cwd: string;
}

/** 卡片消息 → 项目/agent 的路由映射（支持飞书「回复卡片」定向到进程）。 */
export interface MessageRoute {
  cwd: string;
  agentId: string;
  at: number;
}

interface StoredState {
  version: 2;
  chats: Record<string, ChatBinding>;
  agents: Record<string, ProjectAgent>;
  routes?: Record<string, MessageRoute>;
}

// v1 旧结构（用于迁移）
interface V1Binding {
  chatId: string;
  projectId: string;
  agentId?: string;
  createdAt: number;
}

export class Registry {
  private file: string;
  private chats = new Map<string, ChatBinding>();
  private agents = new Map<string, ProjectAgent>();
  private routes = new Map<string, MessageRoute>();
  private static readonly MAX_ROUTES = 800;

  /** @param slugToCwd v1→v2 迁移用：projectId(slug) → cwd 映射（来自静态配置） */
  constructor(file: string, slugToCwd: Record<string, string> = {}) {
    this.file = file;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as StoredState | { bindings?: V1Binding[] };
      if (raw && (raw as StoredState).version === 2) {
        const st = raw as StoredState;
        for (const b of Object.values(st.chats ?? {})) this.chats.set(b.chatId, b);
        for (const a of Object.values(st.agents ?? {})) this.agents.set(a.cwd, a);
        for (const [k, r] of Object.entries(st.routes ?? {})) this.routes.set(k, r);
        log.info(
          `加载 ${this.chats.size} 个会话绑定、${this.agents.size} 个项目 agent、${this.routes.size} 条消息路由`,
        );
        return;
      }
      // v1 → v2 迁移
      if (raw && Array.isArray((raw as { bindings?: V1Binding[] }).bindings)) {
        let migrated = 0;
        let skipped = 0;
        for (const b of (raw as { bindings: V1Binding[] }).bindings) {
          const cwd = slugToCwd[b.projectId];
          if (!cwd) {
            skipped++;
            continue;
          }
          this.chats.set(b.chatId, { chatId: b.chatId, cwd, createdAt: b.createdAt });
          if (b.agentId) this.agents.set(cwd, { agentId: b.agentId, cwd });
          migrated++;
        }
        log.info(`v1→v2 迁移：${migrated} 条，跳过 ${skipped} 条（未知项目）`);
        this.persist();
        return;
      }
    } catch {
      /* 文件不存在或解析失败 */
    }
    log.info('无持久化绑定，从空开始');
  }

  // —— 会话 ↔ 项目 ——
  get(chatId: string): ChatBinding | undefined {
    return this.chats.get(chatId);
  }
  bindProject(chatId: string, cwd: string): ChatBinding {
    const existing = this.chats.get(chatId);
    const b: ChatBinding = { chatId, cwd, createdAt: existing?.createdAt ?? Date.now() };
    this.chats.set(chatId, b);
    this.persist();
    return b;
  }
  projectOf(chatId: string): string | undefined {
    return this.chats.get(chatId)?.cwd;
  }
  /** 解绑会话（使其下次消息触发「选择项目」提示）。 */
  unbindChat(chatId: string): void {
    if (this.chats.delete(chatId)) this.persist();
  }
  /** 所有会话绑定（用于按项目反查）。 */
  chatBindings(): ChatBinding[] {
    return [...this.chats.values()];
  }

  // —— 项目 ↔ agent（跨会话共享）——
  getAgent(cwd: string): ProjectAgent | undefined {
    return this.agents.get(cwd);
  }
  setAgent(cwd: string, agentId: string): void {
    this.agents.set(cwd, { agentId, cwd });
    this.persist();
  }
  /** 采纳一个已存在的活跃 agent（不创建新进程）。 */
  adoptAgent(cwd: string, agentId: string): void {
    this.setAgent(cwd, agentId);
  }
  clearAgent(cwd: string): void {
    if (this.agents.delete(cwd)) this.persist();
  }
  /** 所有项目 agent，供状态枚举时回填 hasAgent。 */
  agentEntries(): ProjectAgent[] {
    return [...this.agents.values()];
  }

  // —— 卡片消息 → 项目/agent 路由（飞书回复定向）——
  routeFor(messageId: string): MessageRoute | undefined {
    return this.routes.get(messageId);
  }
  rememberRoute(messageId: string, cwd: string, agentId: string): void {
    this.routes.set(messageId, { cwd, agentId, at: Date.now() });
    if (this.routes.size > Registry.MAX_ROUTES) {
      const sorted = [...this.routes.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of sorted.slice(0, this.routes.size - Registry.MAX_ROUTES)) this.routes.delete(k);
    }
    this.persist();
  }

  private persist(): void {
    const st: StoredState = {
      version: 2,
      chats: Object.fromEntries(this.chats.values().map((b) => [b.chatId, b])),
      agents: Object.fromEntries(this.agents.values().map((a) => [a.cwd, a])),
      routes: Object.fromEntries(this.routes),
    };
    try {
      writeFileSync(this.file, JSON.stringify(st, null, 2));
    } catch (e) {
      log.error('持久化失败', e);
    }
  }
}
