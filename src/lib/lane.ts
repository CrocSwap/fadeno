/**
 * The delivery-lane predicate: host-vs-command on model AND effort.
 *
 * Pure, no I/O, and deliberately in `lib/` rather than in either command
 * that needs it. `steering resolve` and `dial resolve` must answer this
 * question identically — the steering hook routes on one of them and the
 * resolution echo explains the other — so a second implementation is a
 * correctness bug waiting to happen, not a duplication nit.
 *
 * See docs/experimental/slots-and-archetypes.md, "Effort decides the lane".
 */

/**
 * Where a delivery actually goes out. `restart_required` is the honest third
 * answer, not an error: the identity is deliverable, just not from here and
 * not through any declared command.
 */
export type DeliveryLane = 'host' | 'command' | 'restart_required';

/**
 * The session's own resolved reasoning effort.
 *
 * The Claude harness publishes `CLAUDE_EFFORT` to hook commands and to Bash,
 * already resolved past any silent per-model or per-org downgrade, and the
 * steering hook spawns this CLI with the ambient environment intact, so it
 * propagates. `null` means **unobservable** (a Codex broker, a bare shell),
 * never "the session has no effort" — and the lane predicate below treats it
 * as the absence of proof, which a pinned effort loses on.
 */
export function readSessionEffort(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = typeof env.CLAUDE_EFFORT === 'string' ? env.CLAUDE_EFFORT.trim() : '';
  return raw !== '' ? raw : null;
}

/**
 * Why a delivery landed on its lane — a CLOSED vocabulary, not free prose.
 *
 * It is interpolated into a user-facing deny message and written verbatim
 * into evidence rows, so `fadeno dispatches` must be able to GROUP on it.
 * Every member is lowercase and carries no trailing period, because it is
 * spliced into a sentence
 * (`worker -> luna@xhigh [command lane: session effort is medium, dial pins xhigh]`).
 * Exactly one member is parameterized, and only over the two efforts being
 * compared, so grouping still works on its shape.
 */
export type LaneReason =
  /** No pin: effort never forces the command lane. The common path. */
  | 'effort unpinned'
  /** Pinned, and the session is already running at it. */
  | 'session effort matches the pin'
  /** Pinned, and the host agent this session materialized carries that same pin. */
  | 'host agent pins the same effort'
  /** Pinned, but nothing can observe what the session runs at, so nothing can prove it. */
  | 'session effort unobserved'
  /** Pinned and contradicted by the session. */
  | `session effort is ${string}, dial pins ${string}`
  /** The model half of the predicate: this session cannot host the dialed model. */
  | 'model not deliverable in-host'
  /** Off the host lane with nowhere to go — always and only `restart_required`. */
  | 'no command fallback'
  /** A locked engine request: the run snapshot decided this, not the session. */
  | 'locked to the run snapshot'
  /** A selected shadow pair puts BOTH arms on the command lane so they are comparable. */
  | 'shadow pair forces the command lane';

/** The lane fields every resolution carries; the JSON contract a hook reads. */
export interface LaneDecision {
  /**
   * Did the *user* state an effort? Never "does the registry declare one" —
   * see the trap documented on `LaneInput.pinnedEffort`.
   */
  effort_pinned: boolean;
  /**
   * The effort this delivery runs at: the pin when there is one, else the
   * registry default.
   *
   * **Trustworthy only when `effort_pinned === true` OR `lane === 'command'`.**
   * On the host lane with an unpinned dial this is `models.<name>.effort` —
   * the COMMAND-lane default, the effort this delivery would run at if it
   * ever reached that lane — and the spawn does NOT run at it: it inherits
   * the session. A consumer in that case must read `session_effort` instead.
   * Reading this field unconditionally is quietly wrong, which is why the
   * rule lives here rather than in a doc.
   */
  effective_effort: string;
  /** The session's own resolved effort; `null` when unobservable. */
  session_effort: string | null;
  /**
   * **Contract guarantee, relied on without re-checking:** `'command'` is
   * emitted only when a command lane actually exists (`commandRoutable`).
   * A consumer may route to the dispatch proxy on this value alone. Violating
   * it sends a spawn to `fadeno dispatch` for a delivery the kernel has
   * nothing to invoke, where it dies on the `host_in_session` refusal — the
   * precise failure `shadow.routable` exists to prevent. When there is no
   * command lane the answer is `'restart_required'`, never `'command'`.
   */
  lane: DeliveryLane;
  lane_reason: LaneReason;
}

