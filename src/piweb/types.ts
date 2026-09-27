// Pi-Web 接口与事件类型（实测核实，见 docs/VERIFIED.md）

export interface AgentState {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  model: { id: string; provider: string };
  messageCount: number;
  pendingMessageCount: number;
  queuedMessages: { steering: unknown[]; followUp: unknown[] };
  contextUsage: { percent: number; contextWindow: number; tokens: number };
  systemPrompt: string;
  thinkingLevel: string;
  extensionStatuses: unknown[];
  extensionWidgets: unknown[];
}
export interface AgentStateResponse {
  running: boolean;
  state: AgentState;
}

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  created: string;
  modified: string;
}
export interface SessionsResponse {
  sessions: SessionSummary[];
}
export interface SessionContextResponse {
  context: { messages: Message[] };
  tail: number;
  before: string | null;
}
export interface RunningResponse {
  sessionListVersion: number;
  runningSessionIds: string[];
  completionNotificationSuppressedSessionIds: string[];
}

/** 枚举出的项目空间（聚合自 /api/sessions + /api/agent/running）。 */
export interface ProjectInfo {
  cwd: string;
  label: string; // 显示名（basename）
  slug: string; // 稳定 id（basename slug）
  sessionCount: number; // 该 cwd 下的会话数
  hasAgent: boolean; // 桥接是否记录过 agentId
  running: boolean; // pi-web 内存里是否有活跃进程
  busy: boolean; // 是否正在执行 prompt/流式
  modelRef?: string; // 'provider/modelId'
  agentId?: string; // 桥接记录的 agentId
  activeSessionId?: string; // pi-web 里该 cwd 的活跃 session id
  modified?: string; // 最近会话修改时间
}
export interface NewAgentResponse {
  success: boolean;
  sessionId: string;
  data: unknown;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string;
  error?: string;
  code?: string;
}

// assistantMessageEvent.type（实测）
export type AssistantMessageEvent =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number }
  | { type: 'toolcall_start'; contentIndex: number; id: string; toolName: string }
  | { type: 'toolcall_delta'; contentIndex: number; id: string; toolName: string; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; id: string; toolName: string }
  | { type: string; [k: string]: unknown };

export interface Message {
  role: 'user' | 'assistant' | 'system' | string;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  timestamp: number;
  [k: string]: unknown;
}

/** 执行中的单次工具调用进展。 */
export interface ProgressStep {
  toolName: string;
  input?: unknown;
  resultText?: string;
  isError?: boolean;
}

/** 执行进展快照（由 getLiveProgress 从会话上下文实时拼装）。 */
export interface LiveProgress {
  prompt: string; // 本轮任务（最后一条 user 消息）
  startedAt: number; // 本轮起始时间戳（ms）
  elapsedMs: number; // 已执行时长
  steps: ProgressStep[]; // 工具调用进展
  currentText: string; // 最新一条 assistant 文本
}

// SSE 事件（实测，已修正）
export type PiWebEvent =
  | { type: 'connected'; sessionId: string; isStreaming: boolean }
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'agent_settled' }
  | { type: 'prompt_done' }
  | { type: 'turn_end' }
  | { type: 'message_start'; message: Message }
  | { type: 'message_end'; message: Message }
  | { type: 'message_update'; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'tool_execution_start'; [k: string]: unknown }
  | { type: 'tool_execution_update'; [k: string]: unknown }
  | { type: 'tool_execution_end'; [k: string]: unknown }
  | {
      type: 'extension_ui_request';
      id: string;
      method: 'confirm' | 'select' | 'input' | 'editor' | 'notify' | string;
      message?: string;
      notifyType?: string;
      [k: string]: unknown;
    }
  | { type: 'queue_update' | 'auto_retry_start' | 'auto_retry_end' | 'compaction_start' | 'compaction_end' | 'auto_compaction_end' | 'startup_error' | string; [k: string]: unknown };

export interface ModelInfo {
  id: string;
  name: string;
  ref: string;
  enabled: boolean;
}
export interface ModelsEnabledResponse {
  allEnabled: boolean;
  enabledTotal: number;
  availableTotal: number;
  providers: Array<{ id: string; name: string; kind: string; enabledCount: number; models: ModelInfo[] }>;
}

// RPC 命令（POST /api/agent/[id] body，实测透传）
export type RpcCommand =
  | { type: 'prompt'; message: string; requestMeta?: unknown }
  | { type: 'ensure_session' }
  | { type: 'get_state' }
  | { type: 'abort' }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'clear_queue' }
  | { type: 'compact' }
  | { type: 'extension_ui_response'; id: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };
