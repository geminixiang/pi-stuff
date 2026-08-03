export interface PiEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}
interface RpcReply<T> {
  success: boolean;
  data?: T;
  error?: string;
}
export interface SubagentCapabilities {
  protocolVersion: 2;
  operations: readonly ["ping", "spawn", "stop"];
  lifecycleEvents: false;
  durableStatus: false;
}

/** Process-local pi-subagents v2 event-bus RPC client. It is not a durable
 * adapter: requests and replies exist only in the current Pi process. It intentionally
 * exposes only ping/spawn/stop because the public RPC has no durable status, output,
 * or lifecycle subscription API. */
export class SubagentRpcClient {
  readonly capabilities: SubagentCapabilities = {
    protocolVersion: 2,
    operations: ["ping", "spawn", "stop"],
    lifecycleEvents: false,
    durableStatus: false,
  };
  private readonly events: PiEventBus;
  private readonly timeoutMs: number;
  constructor(events: PiEventBus, timeoutMs = 5_000) {
    this.events = events;
    this.timeoutMs = timeoutMs;
  }
  async ping(): Promise<{ version: number }> {
    const data = await this.call<{ version: number }>("ping", {});
    if (data.version !== 2) throw new Error(`Unsupported pi-subagents protocol: ${data.version}`);
    return data;
  }
  spawn(type: string, prompt: string, options?: Record<string, unknown>): Promise<{ id: string }> {
    return this.call("spawn", { type, prompt, options });
  }
  stop(agentId: string): Promise<void> {
    return this.call("stop", { agentId });
  }
  private call<T>(method: "ping" | "spawn" | "stop", params: Record<string, unknown>): Promise<T> {
    const requestId = crypto.randomUUID();
    const channel = `subagents:rpc:${method}`;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const unsubscribe = this.events.on(`${channel}:reply:${requestId}`, (raw) => {
        clearTimeout(timer);
        unsubscribe();
        const reply = raw as RpcReply<T>;
        if (!reply.success) reject(new Error(reply.error ?? "Subagent RPC failed"));
        else resolve(reply.data as T);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Subagent RPC ${method} timed out`));
      }, this.timeoutMs);
      this.events.emit(channel, { requestId, ...params });
    });
  }
}