export interface LaneInput {
  /**
   * `CompiledDelivery.pinnedEffort` — exactly `ref.effort ?? null`, the
   * user's stated opinion.
   *
   * **This must never be `effectiveEffort`.** Every model in the shipped
   * catalog declares an `effort:`, so the effective value is set for
   * essentially every dial; comparing *it* against the session would send a
   * casual `fadeno dial worker opus` out of process in any session not
   * already running at that model's registry default — the exact inversion
   * this design exists to avoid. Only an explicit pin may move a delivery off
   * the host lane.
   */
  pinnedEffort: string | null;
  /** Reported to the caller, never compared. */
  effectiveEffort: string;
  /** From `readSessionEffort`; `null` = unobservable. */
  sessionEffort: string | null;
  /**
   * The MODEL half of the predicate, unchanged from before effort joined it:
   * can this session deliver the dialed model in-host at all?
   */
  hostModel: boolean;
  /**
   * Independent proof that the host surface itself carries the pin, for
   * harnesses that bake effort into the agent definition instead of
   * publishing it to the environment. Codex is exactly that: `steering apply
   * --codex` writes `model_reasoning_effort` into the agent TOML, and the
   * agent then identifies itself with the full `--host-executor luna@xhigh`
   * ref it was cut from — so a match there proves the effort as directly as
   * `CLAUDE_EFFORT` does, without the harness publishing anything.
   *
   * Only consulted when `sessionEffort` is `null`; an observed session effort
   * is the stronger evidence (it is already past any silent downgrade) and
   * always wins.
   */
  hostEffortProven?: boolean;
  /**
   * Is there anywhere to go when the host lane is refused? (`commandRoutable`)
   * This is what makes `lane: 'command'` safe to route on without re-checking.
   */
  commandLane: boolean;
}

/**
 * Host-vs-command on model **and** effort.
 *
 * The three states, per the design:
 *
 * | dial | `pinnedEffort` | lane |
 * |---|---|---|
 * | `opus@xhigh` | `'xhigh'` | host iff the session is provably `xhigh`, else command at `xhigh` |
 * | `opus`       | `null`    | host, inheriting the session |
 *
 * A dial with no pinned effort never leaves the session on effort grounds:
 * the cost of going out-of-process is paid only by a user who asked for
 * something specific. That is the common path, and it stays a single null
 * check.
 *
 * A pinned effort keeps the host lane only on PROOF that the host delivers
 * it — an observed session effort that matches, or a host agent materialized
 * from that very ref. Absent proof it takes the command lane, where the
 * effort is encoded in the argv and therefore guaranteed. Optimism is the
 * wrong default for a rule whose entire purpose is making effort
 * deterministic; this mirrors `shadow.routable`, which degrades safely rather
 * than hopefully.
 */
export function decideLane(input: LaneInput): LaneDecision {
  const { pinnedEffort, effectiveEffort, sessionEffort, hostModel, commandLane } = input;
  const base = {
    effort_pinned: pinnedEffort != null,
    effective_effort: effectiveEffort,
    session_effort: sessionEffort,
  };
  // The one place `lane` is allowed to become 'command', and it cannot do so
  // without `commandLane`. That is the whole of the contract guarantee.
  const offHost = (why: LaneReason): LaneDecision =>
    commandLane
      ? { ...base, lane: 'command', lane_reason: why }
      : { ...base, lane: 'restart_required', lane_reason: 'no command fallback' };
  // Model first, unchanged: a model this session cannot host leaves the host
  // lane whatever the effort says, and naming the effort too would bury the
  // reason that actually decided it.
  if (!hostModel) return offHost('model not deliverable in-host');
  if (pinnedEffort == null) {
    return { ...base, lane: 'host', lane_reason: 'effort unpinned' };
  }
  if (sessionEffort == null) {
    return input.hostEffortProven === true
      ? { ...base, lane: 'host', lane_reason: 'host agent pins the same effort' }
      : offHost('session effort unobserved');
  }
  if (sessionEffort === pinnedEffort) {
    return { ...base, lane: 'host', lane_reason: 'session effort matches the pin' };
  }
  return offHost(`session effort is ${sessionEffort}, dial pins ${pinnedEffort}`);
}
