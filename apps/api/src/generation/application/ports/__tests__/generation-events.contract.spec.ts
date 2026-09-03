import { generationEventsContract } from './generation-events.contract';
import { InMemoryGenerationEvents } from './in-memory-generation-events';

/**
 * The contract against the implementation that needs nothing installed. The
 * same suite runs against Redis in `generation-stream.int.spec.ts`, and the
 * point of running it twice is that neither run can quietly become the
 * definition of the port.
 */

generationEventsContract('in memory', () => new InMemoryGenerationEvents());
