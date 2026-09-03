import type { ToolDefinition } from './llm-gateway.port';
import type { QueryOutcome } from './tool-outcome';

/**
 * A thing the model can call, and everything the runner knows about it.
 *
 * The runner never learns what any particular tool does. It sends the
 * definitions, waits for the model to name one, hands over the arguments as the
 * model wrote them, and puts what comes back in front of the gate. Adding a
 * second tool is therefore a provider and a file, not an edit to the loop —
 * which is the claim `CONTRIBUTING.md` makes and this port is what makes it true.
 *
 * Two things are deliberately the tool's own business:
 *
 * - **Its arguments.** They arrive as the JSON string the model produced, valid
 *   or not, and the tool parses them. A runner that knew one tool takes `sql`
 *   would have to learn what the next one takes.
 * - **Its failures.** Nothing here throws. A refusal is something the model
 *   reads and acts on, and an exception would end the generation instead.
 */
export interface AgentTool {
  /** What the model is told about it, in the provider-neutral shape. */
  readonly definition: ToolDefinition;
  execute(toolCallId: string, argumentsJson: string): Promise<QueryOutcome>;
}

/** Bound as an array. The first is the one that runs SQL; order is what is sent. */
export const AGENT_TOOLS = Symbol('AgentTools');
