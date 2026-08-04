import type { TeamCommand } from "./domain.js";

/**
 * wait, finish, and claim mean "nothing more to do this turn" (invariant
 * 16 in CONTEXT.md); a model that keeps calling tools after one of them
 * just burns turn latency and risks the per-agent timeout.
 */
export function endsTurn(command: TeamCommand): boolean {
  return command.type === "wait" || command.type === "finish" || command.type === "claim";
}

export interface TurnApplyResult {
  /** Text to return to the model as the tool result. */
  text: string;
  /** True if the caller should now abort the session to stop further tool calls. */
  endsTurn: boolean;
}

const CLAIM_FENCE_TEXT =
  "blocked by pending claim: stop and wait for CLAIM_ACQUIRED or CLAIM_REJECTED";
const TURN_ENDED_TEXT =
  "turn already ended by a prior wait/finish/claim this response; stop calling tools";
const CLAIM_SOLE_ACTION_TEXT =
  "claim rejected locally: team_claim must be the only action in this response";

/**
 * The turn-ending protocol (CONTEXT.md invariant 16) as a pure state
 * machine: given a command, decide whether it's accepted, what text the
 * tool should return, and whether the turn is now over. No session, no
 * I/O — every one of pi-agent-team's seven custom tools funnels its
 * command through this single instance's apply(), so the invariant has
 * exactly one place it can be enforced or drift.
 */
export class TurnState {
  private commands: TeamCommand[] = [];
  private claimPending = false;
  private turnEnded = false;

  reset(): void {
    this.commands = [];
    this.claimPending = false;
    this.turnEnded = false;
  }

  get queued(): readonly TeamCommand[] {
    return this.commands;
  }

  apply(command: TeamCommand, confirmation: string): TurnApplyResult {
    if (this.claimPending) return { text: CLAIM_FENCE_TEXT, endsTurn: false };
    if (this.turnEnded) return { text: TURN_ENDED_TEXT, endsTurn: false };
    if (command.type === "claim" && this.commands.length > 0)
      return { text: CLAIM_SOLE_ACTION_TEXT, endsTurn: false };
    this.commands.push(command);
    const ends = endsTurn(command);
    if (command.type === "claim") this.claimPending = true;
    if (ends) this.turnEnded = true;
    return { text: confirmation, endsTurn: ends };
  }
}
