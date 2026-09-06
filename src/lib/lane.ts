/**
 * The delivery-lane predicate: host-vs-command on model AND effort.
 *
 * Pure, no I/O, and deliberately in `lib/` rather than in either command
 * that needs it. `steering resolve`, `dial resolve` and `fadeno dispatch`'s
 * host-lane note must answer this question identically — the steering hook
 * routes on the first, the resolution echo explains the second, and the third
 * tells a caller which lane it is leaving — so a second implementation is a
 * correctness bug waiting to happen, not a duplication nit.
 *
 * A single implementation was never enough on its own. All four call sites did
 * call `decideLane`; they disagreed because they handed it different inputs
 * for the same question — `steering resolve` folded "and the caller is the
 * agent cut for this dial" into `hostModel`, and nobody else did. That half is
 * now `frame`, which is REQUIRED and derived by `hostFrameOf`, and a surface
 * that has to explain a route reads BOTH answers off one `explainLane` call.
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
  /**
   * The CATALOG half of the predicate: no host lane exists for this dial at
   * all — its harness is not this session's host, or that harness declares no
   * `host:`, or the host lane's eligibility forbids the archetype.
   *
   * A property of the dial and the ambient host, and of nothing else. It used
   * to double as the answer for "the caller is not the agent that could
   * deliver this", which is a fact about WHO ASKED — see `HostFrame`. A
   * preflight run from a shell therefore reported every host-deliverable model
   * as undeliverable, and a director who read it routed a whole campaign onto
   * the command lane.
   */
  | 'model not deliverable in-host'
  /**
   * The FRAME half: nobody said who is asking, so nothing can prove the caller
   * holds the host identity this delivery needs. Not a statement about the
   * model — `host_frame.in_agent_lane` says what a caller that DOES hold it
   * gets, and it is frequently `host`.
   */
  | 'the caller named no host executor'
  /** The FRAME half: the caller is a managed agent, cut for a different executor. */
  | 'the caller holds another host executor'
  /** Off the host lane with nowhere to go — always and only `restart_required`. */
  | 'no command fallback'
  /** A locked engine request: the run snapshot decided this, not the session. */
  | 'locked to the run snapshot'
  /** A selected shadow pair puts BOTH arms on the command lane so they are comparable. */
  | 'shadow pair forces the command lane';

/**
 * Whether the CALLER holds the host identity this delivery needs — the second
 * half of the host question, and the half that used to be silently folded into
 * `hostModel` by exactly one of the four call sites.
 *
 * The two halves answer different questions and have different remedies:
 *
 *   - `hostModel` is about the DIAL. "Is there a host lane for this at all?"
 *     Fixed by re-dialing onto the host's harness.
 *   - the frame is about the ASKER. "Can *you* deliver it in-host?" Fixed by
 *     asking from a managed agent — or by not asking about yourself at all,
 *     which is what a preflight is doing.
 *
 * On a harness that materializes a per-executor agent file whose identity a
 * spawn cannot override (Codex: `host.effort_channel: agent-file`, and the
 * file's `model` wins over any value passed at spawn time), the delivery needs
 * an agent cut for this dial, and the caller has to say whether it is one —
 * that is what `--host-executor` is. On a harness where the session's own hook
 * supplies the identity per spawn (Claude: `steering apply --claude` writes no
 * per-dial file at all), there is nothing to hold and no caller to identify.
 */
export type HostFrame =
  /**
   * The caller holds it: it is the managed agent cut for this executor, or the
   * dial needs no identity at all (the reference-frame-neutral base, which any
   * session delivers).
   */
  | 'held'
  /** The caller is a managed agent, and it was cut for some other executor. */
  | 'mismatched'
  /**
   * Nobody said. The question was asked from outside any managed host agent —
   * a shell preflight, `fadeno dispatch`, a coordinator's own `steering
   * resolve`. **Not** evidence that the host lane is unavailable, only that
   * this caller cannot be the one to take it.
   */
  | 'unstated';

/**
 * The frame one resolve was asked in, decided in ONE place so no surface can
 * answer it differently.
 *
 * `neutralIdentity` is for the dial that names no identity to hold — the
 * `current-host` sentinel the cascade falls through to — which any session
 * delivers and which therefore never needs a `--host-executor` to prove.
 */
