/**
 * The client → server input packet.
 *
 * One per simulation tick, and nothing else: the client never sends "I moved
 * my paddle to X", only "I would like my paddle at X". The server decides how
 * far it actually gets. See `movePaddle()` in the simulation.
 *
 * Flat primitives only — the input encoder rejects nested schemas — and
 * deliberately tiny: at 30 inputs/sec on mobile data, every byte is paid for
 * thirty times a second by both players.
 *
 * Declared with the `schema()` builder for the same toolchain reason as
 * `state.ts`; see the comment there.
 */

import { schema, t } from '@colyseus/schema';
import type { PongInput as PongInputShape } from '../types.js';

export const PongInput = schema(
  {
    /**
     * Desired paddle centre X, in field units.
     *
     * `float32` rather than `float64`: the field is 100 units wide, so float32
     * resolves it far finer than a finger can aim, at half the bytes. Both
     * sides use the same width, so this introduces no determinism hazard.
     */
    targetX: t.float32().default(0),
  },
  'PongInput',
);
export type PongInput = InstanceType<typeof PongInput>;

/** Compile-time proof the wire packet matches the simulation's input shape. */
type _AssertInput = PongInput extends PongInputShape ? true : never;
const _assertion: _AssertInput = true;
void _assertion;
