/**
 * Literals the hook tests key on, imported from the source that owns them so
 * a reworded refusal or header cannot pass the tests by accident.
 */
export { CONTRACT_HEADER } from '../src/lib/contracts.ts';

/** The last sentence of every refusal a Fadeno hook writes (hook-lib.mjs `REPORT_REFUSAL`). */
export const REPORT_REFUSAL_SENTENCE = 'Report this refusal to the user instead of routing around it.';