export function hostFrameOf(input: {
  /** `--host-executor`, or null when the caller named none. */
  hostExecutor: string | null;
  /** The resolved dial, `formatDialRef`'d — what a managed agent bakes. */
  executor: string;
  /** The dial is the reference-frame-neutral base; no identity to hold. */
  neutralIdentity: boolean;
}): HostFrame {
  if (input.neutralIdentity) return 'held';
  if (input.hostExecutor == null) return 'unstated';
  return input.hostExecutor === input.executor ? 'held' : 'mismatched';
}

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
   * **Scope — narrower than it reads.** `'command'` means a command lane
   * EXISTS (`commandRoutable`), and nothing more. It is emitted only when one
   * does: when there is no command lane the answer is `'restart_required'`,
   * never `'command'`. That guarantee is real and consumers may rely on it.
   *
   * It is NOT a promise the dispatch would be accepted. Write posture and
   * eligibility are separate questions answered by separate predicates, and
   * both can refuse a delivery whose lane exists — so `lane: 'command'` and a
   * kernel refusal coexist perfectly well. This comment used to say "a
   * consumer may route to the dispatch proxy on this value alone", which was
   * an overpromise: route on `delivery.dispatchable` (dial resolve) or `mode`
   * (steering resolve), each of which folds in every conflict knowable at
   * resolve time. Two of the kernel's four refusal predicates are not knowable
   * here at all — `constraint_command` has to execute a policy, and
   * `provider_distinctness` needs input provenance a resolver never sees — so
   * no field on this object can promise a dispatch will be accepted.
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
   * The MODEL half of the predicate: can this session deliver the dialed model
   * in-host at all? `CompiledDelivery.hostCandidate` / `hostCandidateOf`, and
   * NOTHING else.
   *
   * Until 2026-09-06 `steering resolve` passed `hostCandidate && (the caller is
   * the agent cut for this dial)` here, and the other three call sites passed
   * `hostCandidate` alone. Both looked correct in isolation; together they were
   * two answers to one question. The caller half now travels as `frame`.
   */
  hostModel: boolean;
  /**
   * WHO IS ASKING. Required, so a call site cannot omit it and silently get the
   * optimistic answer — the omission is what produced the disagreement this
   * field exists to end. See `HostFrame`, and `hostFrameOf` for the one
   * derivation.
   */
  frame: HostFrame;
  /**
   * Independent proof that the host surface itself carries the pin, for
   * harnesses that bake effort into the agent definition instead of
   * publishing it to the environment. Codex is exactly that: `steering apply
   * --codex` writes `model_reasoning_effort` into the agent TOML, and the
   * agent then identifies itself with the full `--host-executor luna@xhigh`
   * ref it was cut from. The ref match identifies WHICH agent is asking; the
   * `model_reasoning_effort` in its file is the proof, and the caller must
   * read it — a file can carry the ref while pinning no effort at all.
   *
   * Only consulted when `sessionEffort` is `null`; an observed session effort
   * is the stronger evidence (it is already past any silent downgrade) and
   * always wins.
   */
  hostEffortProven?: boolean;
  /**
   * The same proof, minus the "and the caller is that agent" clause — the
   * agent FILE on disk carries the pin, whoever is asking. Read only by
   * `explainLane`, for the counterfactual: a preflight asking what a managed
   * agent would get must not answer "unproven effort" about proof that is
   * sitting in `~/.codex/agents/`. Defaults to `hostEffortProven`, so a caller
   * with no separate answer keeps the stricter one.
   */
  inAgentEffortProven?: boolean;
  /**
   * Is there anywhere to go when the host lane is refused? (`commandRoutable`)
   * This is what makes `lane: 'command'` safe to route on without re-checking.
   */
  commandLane: boolean;
}

/**
 * Both answers a route explanation needs, from ONE evaluation of the
 * predicate.
 *
 * The bug this shape closes: `fadeno dispatch` computed "is this host-lane
 * work?" and printed a NOTE asserting the host lane, while `steering resolve`
 * computed "can this caller deliver it in-host?" and answered `command` — two
 * surfaces, two `decideLane` calls with different inputs, contradicting each
 * other in the same minute. They are different questions and both are worth
 * answering; what is not allowed is each surface answering only one and
 * presenting it as the other.
 */
export interface LaneExplanation {
  /** The lane for the frame the caller is actually in. */
  decision: LaneDecision;
  /**
   * The lane a caller that HOLDS the host identity would get — same inputs,
   * `frame: 'held'`. When the frame is already held this is `decision` itself,
   * by identity rather than by agreement.
   */
  inAgent: LaneDecision;
}

/**
 * The single entry point for a surface that has to EXPLAIN a route rather than
 * just take one. `decideLane` remains for a caller that only routes.
 */
export function explainLane(input: LaneInput): LaneExplanation {
  const decision = decideLane(input);
  return {
    decision,
    inAgent:
      input.frame === 'held'
        ? decision
        : decideLane({
            ...input,
            frame: 'held',
            hostEffortProven: input.inAgentEffortProven ?? input.hostEffortProven,
          }),
  };
}

/**
 * Host-vs-command on model, **frame**, and effort, in that order.
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
  // reason that actually decided it. This is now the CATALOG fact alone —
  // `hostCandidateOf` — so an archetype that is genuinely command-lane (its
  // dial names a harness this session is not) still answers exactly what it
  // always did, and no frame can talk it back onto the host lane.
  if (!hostModel) return offHost('model not deliverable in-host');
  // Frame second, and only where the catalog said yes. Two answers, because
  // they have two remedies: a mismatched caller has the wrong agent for the
  // dial (re-cut it, or dial what the agent carries), while an unstated one
  // simply is not an agent — a shell preflight is not broken, it is asking
  // about somebody else. Naming either as a model problem is what sent a
  // five-lane campaign down the command lane.
  if (input.frame === 'mismatched') return offHost('the caller holds another host executor');
  if (input.frame === 'unstated') return offHost('the caller named no host executor');
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
