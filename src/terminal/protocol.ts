// 终端接入协议：桥接侧（server）与 pi 扩展（client）之间的报文格式。
// 方向：扩展主动外连 —— pi 没有入站端口，故桥接监听、扩展拨号。
// 拓扑：扩展 --POST register--> 桥接；扩展 <--SSE 持续下行-- 桥接；扩展 --POST events--> 桥接。
import type { PiWebEvent } from '../piweb/types.ts';

/** 扩展上报的会话信息（注册时一次）。 */
export interface TerminalSessionInfo {
  /** pi 会话 id（ctx.sessionManager.getSessionId()）。 */
  sessionId: string;
  /** 工作目录（ctx.sessionManager.getCwd()）。 */
  cwd: string;
  /** 会话显示名（便于在飞书里区分，可为 basename）。 */
  label?: string;
  /** 当前模型 ref，形如 provider/modelId。 */
  model?: string;
  /** 终端进程 pid，用于判活与展示。 */
  pid: number;
  /** 扩展版本，与桥接做兼容校验。 */
  version?: string;
}

/** 桥接 → 扩展 的下行命令（T2 只用到 prompt）。 */
export type TerminalCommand =
  | { type: 'prompt'; requestId: string; text: string }
  | { type: 'abort'; requestId: string }
  | { type: 'setModel'; requestId: string; provider: string; modelId: string }
  | { type: 'pullState'; requestId: string }
  /** 取消审批（发给扩展，转发给 pi 的审批通道）。 */
  | { type: 'resolveApproval'; requestId: string; approved: boolean };

/** 扩展 → 桥接 的上行批次。
 *  events 为一串 pi 事件，形状与桥接侧 TurnState 消费的一致（见 piweb/types.ts）。 */
export interface TerminalEventBatch {
  sessionId: string;
  /** 单调递增；桥接用它识别重连后的断层。 */
  seq: number;
  events: PiWebEvent[];
  /** 心跳时携带；供列表显示运行态。 */
  busy?: boolean;
}

export interface TerminalRegistryEntry {
  info: TerminalSessionInfo;
  connectedAt: number;
  lastSeenAt: number;
  /** 在线 = 下行 SSE 连接是否存活。 */
  online: boolean;
  /** 最近一次已知运行态。 */
  busy: boolean;
}

/** 扩展 → 桥接 的响应（对应 requestId，用于 pullState 等请求-响应）。 */
export interface TerminalResponse {
  sessionId: string;
  requestId: string;
  /** 会话历史条目（原样透出，由桥接解读）。 */
  entries?: unknown[];
  /** 当前模型 ref。 */
  model?: string;
  /** 是否空闲。 */
  idle?: boolean;
  ok?: boolean;
  error?: string;
}

/** 发现文件：扩展据此定位桥接的监听端口。 */
export interface BridgeDiscovery {
  port: number;
  pid: number;
  version: string;
}

/** 桥接发现的默认目录与文件名。 */
export const DISCOVERY_DIR = '.pi-bridge';
export const DISCOVERY_FILE = 'bridge.json';