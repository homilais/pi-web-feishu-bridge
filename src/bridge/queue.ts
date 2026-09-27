// 单 agent 串行队列：同一会话同一时刻只处理一条指令（方案 2 硬约束）
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** 入队执行。前一个失败不影响后一个。 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }
}

/** 按 key 维护各自独立的串行队列。 */
export class QueueMap {
  private queues = new Map<string, SerialQueue>();

  for(key: string): SerialQueue {
    let q = this.queues.get(key);
    if (!q) {
      q = new SerialQueue();
      this.queues.set(key, q);
    }
    return q;
  }
}

// 审批请求的 pending 表：extension_ui_request 发出后等待 cardAction 回调
export interface ApprovalResult {
  approved: boolean;
  payload: Record<string, unknown>;
}

export class PendingApprovals {
  private map = new Map<string, { resolve: (v: ApprovalResult) => void }>();

  register(id: string, resolve: (v: ApprovalResult) => void): void {
    this.map.set(id, { resolve });
  }

  resolve(id: string, approved: boolean, payload: Record<string, unknown>): void {
    const e = this.map.get(id);
    if (e) {
      this.map.delete(id);
      e.resolve({ approved, payload });
    }
  }

  rejectAll(): void {
    for (const [, e] of this.map) e.resolve({ approved: false, payload: { rejected: true } });
    this.map.clear();
  }
}
