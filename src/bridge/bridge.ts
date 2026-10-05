// 桥接编排：飞书消息/卡片动作 → 指令路由 → turn 调度
// v2: agent 按项目(cwd)共享复用；采纳 pi-web 已活跃进程；404 自愈
import type { LarkChannel, NormalizedMessage, CardActionEvent } from '@larksuiteoapi/node-sdk';
import type { PiWebClient } from '../piweb/client.ts';
import type { Registry } from './registry.ts';
import type { QueueMap, PendingApprovals } from './queue.ts';
import { projectLabel } from '../config.ts';
import type { ProjectInfo, RpcCommand, ModelsEnabledResponse } from '../piweb/types.ts';
import { PiWebHttpError } from '../piweb/client.ts';
import { runTurn, attachRunningTurn } from './streamer.ts';
import { PiWebSession, type AgentSession } from './agent-session.ts';
import {
  statusCard,
  confirmCard,
  lastReplyCard,
  agentsCard,
  progressCard,
} from '../feishu/cards.ts';
import { logger } from '../log.ts';

const log = logger('bridge');

export interface BridgeDeps {
  client: PiWebClient;
  channel: LarkChannel;
  registry: Registry;
  queues: QueueMap;
  pending: PendingApprovals;
  /** 本机器人 id（用于日志 / registry 文件命名）。 */
  botId: string;
  /** 是否为默认机器人（cwds 为空）。 */
  isDefault: boolean;
  /** 限定机器人声明的 cwd（已 resolve）；默认机器人为空数组。 */
  declaredCwds: string[];
  /** 全局所有限定机器人声明的 cwd 合集（供默认机器人排除）。 */
  scopedCwdsGlobal: string[];
  defaultModel?: { provider: string; modelId: string };
  allowOpenIds: string[];
  groupAllowlist: string[];
}

