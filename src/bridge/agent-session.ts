// 会话级抽象：把「与单个 agent 会话交互」的操作从 PiWebClient 里收拢出来（项目级操作仍留在 client）
import type { PiWebClient } from '../piweb/client.ts';
import { subscribeEvents } from '../piweb/events.ts';
import type { AgentStateResponse, PiWebEvent, SessionContextResponse } from '../piweb/types.ts';

export type SessionState = AgentStateResponse;
export type SessionContext = SessionContextResponse;
export type SessionEvent = PiWebEvent;

/** SSE 生命周期的可选回调（缺省则忽略）。 */
export interface SessionHooks {
  onReconnect?: (attempt: number) => void;
  onDisconnect?: (reason: 'error' | 'closed', err?: unknown) => void;
}

/** 一个 agent 会话：只管这一条 sid 的交互（getState/prompt/abort/setModel/getContext/onEvent）。
 *  项目级操作（listProjects / createAgent）不属于会话，故不在此接口内。 */
export interface AgentSession {
  /** 会话 id（pi-web 里 agentId === sessionId）。 */
  readonly sessionId: string;
  getState(): Promise<SessionState>;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  getContext(tail: number): Promise<SessionContext>;
  /** 订阅事件流，返回退订函数。 */
  onEvent(handler: (ev: SessionEvent) => void, hooks?: SessionHooks): () => void;
}

/** AgentSession 的 pi-web 实现：包一层 PiWebClient，隐去传输细节。 */
export class PiWebSession implements AgentSession {
  private readonly client: PiWebClient;
  readonly sessionId: string;

  constructor(client: PiWebClient, sessionId: string) {
    this.client = client;
    this.sessionId = sessionId;
  }

  getState(): Promise<SessionState> {
    return this.client.getState(this.sessionId);
  }

  async prompt(text: string): Promise<void> {
    await this.client.sendPrompt(this.sessionId, text);
  }

  async abort(): Promise<void> {
    await this.client.abort(this.sessionId);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.client.setModel(this.sessionId, provider, modelId);
  }

  getContext(tail: number): Promise<SessionContext> {
    return this.client.getSessionContext(this.sessionId, tail);
  }

  onEvent(handler: (ev: SessionEvent) => void, hooks?: SessionHooks): () => void {
    const sub = subscribeEvents(this.client, this.sessionId, { onEvent: handler, ...hooks });
    return () => sub.close();
  }
}