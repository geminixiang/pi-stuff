import type { TeamAgent, TeamCommand, TeamMember, TeamTurn } from "../../src/domain.js";

export abstract class IsolatedAgent implements TeamAgent {
  readonly sessionId = crypto.randomUUID();
  readonly seen: TeamTurn[] = [];
  constructor(
    readonly member: TeamMember,
    readonly canary: string,
  ) {}
  async act(turn: TeamTurn, signal: AbortSignal): Promise<readonly TeamCommand[]> {
    if (signal.aborted) throw signal.reason;
    this.seen.push(structuredClone(turn));
    return this.decide(turn);
  }
  protected abstract decide(turn: TeamTurn): readonly TeamCommand[];
}