export class Bridge {
  private deps: BridgeDeps;
  private projectCache?: { at: number; data: ProjectInfo[] };
  private modelCache?: { at: number; data: ModelsEnabledResponse };
  /** 正在本进程流式推送的轮次：agentId → chatId。用于 /last 判定是否已在同一会话流式更新。 */
  private activeTurns = new Map<string, { chatId: string; cwd: string }>();

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    // 启动时清理不属于本机器人范围的旧绑定（配置变更后避免脏数据）
    this.pruneOutOfScope();
  }

  private get client() {
    return this.deps.client;
  }
  private get channel() {
    return this.deps.channel;
  }
  private get registry() {
    return this.deps.registry;
  }

  /** 会话级操作的统一入口：把 sid 绑成 AgentSession（项目级操作仍走 this.client）。 */
  private sessionFor(sessionId: string): AgentSession {
    return new PiWebSession(this.client, sessionId);
  }

  private async sendErr(chatId: string, msg: string): Promise<void> {
    await this.channel.send(chatId, { text: msg }).catch(() => {});
  }

  /** 发送卡片并记录 messageId → agent 路由（支持飞书回复定向）。 */
  private async sendRouteCard(
    chatId: string,
    card: object,
    cwd: string | undefined,
    agentId: string | undefined,
  ): Promise<void> {
    try {
      const r = await this.channel.send(chatId, { card });
      if (r?.messageId && cwd && agentId) this.registry.rememberRoute(r.messageId, cwd, agentId);
    } catch {
      /* 发送失败忽略 */
    }
  }

  /** 清理已回收（进程不在内存）的 agent 绑定。返回清理数。
   *  同时解绑指向该项目的会话，使其下次消息走「选择项目」提示而非默默新建。 */
  private async pruneDeadAgents(): Promise<number> {
    let n = 0;
    for (const e of this.registry.agentEntries()) {
      const st = await this.sessionFor(e.agentId).getState().catch(() => null);
      // 只清理真正无效的 agent（sid 不存在或已被删除）
      // 已回收的 agent（!running）还有历史消息，不应该清理
      if (!st) {
        this.registry.clearAgent(e.cwd);
        for (const c of this.registry.chatBindings()) {
          if (c.cwd === e.cwd) this.registry.unbindChat(c.chatId);
        }
        n++;
        log.info(`清理无效 agent ${e.agentId.slice(-6)} (cwd=${e.cwd})`);
      }
    }
    if (n) this.projectCache = undefined;
    return n;
  }

  /** 判断 cwd 是否属于本机器人的配置范围（配置级，不含 pi-web 动态存在性）。
   *  - 默认机器人：不在全局限定 cwd 合集中（即未被其他机器人声明）
   *  - 限定机器人：在本机器人 declaredCwds 中 */
  private isCwdInScope(cwd: string): boolean {
    if (this.deps.isDefault) return !this.deps.scopedCwdsGlobal.includes(cwd);
    return this.deps.declaredCwds.includes(cwd);
  }

  /** 启动时清理不属于本机器人范围的 registry 旧绑定（配置变更后避免脏数据）。
   *  仅按配置级范围判断：默认机器人剔除被限定机器人声明的 cwd；
   *  限定机器人剔除不在 declaredCwds 的 cwd。 */
  private pruneOutOfScope(): void {
    let n = 0;
    for (const e of this.registry.agentEntries()) {
      if (!this.isCwdInScope(e.cwd)) {
        this.registry.clearAgent(e.cwd);
        for (const c of this.registry.chatBindings()) {
          if (c.cwd === e.cwd) this.registry.unbindChat(c.chatId);
        }
        n++;
        log.info(`[bot=${this.deps.botId}] 清理范围外 agent cwd=${e.cwd.slice(-24)}`);
      }
    }
    if (n) log.info(`[bot=${this.deps.botId}] pruneOutOfScope 清理 ${n} 个范围外绑定`);
  }

  /** 发 /info 卡片。notice：卡片顶部提示条（与文本合并成一条消息）。 */
  private async sendInfoCard(chatId: string, notice?: string): Promise<void> {
    await this.pruneDeadAgents(); // 先清理已回收的再展示
    const projects = await this.getProjects(true);
    const cur = this.registry.projectOf(chatId);
    const agent = cur ? this.registry.getAgent(cur) : undefined;
    // 仅当有 agent 时才获取模型信息
    const curRef = agent?.agentId ? await this.currentModelRef(agent.agentId).catch(() => undefined) : undefined;
    const models = agent?.agentId ? await this.getModelsCached() : null;
    await this.sendRouteCard(
      chatId,
      statusCard({ currentCwd: cur, projects, currentModelRef: curRef, models, notice }),
      cur,
      agent?.agentId,
    );
  }

  // —— 项目枚举（带 30s 缓存，force 强制刷新）——
  private async getProjects(force = false): Promise<ProjectInfo[]> {
    if (!force && this.projectCache && Date.now() - this.projectCache.at < 30_000) {
      return this.projectCache.data;
    }
    try {
      const enumerated = await this.client.listProjects();
      const map = new Map<string, ProjectInfo>();
      for (const p of enumerated) {
        // 按本机器人范围过滤：默认机器人排除限定机器人声明的 cwd；限定机器人只留 declaredCwds
        if (!this.isCwdInScope(p.cwd)) continue;
        map.set(p.cwd, p);
      }
      // 回填桥接记录过的 agent（范围外的已在 pruneOutOfScope 清理）
      for (const a of this.registry.agentEntries()) {
        const p = map.get(a.cwd);
        if (p) {
          p.hasAgent = true;
          p.agentId = a.agentId;
        }
      }
      const rank = (p: ProjectInfo) => (p.busy ? 0 : p.running ? 1 : p.hasAgent ? 2 : 3);
      const arr = [...map.values()].sort(
        (a, b) => rank(a) - rank(b) || b.sessionCount - a.sessionCount,
      );
      this.projectCache = { at: Date.now(), data: arr };
      if (force) {
        log.info(
          `projects(force): ${arr.map((p) => `${p.label}:${p.busy ? 'busy' : p.running ? 'run' : p.hasAgent ? 'tracked' : 'idle'}`).join(' ')}`,
        );
      }
      return arr;
    } catch (e) {
      log.warn('枚举项目失败，回退到 declaredCwds', { e: String(e).slice(0, 120) });
      // 降级：限定机器人返回 declaredCwds 桩；默认机器人返回空（无 pi-web 无法枚举全集）
      if (this.deps.isDefault) return [];
      return this.deps.declaredCwds.map((cwd) => ({
        cwd,
        label: projectLabel(cwd),
        slug: '',
        sessionCount: 0,
        hasAgent: !!this.registry.getAgent(cwd),
        running: false,
        busy: false,
      }));
    }
  }

  private async getModelsCached(): Promise<ModelsEnabledResponse | null> {
    if (this.modelCache && Date.now() - this.modelCache.at < 300_000) return this.modelCache.data;
    const d = await this.client.getModels().catch(() => null);
    if (d) this.modelCache = { at: Date.now(), data: d };
    return d ?? null;
  }

  /** 指令帮助卡片。 */
  private helpCard(): object {
    const md = (content: string): object => ({ tag: 'markdown', content });
    const line = (cmd: string, desc: string) =>
      md(`\`${cmd}\`  ${desc}`);
    return {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '🤖 Pi 飞书桥接 · 指令帮助' },
        subtitle: { tag: 'plain_text', content: '输入 /指令 快速操作，直接发消息下发任务' },
        template: 'blue',
      },
      body: {
        elements: [
          md('**查询**'),
          line('/info', '项目空间 + 当前模型，可切换'),
          line('/last', '当前会话最后一条回复（带 agent 状态）'),
          line('/agents', '桥接记录的会话列表，点击切换'),
          md('**控制**'),
          line('/abort', '停止当前任务'),
          line('/release', '解绑当前项目（不打断任务，下次提示重选）'),
          line('/switch <项目>', '切换项目（支持 cwd / 名称）'),
          line('/model <provider/modelId>', '直接切模型；无参数时去 /info 卡片选'),
          md('**技巧**'),
          md('- 直接发消息 = 下发任务，完成后卡片带快速操作'),
          md('- **回复任意卡片** = 定向到那张卡片的项目/进程干活'),
          md('- 点击卡片里的下拉/按钮切换，比打字快'),
        ],
      },
    };
  }

  /** 入站消息。 */
  async onMessage(msg: NormalizedMessage): Promise<void> {
    log.info(`onMessage chat=${msg.chatId.slice(-6)} sender=${msg.senderId.slice(-6)} mentionedBot=${msg.mentionedBot} text=${msg.content.slice(0, 40)}`);
    if (this.deps.allowOpenIds.length && !this.deps.allowOpenIds.includes(msg.senderId)) {
      await this.channel.send(msg.chatId, { text: '⛔ 你不在操作白名单内' }).catch(() => {});
      return;
    }
    const text = msg.content.trim();
    if (text.startsWith('/')) return this.onCommand(msg, text);
    if (!text) return;

    // 「回复卡片」定向：若这条消息是对某张卡片的回复，自动切到那张卡片对应的项目/agent
    if (msg.replyToMessageId) {
      const route = this.registry.routeFor(msg.replyToMessageId);
      if (route) {
        // 检查该 agent 是否仍在会话管理集合中（release 后不允许回复）
        if (!this.registry.isAgentManaged(route.agentId)) {
          await this.sendInfoCard(msg.chatId, '⚠️ 该卡片对应的 Agent 已从会话管理中移除，请重新选择项目：');
          return;
        }
        const prev = this.registry.projectOf(msg.chatId);
        this.registry.bindProject(msg.chatId, route.cwd);
        log.info(
          `回复路由 replyTo=${msg.replyToMessageId.slice(-6)} → cwd=${route.cwd}（原=${prev ?? '无'}）`,
        );
      }
    }

    const cwd = this.ensureBinding(msg.chatId);
    if (!cwd) {
      // 未选择项目 → 发 info 卡片提醒用户选择（提示并进卡片顶部）
      await this.sendInfoCard(msg.chatId, '还没选择项目，请从下方「切换项目」下拉选一个：');
      return;
    }
    const project = (await this.getProjects()).find((p) => p.cwd === cwd);
    if (!project) {
      await this.sendErr(msg.chatId, `⚠️ 未找到项目 ${cwd}`);
      return;
    }
    const agentId = await this.ensureAgent(project.cwd, msg.chatId);
    if (!agentId) return;

    log.info(`chat=${msg.chatId.slice(-6)} project=${project.label} prompt=${text.length}字`);
    this.deps.queues.for(agentId).enqueue(() => {
      this.activeTurns.set(agentId, { chatId: msg.chatId, cwd: project.cwd });
      return this.executeTurn(msg.chatId, project.cwd, agentId, text, project.label)
        .then((r) => {
          log.info(`turn 完成 status=${r.status} 文本=${r.text.length}字 ${r.durationMs}ms`);
          // 记录卡片 → agent 路由，供飞书回复定向
          if (r.messageId) this.registry.rememberRoute(r.messageId, project.cwd, agentId);
          // 不再单发「完成/出错」消息：状态与错误已在答复卡片内（出错为红色头部）
        })
        .catch((e) => {
          log.error('turn 异常', e);
          this.sendErr(msg.chatId, `❌ 内部错误：${String(e).slice(0, 200)}`);
        })
        .finally(() => {
          this.activeTurns.delete(agentId);
        });
    });
  }

  /** 404 自愈：agent 失效时清除记录重建一次。 */
  private async executeTurn(
    chatId: string,
    cwd: string,
    agentId: string,
    text: string,
    label: string,
  ) {
    const runOnce = (aid: string) =>
      runTurn(this.channel, this.sessionFor(aid), chatId, text, this.deps.pending, label);
    try {
      return await runOnce(agentId);
    } catch (e) {
      if (e instanceof PiWebHttpError && (e.status === 404 || e.status === 502)) {
        log.warn(`agent ${agentId} 失效(${e.status})，清除并重建 (cwd=${cwd})`);
        this.registry.clearAgent(cwd);
        this.projectCache = undefined; // 失效缓存
        const fresh = await this.ensureAgent(cwd, chatId);
        if (fresh && fresh !== agentId) return await runOnce(fresh);
      }
      throw e;
    }
  }

  /** 卡片按钮/选择器回调。 */
  async onCardAction(evt: CardActionEvent): Promise<void> {
    const v = (evt.action.value ?? {}) as Record<string, unknown>;
    const cmd = String(v.cmd ?? '');
    // select_static：选中值在 action.option（字符串），回退 action.value
    const sel =
      typeof evt.action.option === 'string'
        ? evt.action.option
        : typeof v.value === 'string'
          ? v.value
          : '';
    log.info(
      `cardAction cmd=${cmd} tag=${evt.action.tag} sel=${sel.slice(0, 60)} chat=${evt.chatId.slice(-6)}`,
    );

    // 统一的 select 回调（前缀区分）
    if (cmd === 'select' && sel) {
      if (sel.startsWith('model:')) return this.handleSetModel(evt, sel.slice(6));
      if (sel.startsWith('project:')) return this.handleSwitch(evt, sel.slice(8));
    }
    // 兼容旧按钮
    if (cmd === 'setmodel') {
      const ref = String(v.ref ?? `${v.provider ?? ''}/${v.modelId ?? ''}`);
      return this.handleSetModel(evt, ref);
    }
    if (cmd === 'switch') {
      const cwd = String(v.cwd ?? '');
      if (cwd) return this.handleSwitch(evt, cwd);
      return;
    }
    if (cmd === 'approve' || cmd === 'reject') {
      const requestId = String(v.requestId ?? '');
      this.deps.pending.resolve(requestId, cmd === 'approve', v);
      return;
    }
    if (cmd === 'abort') {
      const cwd = this.registry.projectOf(evt.chatId);
      const agent = cwd ? this.registry.getAgent(cwd) : undefined;
      if (agent?.agentId) {
        await this.sessionFor(agent.agentId).abort().catch((e) => log.warn('abort 失败', { e: String(e) }));
        await this.channel.send(evt.chatId, { text: '⏹ 已请求停止' }).catch(() => {});
      } else {
        await this.channel.send(evt.chatId, { text: '已经移除的 Agent' }).catch(() => {});
      }
      return;
    }
    log.warn(`未知 cardAction cmd=${cmd}`);
  }

  private async handleSetModel(evt: CardActionEvent, ref: string): Promise<void> {
    // 「默认」= 不更换，保留当前模型
    if (ref === 'default') {
      await this.channel.updateCard(evt.messageId, confirmCard('✅ 保留当前模型，不更换')).catch(() => {});
      return;
    }
    const slash = ref.indexOf('/');
    if (slash <= 0) {
      await this.sendErr(evt.chatId, `⚠️ 模型格式错误：${ref}（需 provider/modelId）`);
      return;
    }
    const provider = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    const cwd = this.registry.projectOf(evt.chatId);
    const agent = cwd ? this.registry.getAgent(cwd) : undefined;
    if (!agent?.agentId) {
      await this.sendErr(evt.chatId, '已经移除的 Agent');
      return;
    }
    try {
      await this.sessionFor(agent.agentId).setModel(provider, modelId);
      // 更新 registry 中记录的模型信息
      this.registry.updateAgentModel(cwd!, ref);
      // 刷新为状态卡（显示新当前模型）
      const models = await this.getModelsCached();
      const projects = await this.getProjects(true);
      await this.channel
        .updateCard(evt.messageId, statusCard({ currentCwd: cwd, projects, currentModelRef: ref, models }))
        .catch(() => {});
    } catch (e) {
      await this.sendErr(evt.chatId, `❌ 切换失败：${String(e).slice(0, 200)}`);
    }
  }

  /** 切换项目（卡片回调 + /switch 指令共用）。
   *  1. 先判断是否已在会话管理中 → 直接绑定
   *  2. 不在 → 寻找已有 agentId 纳入会话管理（优先 running，然后非 running 历史）
   *  3. 未找到 → 更新项目列表让重新选择
   *  4. 找到 → 纳入 + 绑定 + 发送 last 卡片 */
  private async handleSwitch(evt: CardActionEvent, cwd: string): Promise<void> {
    // 防御性范围校验：配置级不允许的 cwd 拒绝绑定（下拉已过滤，这里防越界）
    if (!this.isCwdInScope(cwd)) {
      await this.sendErr(
        evt.chatId,
        `⚠️ 项目「${projectLabel(cwd)}」不在机器人 ${this.deps.botId} 的可绑定范围内`,
      );
      return;
    }
    this.registry.bindProject(evt.chatId, cwd);
    this.projectCache = undefined; // 强制刷新状态

    // 1. 先判断是否已在会话管理中
    const tracked = this.registry.getAgent(cwd);
    if (tracked?.agentId) {
      // 已在会话管理中 → 直接绑定，更新状态卡 + 发送 last 卡片
      const projects = await this.getProjects(true);
      const curRef = await this.currentModelRef(tracked.agentId).catch(() => undefined);
      const models = await this.getModelsCached();
      await this.channel
        .updateCard(evt.messageId, statusCard({ currentCwd: cwd, projects, currentModelRef: curRef, models }))
        .catch(() => {});
      // 已在会话管理中也要发送 last 卡片
      const st = await this.sessionFor(tracked.agentId).getState().catch(() => null);
      await this.sendContextSummary(evt.chatId, tracked.agentId, !!st?.running);
      return;
    }

    // 2. 不在会话管理中 → 寻找已有 agentId 纳入
    const found = await this.findExistingAgent(cwd).catch(() => undefined);
    if (!found) {
      // 3. 未找到 → 更新项目列表让重新选择
      const projects = await this.getProjects(true);
      const models = await this.getModelsCached();
      await this.channel
        .updateCard(
          evt.messageId,
          statusCard({
            currentCwd: undefined,
            projects,
            models,
            notice: `⚠️ 项目「${projectLabel(cwd)}」暂无可用 agent，请从下方选择一个有历史会话的项目`,
          }),
        )
        .catch(() => {});
      return;
    }

    // 4. 找到 → 纳入 + 绑定 + 发送 last 卡片
    const projects = await this.getProjects(true);
    const curRef = await this.currentModelRef(found.agentId).catch(() => undefined);
    const models = await this.getModelsCached();
    await this.channel
      .updateCard(evt.messageId, statusCard({ currentCwd: cwd, projects, currentModelRef: curRef, models }))
      .catch(() => {});
    // 发送 last 卡片便于理解上下文（直接传 sid，避免重复 findExistingAgent）
    await this.sendContextSummary(evt.chatId, found.agentId, found.running);
  }

  /** 获取 cwd 对应的 sid 和运行状态（不创建新 agent）。
   *  通过 findExistingAgent 查找，失败则返回 undefined。
   *  返回 { sid, running } 供调用方使用。 */
  private async resolveAgentId(cwd: string, chatId: string): Promise<{ sid: string; running: boolean } | undefined> {
    const found = await this.findExistingAgent(cwd).catch(() => undefined);
    if (!found) return undefined;
    return { sid: found.agentId, running: found.running };
  }

  /** 获取指定会话的最新一条文本（优先 assistant，其次 user 提问）。
   *  如果获取不到历史记录 → 说明 sid 无效 → 清除缓存重新查找。
   *  返回 { sid, running, text, modelRef }。 */
  private async fetchLatestReply(
    cwd: string,
    sid?: string,
    running?: boolean,
  ): Promise<{ sid?: string; running?: boolean; text: string; modelRef?: string }> {
    let currentSid = sid;
    let currentRunning = running;
    let text = '';
    let modelRef: string | undefined;

    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      if (!currentSid) break;
      let msgs: import('../piweb/types.ts').Message[] = [];
      let fetchError: unknown;
      try {
        msgs = (await this.sessionFor(currentSid).getContext(30)).context.messages;
        log.info(`[fetchLatestReply] attempt=${attempt} sid=${currentSid.slice(-6)} msgs=${msgs.length}`);
      } catch (e) {
        fetchError = e;
        log.warn(`[fetchLatestReply] attempt=${attempt} getSessionContext 失败：${String(e).slice(0, 100)}`);
      }

      // 获取不到历史记录（空或异常）→ sid 无效，清除缓存后重新查找
      if (msgs.length === 0) {
        if (attempt === 0) {
          log.warn(`[fetchLatestReply] sid=${currentSid.slice(-6)} 无历史记录${fetchError ? '（异常）' : ''}，重新查找`);
          this.registry.clearAgent(cwd);
          const found = await this.findExistingAgent(cwd);
          if (found && found.agentId !== currentSid) {
            currentSid = found.agentId;
            currentRunning = found.running;
            continue; // 用新 sid 重试
          }
        }
        break; // 找不到新的 sid，退出
      }

      // 优先找最后一条 assistant 文本
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== 'assistant') continue;
        const texts = m.content.filter((c) => c.type === 'text' && c.text);
        if (texts.length) {
          text = texts[texts.length - 1].text!;
          const prov = typeof m.provider === 'string' ? m.provider : undefined;
          const mdl = typeof m.model === 'string' ? m.model : undefined;
          modelRef = prov && mdl ? `${prov}/${mdl}` : mdl;
          break;
        }
      }
      // 没有 assistant 回复 → 取最后一条 user 提问
      if (!text) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== 'user') continue;
          const texts = m.content.filter((c) => c.type === 'text' && c.text);
          if (texts.length) {
            text = `💭 提问：${texts[texts.length - 1].text!}`;
            break;
          }
        }
      }
      if (!text) {
        log.warn(`[fetchLatestReply] 消息数=${msgs.length} 但没有文本内容`);
      }
    }

    return { sid: currentSid, running: currentRunning, text, modelRef };
  }

  /** 切会话/切项目后补发「当前上下文摘要」—— 与 /last 共用卡片样式。 */
  private async sendContextSummary(chatId: string, sid?: string, running?: boolean): Promise<void> {
    const cwd = this.registry.projectOf(chatId);
    if (!cwd) return;

    // 获取最新回复（内部含「无效则重新查找」逻辑）
    const r = await this.fetchLatestReply(cwd, sid, running);
    const finalSid = r.sid;
    const finalRunning = r.running;
    const text = r.text || (finalSid ? '（无历史记录）' : '（无记录）');
    const msgModelRef = r.modelRef;

    // 获取状态和模型信息
    const projects = await this.getProjects();
    const p = projects.find((x) => x.cwd === cwd);
    const label = p?.label ?? cwd;
    const state = p
      ? p.busy
        ? '🔴 运行中'
        : p.running
          ? '🟢 空闲'
          : p.hasAgent
            ? '⚪ 已回收'
            : '⚪ 无进程'
      : '?';

    let modelRef: string | undefined;
    if (finalSid) {
      const st = await this.sessionFor(finalSid).getState().catch(() => null);
      // agent 有进程活动 → 用当前配置的模型
      if (finalRunning || st?.running) {
        if (st?.state?.model) {
          modelRef = `${st.state.model.provider}/${st.state.model.id}`;
        }
      } else {
        // agent 不活动（已回收）→ 用消息本身的模型
        modelRef = msgModelRef;
      }
    }

    await this.channel
      .send(chatId, { card: lastReplyCard({ projectLabel: label, modelRef, state, text }) })
      .then((r2) => {
        if (r2?.messageId && finalSid) this.registry.rememberRoute(r2.messageId, cwd, finalSid);
      })
      .catch(() => {});
  }

  private ensureBinding(chatId: string): string {
    // 当前会话绑定的项目 cwd；无则返回空（由调用方发 /info 提示选择）
    return this.registry.projectOf(chatId) ?? '';
  }

  /** 查找已有 agent（不创建新 agent）。
   *  优先级：pi-web 最近修改的 session（保证有历史消息）→ registry 缓存
   *  返回 undefined 表示未找到任何已有 agent。 */
  private async findExistingAgent(cwd: string): Promise<{ agentId: string; running: boolean } | undefined> {
    // 1. 优先从 pi-web 获取该 cwd 的代表 session（最近修改的，保证有历史消息）
    const projects = await this.getProjects(true);
    const info = projects.find((p) => p.cwd === cwd);
    if (info?.activeSessionId) {
      const st = await this.sessionFor(info.activeSessionId).getState().catch(() => null);
      if (st) {
        // 采纳为会话管理中的 agent（覆盖 registry 中的错误缓存）
        this.registry.adoptAgent(cwd, info.activeSessionId);
        log.info(`采纳 agent ${info.activeSessionId} (cwd=${cwd}, running=${!!st.running})`);
        return { agentId: info.activeSessionId, running: !!st.running };
      }
    }

    // 2. pi-web 没有 → 查 registry 缓存（可能 pi-web 刚好没返回）
    const tracked = this.registry.getAgent(cwd);
    if (tracked?.agentId) {
      const st = await this.sessionFor(tracked.agentId).getState().catch(() => null);
      if (st) {
        log.info(`复用 registry agent ${tracked.agentId.slice(-6)} (cwd=${cwd}, running=${!!st.running})`);
        return { agentId: tracked.agentId, running: !!st.running };
      }
      // agentId 无效，清理
      log.warn(`[findExistingAgent] registry 中的 agentId ${tracked.agentId.slice(-6)} 已无效，清理`);
      this.registry.clearAgent(cwd);
    }

    return undefined;
  }

  /** 确保 agent 存在（用于消息处理流程，可以创建新 agent）。
   *  1. findExistingAgent → 复用已有
   *  2. 未找到 → POST /api/agent/new 创建
   */
  private async ensureAgent(cwd: string, chatId: string): Promise<string | undefined> {
    // 1. 先查找已有 agent
    const existing = await this.findExistingAgent(cwd).catch(() => undefined);
    if (existing) return existing.agentId;

    // 2. 未找到 → 创建新 agent（仅消息处理流程允许创建）
    try {
      const ensureCmd: Record<string, unknown> = { type: 'ensure_session' };
      if (this.deps.defaultModel) {
        ensureCmd.provider = this.deps.defaultModel.provider;
        ensureCmd.modelId = this.deps.defaultModel.modelId;
      }
      const created = await this.client.createAgent(cwd, ensureCmd as RpcCommand);
      if (!created.success) {
        await this.sendErr(chatId, `❌ 创建 agent 失败：${created.error ?? ''}`);
        return undefined;
      }
      this.registry.setAgent(cwd, created.sessionId);
      this.projectCache = undefined; // 新建后刷新
      log.info(`创建 agent ${created.sessionId} (cwd=${cwd})`);
      return created.sessionId;
    } catch (e) {
      await this.sendErr(chatId, `❌ 连接 Pi-Web 失败：${String(e).slice(0, 200)}`);
      return undefined;
    }
  }

  private async currentModelRef(agentId: string): Promise<string | undefined> {
    const s = await this.sessionFor(agentId).getState().catch(() => null);
    const m = s?.state?.model;
    if (m) return `${m.provider}/${m.id}`;
    return this.deps.defaultModel
      ? `${this.deps.defaultModel.provider}/${this.deps.defaultModel.modelId}`
      : undefined;
  }

  private async resolveCwd(token: string): Promise<string | undefined> {
    // 支持 cwd 直传、slug/名称 匹配
    const projects = await this.getProjects();
    const byCwd = projects.find((p) => p.cwd === token);
    if (byCwd) return byCwd.cwd;
    const bySlug = projects.find((p) => p.slug === token);
    if (bySlug) return bySlug.cwd;
    const byLabel = projects.find((p) => p.label === token);
    if (byLabel) return byLabel.cwd;
    return undefined;
  }

  private async onCommand(msg: NormalizedMessage, text: string): Promise<void> {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    const rest = args.join(' ');
    const reply = (s: string): Promise<void> =>
      this.channel.send(msg.chatId, { text: s }).then(
        () => undefined,
        () => undefined,
      );
    /** 卡片回执（内容丰富的场景，替代文本提示）。 */
    const replyCard = (card: object): Promise<void> =>
      this.channel.send(msg.chatId, { card }).then(
        () => undefined,
        () => undefined,
      );

    switch (cmd) {
      case 'help':
      case 'h': {
        await this.channel.send(msg.chatId, { card: this.helpCard() }).catch(() => {});
        break;
      }
      case 'info': {
        await this.sendInfoCard(msg.chatId);
        break;
      }
      case 'switch': {
        // 无参不做特判，统一落到「未知指令」→ help 卡
        if (!rest) return replyCard(this.helpCard());
        const cwd = await this.resolveCwd(rest);
        if (!cwd) {
          await this.sendInfoCard(msg.chatId, `没找到「${rest}」，可换个关键词，或从下方下拉选：`);
          break;
        }
        // 触发卡片回调逻辑（复用 handleSwitch）
        const fakeEvt: CardActionEvent = {
          chatId: msg.chatId,
          messageId: '',
          action: { tag: 'select_static', option: `project:${cwd}`, value: { cmd: 'select' } },
        } as CardActionEvent;
        await this.handleSwitch(fakeEvt, cwd);
        break;
      }
      case 'abort': {
        const cwd = this.registry.projectOf(msg.chatId);
        const agent = cwd ? this.registry.getAgent(cwd) : undefined;
        if (agent?.agentId) {
          await this.sessionFor(agent.agentId).abort().catch(() => {});
          await reply('⏹ 已请求停止');
        } else {
          await reply('已经移除的 Agent');
        }
        break;
      }
      case 'release': {
        const cwd = this.registry.projectOf(msg.chatId);
        if (!cwd) return reply('已经移除的 Agent');
        const agent = this.registry.getAgent(cwd);
        if (agent?.agentId) {
          // 清理路由记录 → 旧卡片回复不再生效
          const clearedRoutes = this.registry.clearRoutesByAgent(agent.agentId);
          log.info(`[release] 清理 ${clearedRoutes} 条路由记录 (agentId=${agent.agentId.slice(-6)})`);
          // 从会话管理中移除 + 解绑会话（不 abort）
          this.registry.clearAgent(cwd);
          this.registry.unbindChat(msg.chatId);
          this.projectCache = undefined;
          await this.sendInfoCard(
            msg.chatId,
            '✅ 已解绑（未打断任务）。旧卡片回复已失效，下次发消息请重新选择项目：',
          );
        } else {
          // 项目本身已无 agent 记录，直接解绑会话
          this.registry.unbindChat(msg.chatId);
          await this.sendInfoCard(
            msg.chatId,
            '✅ 已解绑。下次发消息请重新选择项目：',
          );
        }
        break;
      }
      case 'agents': {
        await this.pruneDeadAgents(); // 已回收的直接解绑，不再展示
        const entries = this.registry.agentEntries();
        const rows = await Promise.all(
          entries.map(async (e) => {
            const st = await this.sessionFor(e.agentId).getState().catch(() => null);
            const state = st?.running
              ? st.state?.isPromptRunning || st.state?.isStreaming
                ? '🔴 运行中'
                : '🟢 空闲'
              : '⚪ 已回收';
            return { cwd: e.cwd, label: projectLabel(e.cwd), agentId: e.agentId, state };
          }),
        );
        const cur = this.registry.projectOf(msg.chatId);
        await this.sendRouteCard(
          msg.chatId,
          agentsCard(rows, cur),
          cur,
          cur ? this.registry.getAgent(cur)?.agentId : undefined,
        );
        break;
      }
      case 'last': {
        const cwd = this.registry.projectOf(msg.chatId);
        if (!cwd) {
          // 未绑定 → 引导用户去 /info 选项目
          await this.sendInfoCard(msg.chatId, '当前会话未绑定项目，请从下方「切换项目」下拉选一个：');
          return;
        }
        // 通过 resolveAgentId 获取 sid + running（不创建新 agent）
        const result = await this.resolveAgentId(cwd, msg.chatId);
        if (!result) {
          await this.sendInfoCard(msg.chatId, '该项目暂无会话记录，可直接发一条消息让它开工：');
          return;
        }
        const sid = result.sid;
        try {
          const st0 = await this.sessionFor(sid).getState().catch(() => null);
          const busy = !!st0?.running && !!(st0.state?.isPromptRunning || st0.state?.isStreaming);
          if (busy) {
            const snapshot = await this.client.getLiveProgress(sid);
            const active = this.activeTurns.get(sid);
            // A. 本进程已在同一会话流式推送该轮次 → 不重复建卡，指向已有卡片
            if (active && active.chatId === msg.chatId) {
              await this.sendRouteCard(
                msg.chatId,
                progressCard({
                  projectLabel: projectLabel(cwd),
                  progress: snapshot,
                  notice: 'ℹ️ 本轮进展正在上方那张流式卡片上实时更新，完成后会自动显示结果。',
                }),
                cwd,
                sid,
              );
              return;
            }
            // B. 无本地流式卡片（任务由 pi-web/其他会话发起，或本进程重启过）
            //    → 挂接 SSE，建一张持续更新到结束的卡片
            log.info(`[bot=${this.deps.botId}] /last 挂接执行中轮次 sid=${sid.slice(-6)}`);
            void attachRunningTurn(
              this.channel,
              this.sessionFor(sid),
              msg.chatId,
              this.deps.pending,
              projectLabel(cwd),
              snapshot,
            )
              .then((r) => {
                log.info(`挂接轮次结束 status=${r.status} 文本=${r.text.length}字`);
                if (r.messageId) this.registry.rememberRoute(r.messageId, cwd, sid);
              })
              .catch((e) => log.warn(`挂接轮次失败：${String(e).slice(0, 120)}`));
            return;
          }
          // 获取最新回复（内部含「无效则重新查找」逻辑）
          const r = await this.fetchLatestReply(cwd, sid, result.running);
          const finalSid = r.sid ?? sid;
          const lastText = r.text || '（无历史记录）';
          const modelRef = r.modelRef;
          // 当前 agent 状态（空闲 / 工作中 / 已回收）
          const st = await this.sessionFor(finalSid).getState().catch(() => null);
          const state = st?.running
            ? st.state?.isPromptRunning || st.state?.isStreaming
              ? '🔴 工作中'
              : '🟢 空闲'
            : '⚪ 已回收';
          await this.sendRouteCard(
            msg.chatId,
            lastReplyCard({ projectLabel: projectLabel(cwd), modelRef, state, text: lastText }),
            cwd,
            finalSid,
          );
        } catch (e) {
          await reply(`❌ 查询失败：${String(e).slice(0, 200)}`);
        }
        break;
      }
      case 'model': {
        // 模型选择已合并到 /info；这里仅支持 /model provider/modelId 直接切
        // 无参不做特判，统一落到「未知指令」→ help 卡
        if (!rest) return replyCard(this.helpCard());
        const slash = rest.indexOf('/');
        if (slash <= 0) return reply('格式：/model provider/modelId');
        const provider = rest.slice(0, slash);
        const modelId = rest.slice(slash + 1);
        const cwd = this.registry.projectOf(msg.chatId);
        const agent = cwd ? this.registry.getAgent(cwd) : undefined;
        if (!agent?.agentId) return reply('已经移除的 Agent');
        await this.sessionFor(agent.agentId)
          .setModel(provider, modelId)
          .catch((e) => void reply(`❌ ${String(e).slice(0, 200)}`));
        await reply(`✅ 模型已设为 ${provider}/${modelId}（下一轮生效）`);
        break;
      }
      default:
        await replyCard(this.helpCard());
    }
  }
}
