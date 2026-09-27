// 桥接编排：飞书消息/卡片动作 → 指令路由 → turn 调度
// v2: agent 按项目(cwd)共享复用；采纳 pi-web 已活跃进程；404 自愈
import type { LarkChannel, NormalizedMessage, CardActionEvent } from '@larksuiteoapi/node-sdk';
import type { PiWebClient } from '../piweb/client.ts';
import type { Registry } from './registry.ts';
import type { QueueMap, PendingApprovals } from './queue.ts';
import type { ProjectConfig } from '../config.ts';
import { projectLabel } from '../config.ts';
import type { ProjectInfo, RpcCommand, ModelsEnabledResponse } from '../piweb/types.ts';
import { PiWebHttpError } from '../piweb/client.ts';
import { runTurn } from './streamer.ts';
import {
  statusCard,
  confirmCard,
  lastReplyCard,
  agentsCard,
  progressCard,
  type TurnActions,
} from '../feishu/cards.ts';
import { logger } from '../log.ts';

const log = logger('bridge');

export interface BridgeDeps {
  client: PiWebClient;
  channel: LarkChannel;
  registry: Registry;
  queues: QueueMap;
  pending: PendingApprovals;
  /** 静态项目种子（.env PROJECTS），运行时与 pi-web 枚举合并。 */
  staticProjects: ProjectConfig[];
  defaultModel?: { provider: string; modelId: string };
  allowOpenIds: string[];
  groupAllowlist: string[];
}

export class Bridge {
  private deps: BridgeDeps;
  private projectCache?: { at: number; data: ProjectInfo[] };
  private modelCache?: { at: number; data: ModelsEnabledResponse };

