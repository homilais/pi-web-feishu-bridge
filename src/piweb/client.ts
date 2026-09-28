import type {
  AgentStateResponse,
  LiveProgress,
  NewAgentResponse,
  ProgressStep,
  ProjectInfo,
  RpcCommand,
  RunningResponse,
  SessionContextResponse,
  SessionsResponse,
} from './types.ts';
import { existsSync } from 'node:fs';
import { projectSlug, projectLabel } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('piweb');

export class PiWebThrottleError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Pi-Web 节流，${retryAfter}s 后重试`);
    this.retryAfter = retryAfter;
  }
}
export class PiWebAuthError extends Error {
  constructor() {
    super('Pi-Web 鉴权失败（401）— 检查 PIWEB_PASSWORD，用户名须为 pi');
  }
}
export class PiWebHttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, body: string) {
    super(`Pi-Web HTTP ${status} @ ${path}: ${body.slice(0, 200)}`);
    this.status = status;
    this.path = path;
  }
}

export class PiWebClient {
  readonly baseUrl: string;
  readonly authHeader: string;

  constructor(baseUrl: string, password: string) {
    this.baseUrl = baseUrl;
    this.authHeader = 'Basic ' + Buffer.from('pi:' + password, 'utf8').toString('base64');
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { Authorization: this.authHeader, ...(init.headers ?? {}) },
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '5');
      throw new PiWebThrottleError(retry);
    }
    if (res.status === 401) throw new PiWebAuthError();
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PiWebHttpError(res.status, path, body);
    }
    const ct = res.headers.get('content-type') ?? '';
    return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
  }

  listSessions(): Promise<SessionsResponse> {
    return this.req('/api/sessions');
  }
  getRunning(): Promise<RunningResponse> {
    return this.req('/api/agent/running');
  }
  /** 带校验的 getRunning：pi-web 该端点偶发返回空数组（竞态），
   *  拿到空时短暂重试 2 次确认，避免误判「无进程」。 */
  async getRunningReliable(): Promise<RunningResponse> {
    let r = await this.getRunning();
    if (r.runningSessionIds.length === 0) {
      for (let i = 0; i < 2 && r.runningSessionIds.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 150));
        r = await this.getRunning();
      }
    }
    return r;
  }
  getState(agentId: string): Promise<AgentStateResponse> {
    return this.req(`/api/agent/${agentId}`);
  }
  /** 取会话上下文消息（默认尾部 30 条）。用于查询最后一条回复等。 */
  getSessionContext(sessionId: string, tail = 30): Promise<SessionContextResponse> {
    return this.req(`/api/sessions/${sessionId}/context?tail=${tail}`);
  }

  /** 实时执行进展。
   *  实测：执行中 `getSessionContext` 会返回尚未落盘的实时消息（assistant 流式文本 /
   *  toolCall / toolResult），所以能用它拼装「进展快照」。
   *  时间基线取最后一条 user 消息的 timestamp（即本轮 prompt 的发起时刻）。 */
  async getLiveProgress(sessionId: string, tail = 40): Promise<LiveProgress> {
    const res = await this.getSessionContext(sessionId, tail);
    const msgs = res.context.messages;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    const from = lastUserIdx >= 0 ? msgs[lastUserIdx] : undefined;
    const window = lastUserIdx >= 0 ? msgs.slice(lastUserIdx + 1) : msgs;

    let prompt = '';
    if (from) {
      prompt = from.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');
    }

    // 工具调用 → 结果，按 toolCallId 配对
    const calls = new Map<string, { name: string; input: unknown }>();
    const steps: ProgressStep[] = [];
    let currentText = '';
    for (const m of window) {
      if (m.role === 'assistant') {
        let text = '';
        for (const c of m.content) {
          if (c.type === 'text' && typeof c.text === 'string') text += c.text;
          else if (c.type === 'toolCall' && c.toolCallId) {
            calls.set(String(c.toolCallId), { name: String(c.toolName ?? 'tool'), input: c.input });
          }
        }
        if (text) currentText = text;
      } else if (m.role === 'toolResult') {
        const id = String(m.toolCallId ?? '');
        const call = calls.get(id);
        const resultText = m.content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('\n');
        steps.push({
          toolName: String(m.toolName ?? call?.name ?? 'tool'),
          input: call?.input,
          resultText,
          isError: m.isError === true,
        });
      }
    }

    return {
      prompt,
      startedAt: from?.timestamp ?? 0,
      elapsedMs: from?.timestamp ? Math.max(0, Date.now() - from.timestamp) : 0,
      steps,
      currentText,
    };
  }

  /** 创建 agent 会话。command 默认 ensure_session（仅加载不发送）。 */
  createAgent(cwd: string, command: RpcCommand = { type: 'ensure_session' }): Promise<NewAgentResponse> {
    const body = JSON.stringify({ cwd, ...command });
    return this.req('/api/agent/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  /** 直接发送 RPC 命令（POST /api/agent/[id]，body 透传给 pi）。 */
  send(agentId: string, command: RpcCommand): Promise<{ success: boolean; data: unknown }> {
    return this.req(`/api/agent/${agentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
  }

  /** SSE 订阅（返回 Response，调用方自行读取 body）。 */
  async sse(agentId: string, signal: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/api/agent/${agentId}/events`, {
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    return res;
  }

  sendPrompt(agentId: string, message: string) {
    return this.send(agentId, { type: 'prompt', message });
  }
  abort(agentId: string) {
    return this.send(agentId, { type: 'abort' });
  }
  steer(agentId: string, message: string) {
    return this.send(agentId, { type: 'steer', message });
  }
  followUp(agentId: string, message: string) {
    return this.send(agentId, { type: 'follow_up', message });
  }
  setModel(agentId: string, provider: string, modelId: string) {
    return this.send(agentId, { type: 'set_model', provider, modelId });
  }
  clearQueue(agentId: string) {
    return this.send(agentId, { type: 'clear_queue' });
  }
  respondExtensionUi(agentId: string, requestId: string, payload: Record<string, unknown>) {
    return this.send(agentId, { type: 'extension_ui_response', id: requestId, ...payload });
  }

  /** 获取已启用的模型列表（按 provider 分组）。 */
  getModels(): Promise<import('./types.ts').ModelsEnabledResponse> {
    return this.req('/api/models/enabled');
  }

  /** 枚举所有项目空间（聚合 /api/sessions + 逐项目 getState）。
   *  关键修正：runningSessionIds 只含「正在跑任务」的，不含空闲进程。
   *  所以「有无进程」必须用 GET /api/agent/{id}.running（isAlive）判断，
   *  不能用 runningSessionIds。每个 cwd 取一个代表 session 查。 */
  async listProjects(): Promise<ProjectInfo[]> {
    const sess = await this.listSessions();
    // running 的 session（优先选为代表）
    const runningIds = new Set(
      (await this.getRunningReliable().catch(() => null))?.runningSessionIds ?? [],
    );
    // 每个 cwd 取一个代表 session：优先 running，其次最近修改的
    const byCwd = new Map<
      string,
      { count: number; rep?: { id: string; modified: string; running: boolean } }
    >();
    for (const s of sess.sessions) {
      const e = byCwd.get(s.cwd) ?? { count: 0 };
      e.count++;
      const isRunning = runningIds.has(s.id);
      if (
        !e.rep ||
        (isRunning && !e.rep.running) ||
        (isRunning === e.rep.running && s.modified > e.rep.modified)
      ) {
        e.rep = { id: s.id, modified: s.modified, running: isRunning };
      }
      byCwd.set(s.cwd, e);
    }
    const out: ProjectInfo[] = [];
    for (const [cwd, e] of byCwd) {
      // 目录已删除/改名 → session 文件成了孤儿，跳过（避免 /info 出现不可用的幽灵项目）
      if (!existsSync(cwd)) {
        log.debug(`跳过孤儿会话目录：${cwd}`);
        continue;
      }
      out.push({
        cwd,
        label: projectLabel(cwd),
        slug: projectSlug(cwd),
        sessionCount: e.count,
        hasAgent: false,
        running: false,
        busy: false,
        activeSessionId: e.rep?.id,
        modified: e.rep?.modified,
      });
    }
    // 逐项目查代表 session 的 isAlive（进程在不在）+ isPromptRunning（忙不忙）
    await Promise.all(
      out
        .filter((p) => p.activeSessionId)
        .map(async (p) => {
          try {
            const st = await this.getState(p.activeSessionId as string);
            // running = isAlive（进程在内存，即使空闲）
            p.running = !!st.running;
            p.busy = !!(st.running && st.state && (st.state.isPromptRunning || st.state.isStreaming));
            p.modelRef =
              st.running && st.state && st.state.model
                ? `${st.state.model.provider}/${st.state.model.id}`
                : undefined;
          } catch {
            /* 查询失败不影响枚举 */
          }
        }),
    );
    const rank = (p: ProjectInfo) => (p.busy ? 0 : p.running ? 1 : 2);
    out.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.sessionCount - a.sessionCount ||
        (b.modified ?? '').localeCompare(a.modified ?? ''),
    );
    return out;
  }

  /** 续期会话租约（仅 POST）。返回 {success, renewed}。 */
  renewLease(agentId: string): Promise<{ success: boolean; renewed: number }> {
    return this.req(`/api/agent/${agentId}/lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }
}

/** 带节流感知的调用包装：遇 429 自动等待后重试。 */
export async function withThrottleRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e instanceof PiWebThrottleError && i < maxRetries) {
        log.warn(`节流，${e.retryAfter}s 后重试 (${i + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, (e.retryAfter + 0.5) * 1000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
