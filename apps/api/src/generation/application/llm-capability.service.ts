import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { LLM_GATEWAY, type Capabilities, type LlmGateway } from './ports/llm-gateway.port';
import { TaskRegistry } from '../../bootstrap/task-registry';
import { sleepUnlessCancelled } from '../../shared/async/timeouts';
import { AppLogger, asError } from '../../shared/observability/app-logger';

/**
 * Finds out at boot whether the configured endpoint can do the two things this
 * system is built on, and keeps asking.
 *
 * `OPENAI_BASE_URL` points at whatever someone configured, and plenty of
 * OpenAI-compatible endpoints answer ordinary chat perfectly while ignoring
 * `tools` entirely. That failure is invisible until the first question, where it
 * looks like the model refusing to use the data — so it is worth one small call
 * to find out, and worth saying in words rather than as a stack trace.
 *
 * It reports; it does not gate. Readiness deliberately does not depend on it: a
 * third-party endpoint being down should not take the sign-in pages and the
 * history with it, and a generation that cannot run says so for itself.
 */

/** Slow, because what it watches is a configuration and an outage, not a queue. */
const RECHECK_INTERVAL_MS = 300_000;

@Injectable()
export class LlmCapabilityService implements OnApplicationBootstrap {
  private verdict: Capabilities | null = null;

  constructor(
    @Inject(LLM_GATEWAY) private readonly gateway: LlmGateway,
    private readonly tasks: TaskRegistry,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.tasks.spawn('llm-capability-check', async (signal) => {
      await this.loop(signal, RECHECK_INTERVAL_MS);
    });
  }

  /** The interval is a parameter so a test does not wait five minutes for the second look. */
  async loop(signal: AbortSignal, intervalMs: number): Promise<void> {
    /* eslint-disable no-await-in-loop -- one call at a time, spaced on purpose. */
    while (!signal.aborted) {
      await this.measure(signal);
      if (!(await sleepUnlessCancelled(intervalMs, signal))) return;
    }
    /* eslint-enable no-await-in-loop */
  }

  async measure(signal: AbortSignal): Promise<void> {
    const found = await this.ask(signal);
    const changed = found.usable !== this.verdict?.usable;
    this.verdict = found;
    if (!changed) return;

    if (found.usable) {
      this.logger.log('the model endpoint is usable', { task: 'llm-capability-check' });
      return;
    }
    // Every reason on its own line, because a person reading this is about to
    // change a variable and needs to know which one.
    for (const missing of found.missing) {
      this.logger.error(`the model endpoint cannot be used: ${missing}`, {
        task: 'llm-capability-check',
      });
    }
  }

  /**
   * The port says a verdict comes back rather than an exception, and the adapter
   * that exists honours that. This does not depend on it: a throw here would end
   * the loop, and a service whose whole job is to keep asking would stop asking
   * without anybody being told.
   */
  private async ask(signal: AbortSignal): Promise<Capabilities> {
    try {
      return await this.gateway.checkCapabilities(signal);
    } catch (error) {
      return { usable: false, missing: [asError(error).message], model: '' };
    }
  }

  /** `null` until the first call answers — which is not the same as unusable. */
  current(): Capabilities | null {
    return this.verdict;
  }

  /**
   * The name the endpoint answered with, for whoever has to put a price on a
   * question before it is asked. `null` until something has answered, and for
   * an endpoint that never says.
   */
  resolved(): string | null {
    const model = this.verdict?.model ?? '';

    return model === '' ? null : model;
  }
}