  constructor(deps: BridgeDeps) {
    this.deps = deps;
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
      const st = await this.client.getState(e.agentId).catch(() => null);
      if (st && !st.running) {
        this.registry.clearAgent(e.cwd);
        for (const c of this.registry.chatBindings()) {
          if (c.cwd === e.cwd) this.registry.unbindChat(c.chatId);
        }
        n++;
        log.info(`清理已回收 agent ${e.agentId.slice(-6)} (cwd=${e.cwd})`);
      }
    }
    if (n) this.projectCache = undefined;
    return n;
  }

  /** 发送 info 卡片（项目 + 模型 + 切换下拉）。 */
  /** 发 /info 卡片。notice：卡片顶部提示条（与文本合并成一条消息）。 */
  private async sendInfoCard(chatId: string, notice?: string): Promise<void> {
    await this.pruneDeadAgents(); // 先清理已回收的再展示
    const projects = await this.getProjects(true);
    const cur = this.registry.projectOf(chatId);
    const agent = cur ? this.registry.getAgent(cur) : undefined;
    const curRef = agent?.agentId ? await this.currentModelRef(agent.agentId) : undefined;
    const models = await this.getModelsCached();
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
      for (const p of enumerated) map.set(p.cwd, p);
      // 合并静态种子（可能 pi-web 里尚无会话）
      for (const s of this.deps.staticProjects) {
        if (!map.has(s.cwd)) {
          map.set(s.cwd, {
            cwd: s.cwd,
            label: s.label,
            slug: s.id,
            sessionCount: 0,
            hasAgent: false,
            running: false,
            busy: false,
          });
        }
      }
      // 回填桥接记录过的 agent
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
      log.warn('枚举项目失败，回退到静态种子', { e: String(e).slice(0, 120) });
      return this.deps.staticProjects.map((s) => ({
        cwd: s.cwd,
        label: s.label,
        slug: s.id,
        sessionCount: 0,
        hasAgent: !!this.registry.getAgent(s.cwd),
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

    // 完成卡片只需 agentId（快速操作下拉已移到 /info）
    const actions: TurnActions = { agentId };

    log.info(`chat=${msg.chatId.slice(-6)} project=${project.label} prompt=${text.length}字`);
    this.deps.queues.for(agentId).enqueue(() =>
      this.executeTurn(msg.chatId, project.cwd, agentId, text, project.label, actions)
        .then((r) => {
          log.info(`turn 完成 status=${r.status} 文本=${r.text.length}字 ${r.durationMs}ms`);
          // 记录卡片 → agent 路由，供飞书回复定向
          if (r.messageId) this.registry.rememberRoute(r.messageId, project.cwd, agentId);
          // 不再单发「完成/出错」消息：状态与错误已在答复卡片内（出错为红色头部）
        })
        .catch((e) => {
          log.error('turn 异常', e);
          this.sendErr(msg.chatId, `❌ 内部错误：${String(e).slice(0, 200)}`);
        }),
    );
  }

  /** 404 自愈：agent 失效时清除记录重建一次。 */
  private async executeTurn(
    chatId: string,
    cwd: string,
    agentId: string,
    text: string,
    label: string,
    actions: TurnActions,
  ) {
    const runOnce = (aid: string) =>
      runTurn(this.channel, this.client, chatId, aid, text, this.deps.pending, label, actions);
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
        await this.client.abort(agent.agentId).catch((e) => log.warn('abort 失败', { e: String(e) }));
        await this.channel.send(evt.chatId, { text: '⏹ 已请求停止' }).catch(() => {});
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
      await this.sendErr(evt.chatId, '⚠️ 请先下发一条消息以创建 agent，再选模型');
      return;
    }
    try {
      await this.client.setModel(agent.agentId, provider, modelId);
      // 刷新为状态卡（显示新当前模型）
      const models = await this.getModelsCached();
      const projects = await this.getProjects(true);
      await this.channel
        .updateCard(evt.messageId, statusCard({ currentCwd: cwd, projects, currentModelRef: ref, models }))
        .catch(() => {});
      // 额外发一条上下文摘要，帮用户回忆现状以便后续指令
      await this.sendContextSummary(evt.chatId);
    } catch (e) {
      await this.sendErr(evt.chatId, `❌ 切换失败：${String(e).slice(0, 200)}`);
    }
  }

  private async handleSwitch(evt: CardActionEvent, cwd: string): Promise<void> {
    this.registry.bindProject(evt.chatId, cwd);
    const projects = await this.getProjects(true); // 强制刷新状态
    const cwd2 = this.registry.projectOf(evt.chatId);
    const agent = cwd2 ? this.registry.getAgent(cwd2) : undefined;
    const curRef = agent?.agentId ? await this.currentModelRef(agent.agentId) : undefined;
    const models = await this.getModelsCached();
    await this.channel
      .updateCard(evt.messageId, statusCard({ currentCwd: cwd2, projects, currentModelRef: curRef, models }))
      .catch(() => {});
    // 切项目后发上下文摘要，帮用户回忆新项目现状
    await this.sendContextSummary(evt.chatId);
  }

  /** 切会话/切项目后补发「当前上下文摘要」—— 与 /last 共用卡片样式。 */
  private async sendContextSummary(chatId: string): Promise<void> {
    const cwd = this.registry.projectOf(chatId);
    if (!cwd) return;
    const sid = this.registry.getAgent(cwd)?.agentId;
    const projects = await this.getProjects();
    const p = projects.find((x) => x.cwd === cwd);
    const label = p?.label ?? cwd;
    const state = p
      ? p.busy
        ? '🔴 运行中'
        : p.running
          ? '🟢 空闲'
          : p.hasAgent
            ? '🟡 可恢复'
            : '⚪ 无进程'
      : '?';

    // 当前模型（与 listProjects 一致：从 state.model 拼 ref）
    let modelRef: string | undefined;
    if (sid) {
      const st = await this.client.getState(sid).catch(() => null);
      if (st?.state?.model) {
        modelRef = `${st.state.model.provider}/${st.state.model.id}`;
      }
      // 执行中 → 进展卡（而不是过期的最后回复）
      if (st?.running && (st.state?.isPromptRunning || st.state?.isStreaming)) {
        const progress = await this.client.getLiveProgress(sid).catch(() => null);
        if (progress) {
          await this.sendRouteCard(
            chatId,
            progressCard({ projectLabel: label, progress }),
            cwd,
            sid,
          );
          return;
        }
      }
    }

    let text = '（暂无回复）';
    if (sid) {
      // 最多重试 2 次（切项目时 agent 可能尚未从磁盘加载完毕）
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const msgs = (await this.client.getSessionContext(sid, 30)).context.messages;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role !== 'assistant') continue;
            const texts = m.content.filter((c) => c.type === 'text' && c.text);
            if (texts.length) {
              text = texts[texts.length - 1].text!;
              break;
            }
          }
          if (text !== '（暂无回复）') break; // 找到了，退出
          if (msgs.length > 0 && attempt === 0) {
            // 有消息但没找到 assistant 文本，等 500ms 重试
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
        } catch (e) {
          if (attempt === 0) {
            log.warn(`getSessionContext 第 1 次失败，重试：${String(e).slice(0, 100)}`);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
    } else {
      // 没有 agentId，尝试 ensureAgent 创建一个（不阻塞，失败就跳过）
      const newSid = await this.ensureAgent(cwd, chatId).catch(() => undefined);
      if (newSid) {
        try {
          const msgs = (await this.client.getSessionContext(newSid, 30)).context.messages;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role !== 'assistant') continue;
            const texts = m.content.filter((c) => c.type === 'text' && c.text);
            if (texts.length) {
              text = texts[texts.length - 1].text!;
              break;
            }
          }
        } catch { /* 忽略 */ }
      }
    }

    await this.channel
      .send(chatId, { card: lastReplyCard({ projectLabel: label, modelRef, state, text }) })
      .then((r) => {
        if (r?.messageId && sid) this.registry.rememberRoute(r.messageId, cwd, sid);
      })
      .catch(() => {});
  }

  private ensureBinding(chatId: string): string {
    // 当前会话绑定的项目 cwd；无则取第一个静态种子
    let cwd = this.registry.projectOf(chatId);
    if (!cwd) {
      const seed = this.deps.staticProjects[0];
      cwd = seed?.cwd ?? '';
      if (cwd) this.registry.bindProject(chatId, cwd);
    }
    return cwd;
  }

  /**
   * 解析/创建 agent，三级策略（绝不无谓新建 session）：
   *  1. pi-web 内存里该 cwd 有活跃 session → 采纳（真正复用进程）
   *  2. 桥接记录过 agentId → 复用（进程可能不活，发 prompt 时 pi-web 自动从磁盘重建）
   *  3. 都没有 → POST /api/agent/new 创建
   */
  private async ensureAgent(cwd: string, chatId: string): Promise<string | undefined> {
    // 1. 采纳活跃进程
    const projects = await this.getProjects();
    const info = projects.find((p) => p.cwd === cwd);
    if (info?.activeSessionId && info.running) {
      const tracked = this.registry.getAgent(cwd);
      if (tracked?.agentId !== info.activeSessionId) {
        this.registry.adoptAgent(cwd, info.activeSessionId);
        log.info(`采纳活跃 agent ${info.activeSessionId} (cwd=${cwd})`);
      }
      return info.activeSessionId;
    }
    // 2. 复用记录
    const tracked = this.registry.getAgent(cwd);
    if (tracked?.agentId) return tracked.agentId;
    // 3. 创建
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
    const s = await this.client.getState(agentId).catch(() => null);
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
        this.registry.bindProject(msg.chatId, cwd);
        const projects = await this.getProjects(true);
        const agent = this.registry.getAgent(cwd);
        const curRef = agent?.agentId ? await this.currentModelRef(agent.agentId) : undefined;
        const models = await this.getModelsCached();
        await this.sendRouteCard(
          msg.chatId,
          statusCard({ currentCwd: cwd, projects, currentModelRef: curRef, models }),
          cwd,
          agent?.agentId,
        );
        break;
      }
      case 'abort': {
        const cwd = this.registry.projectOf(msg.chatId);
        const agent = cwd ? this.registry.getAgent(cwd) : undefined;
        if (agent?.agentId) {
          await this.client.abort(agent.agentId).catch(() => {});
          await reply('⏹ 已请求停止');
        } else {
          await reply('当前无活跃 agent');
        }
        break;
      }
      case 'release': {
        const cwd = this.registry.projectOf(msg.chatId);
        if (!cwd) return reply('当前无活跃 agent');
        const agent = this.registry.getAgent(cwd);
        if (agent?.agentId) {
          // 仅解绑（不 abort）：同时解绑会话 → 下次消息会提示重新选择项目
          this.registry.clearAgent(cwd);
          this.registry.unbindChat(msg.chatId);
          this.projectCache = undefined;
          await this.sendInfoCard(
            msg.chatId,
            '✅ 已解绑（未打断任务）。回复旧卡片仍可用原会话；下次发消息请重新选择项目：',
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
            const st = await this.client.getState(e.agentId).catch(() => null);
            const state = st?.running
              ? st.state?.isPromptRunning || st.state?.isStreaming
                ? '🔴 运行中'
                : '🟢 进程在'
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
          // 与 /last 一致：引导用户去 /info 选项目（卡片比文本好点）
          await this.sendInfoCard(msg.chatId, '当前会话未绑定项目，请从下方「切换项目」下拉选一个：');
          return;
        }
        const agent = this.registry.getAgent(cwd);
        let sid = agent?.agentId;
        if (!sid) {
          // 退而求其次：用该项目最近的 session
          const ps = await this.getProjects();
          sid = ps.find((p) => p.cwd === cwd)?.activeSessionId;
        }
        if (!sid) {
          await this.sendInfoCard(msg.chatId, '该项目暂无会话记录，可直接发一条消息让它开工：');
          return;
        }
        try {
          const st0 = await this.client.getState(sid).catch(() => null);
          const busy = !!st0?.running && !!(st0.state?.isPromptRunning || st0.state?.isStreaming);
          if (busy) {
            // 执行中 → 实时进展卡（数据来自 getSessionContext 的实时消息）
            const progress = await this.client.getLiveProgress(sid);
            await this.sendRouteCard(
              msg.chatId,
              progressCard({ projectLabel: projectLabel(cwd), progress }),
              cwd,
              sid,
            );
            return;
          }
          const ctx = await this.client.getSessionContext(sid, 30);
          const msgs = ctx.context.messages;
          let lastText: string | undefined;
          let modelRef: string | undefined;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role !== 'assistant') continue;
            const texts = m.content.filter((c) => c.type === 'text' && c.text);
            if (texts.length) {
              lastText = texts[texts.length - 1].text;
              const prov = typeof m.provider === 'string' ? m.provider : undefined;
              const mdl = typeof m.model === 'string' ? m.model : undefined;
              modelRef = prov && mdl ? `${prov}/${mdl}` : mdl;
              break;
            }
          }
          if (!lastText) return reply('（该会话暂无 assistant 文本回复，可能都是工具调用）');
          // 当前 agent 状态（空闲 / 工作中 / 已回收）
          const st = await this.client.getState(sid).catch(() => null);
          const state = st?.running
            ? st.state?.isPromptRunning || st.state?.isStreaming
              ? '🔴 工作中'
              : '🟢 空闲'
            : '⚪ 已回收';
          await this.sendRouteCard(
            msg.chatId,
            lastReplyCard({ projectLabel: projectLabel(cwd), modelRef, state, text: lastText }),
            cwd,
            sid,
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
        if (!agent?.agentId) return reply('请先下发一条消息以创建 agent');
        await this.client
          .setModel(agent.agentId, provider, modelId)
          .catch((e) => void reply(`❌ ${String(e).slice(0, 200)}`));
        await reply(`✅ 模型已设为 ${provider}/${modelId}（下一轮生效）`);
        break;
      }
      default:
        await replyCard(this.helpCard());
    }
  }
}
