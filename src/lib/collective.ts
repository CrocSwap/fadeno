/**
 * The collective a map step assembles from its members' parts.
 *
 * One function owns the reduction so the engine that writes a collective and
 * the verifier that recomputes it can never disagree about what the bytes
 * should be: `fadeno drive` reduces the receipted parts through
 * `reduceCollective`, records the result, and `fadeno verify`
 * (`collective-provenance`) reduces the same parts again and refuses a
 * collective that does not come out identical. The engine did no thinking
 * here, so the verifier can redo all of it.
 */

/** Reduce member parts (already parsed) into the collective's exact bytes. */
export function reduceCollective(parts: readonly unknown[]): string {
  return `${JSON.stringify(parts, null, 2)}\n`;
}

