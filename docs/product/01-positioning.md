# Fadeno — Audience & Positioning Brief

> Working doc. Purpose: resolve the open "who is this for?" question and set the foundation for naming, messaging, README, and GTM. Everything downstream should trace back to a decision here.

## TL;DR recommendation

**Lead with the individual developer using Codex or Claude Code. Build the on-ramp to teams. Treat "protocol/standard" as the destination, not the launch.**

- **Beachhead (launch):** solo devs and OSS tinkerers who already feel the pain of babysitting their coding agent — re-typing "plan first, review your work, run the tests" every session and getting inconsistent results.
- **Expansion (where the deep value lives):** engineering teams who want every agent-driven change to go through the *same* inspectable, reviewable, testable discipline — committed to the repo, portable across tools.
- **Endgame (the vision, not the pitch):** Fadeno as a portable playbook *protocol* that other tools and runtimes adopt.

The strategic tension to hold: the **adoption motion is individual-dev-shaped**, but the **deepest differentiation is team-shaped** (portability, inspectable run traces, gate discipline, CI-enforced approvals). The brand should hook the individual and let the team value show through — not lead with governance language that bounces off a solo dev on Hacker News.

## The three candidate audiences, scored

### A. Individual devs / OSS tinkerers
- **Pain acuteness:** High and *frequent*. Every nontrivial agent run, they re-type careful-mode instructions and still get sloppy output. This is a daily papercut.
- **Value of Fadeno's core bets:** Medium. "Use the code-change-review playbook" instead of a paragraph of instructions is an immediate win. But the *committed/shared/portable* angle matters less to a party of one — a solo dev can keep a prompt snippet.
- **Adoption friction:** Lowest. `npx fadeno init`, commit, done. No buy-in needed.
- **Distribution value:** Highest. This is who finds it on GitHub/HN, stars it, writes the blog post, and gives the project credibility and momentum. OSS dev tools live or die on this crowd.
- **Risk:** Shallow value capture. They may star and not stick if the "why commit this" story isn't sticky.

### B. Engineering teams / tech leads
- **Pain acuteness:** High but *less frequent per person* — it's a team-consistency and trust problem, not a daily papercut. "Every dev's agent behaves differently; nobody trusts agent PRs; review is inconsistent."
- **Value of Fadeno's core bets:** Highest. Repo-native + committed + inspectable run ledger + portable across mixed toolchains + gates wired to CI = exactly their problem. This is where Fadeno's differentiation is *uniquely* valuable, not just convenient.
- **Adoption friction:** Higher. Needs a champion, a "let's standardize on this" moment, and tolerance for v0's honesty that tier-1 enforcement is advisory.
- **Distribution value:** Medium. Teams adopt after the tool already has signal; they rarely discover it cold.
- **Risk:** v0's advisory enforcement may underwhelm a team that wants *guarantees* on day one. The README's tier-1/tier-2 honesty is a feature here, but the gap must be framed as "wire it to your CI" not "it doesn't really enforce."

### C. Platform / AI-tooling builders
- **Pain acuteness:** Conceptual, not visceral. They'd adopt Fadeno as a protocol — but only once it has gravity.
- **Value of core bets:** High *in theory* (harness-neutral protocol is the whole pitch to them).
- **Adoption friction:** Highest — classic chicken-and-egg. Nobody standardizes on a protocol with no users.
- **Distribution value:** Low at launch, enormous later.
- **Verdict:** Premature as a launch audience. This is the flag you plant *after* A and B give you a user base. Keep the architecture honest to this future (it already is — harness-neutral, schema-first), but don't market to it yet.

## Recommended strategy: beachhead → expansion → standard

```
Phase 1 (launch)        Phase 2 (land teams)       Phase 3 (become a standard)
Individual devs    →    Eng teams / tech leads  →  Platform / tooling builders
"stop babysitting       "one reviewed, inspectable  "the portable playbook
 your agent"            workflow for every change"   protocol agents speak"
```

Why this order and not "go straight for teams":
1. **OSS dev tools need the individual-dev flywheel first.** Stars, HN front page, "I tried this" posts. Teams adopt tools that already have signal.
2. **The individual-dev pain is more visceral and easier to demo** in 30 seconds. Team value ("inspectable, governed, portable") is real but takes a paragraph to land — bad for a cold first impression.
3. **The expansion is natural, not a pivot.** The same artifact a solo dev installs (`code-change-review.yaml`) is the thing a team standardizes on. Nothing has to be rebuilt to move from A to B — the committed-to-repo design *is* the bridge.

## Core problem narrative

> Coding agents are powerful but inconsistent. Every nontrivial task, you re-explain the same discipline — "make a plan, review your own work, run the tests, don't do anything destructive without asking." You get different behavior every run, no record of what the agent actually did, and instructions that don't carry over when you switch from Codex to Claude Code. There's no repeatable, inspectable way to say *how* you want agent work done.

Fadeno's answer, in one line:

> **Define the workflow once, commit it to the repo, and any agent runs it the same way — with a file-backed trace of what happened.**

## Positioning statement

> **For** developers and teams using AI coding agents
> **who** want repeatable, inspectable, reviewable agent workflows instead of re-typing careful-mode instructions every run,
> **Fadeno** is a repo-native playbook layer
> **that** turns multi-step agent work (plan → implement → review → test → revise) into committed YAML playbooks any agent can run, with file-backed run traces and gate discipline.
> **Unlike** heavyweight orchestration runtimes (LangGraph, Temporal) or one-off prompt snippets,
> **Fadeno** needs no runtime, lives in your repo, and is portable across Codex and Claude Code — pushing hard enforcement down to the git/CI layer where it's real and tool-agnostic.

## Value props, by audience

**Individual dev (lead with these):**
1. Stop re-typing "be careful, plan, review, test" — say *"use the code-change-review playbook."*
2. Get the same disciplined behavior every run, not agent-roulette.
3. A readable trace of what the agent actually did (`.fadeno/runs/`), not a vanished chat.
4. Two-second install, no runtime, no service: `npx fadeno init`.

**Team / tech lead (the expansion):**
1. One reviewed, version-controlled workflow every change goes through — agent work becomes inspectable and auditable.
2. Portable across your mixed toolchain (Codex *and* Claude Code) — the workflow isn't hostage to one vendor.
3. Real enforcement where it counts: wire approval gates to pre-commit/CI so guarantees survive both agent *and* human mistakes.
4. Customizable, shareable playbooks — encode your team's actual review standards, don't hope each dev remembers them.

**Platform builder (later):**
1. A harness-neutral, schema-validated playbook format — the same playbooks run on instruction-only hosts today and compile to a real runtime tomorrow.

## Competitive framing

| Alternative | What it is | Why Fadeno is different |
|---|---|---|
| **Raw careful-mode prompting** | Re-typing "plan, review, test" each run | Repeatable, committed, inspectable; not lost when the chat closes |
| **Prompt snippets / saved prompts** | Personal text you paste | Versioned in the repo, shared across a team, structured (gates/loops/roles), portable across harnesses |
| **LangGraph / Temporal / custom runtimes** | Heavyweight orchestration engines | No runtime, no service, no rewrite — files + schemas in your repo; enforcement pushed to CI, not a daemon |
| **Harness-native subagents alone** | Codex/Claude subagent configs | Fadeno is the *portable recipe* on top; uses native subagents when present, degrades gracefully when not, and isn't locked to one vendor's format |

The honest line we must keep (per the kickoff memo): in instruction-only hosts, approval policies are **advisory** — the agent is *asked* to honor them. For hard guarantees, gates wire to pre-commit/CI (or Claude Code hooks). This honesty is a *trust asset* with the dev/team audience, not a weakness to hide.

## Confirmed direction (resolved with Doug)
1. **Individual-dev beachhead → team expansion is confirmed.** This is the spine of all downstream work.
2. **No design partner.** Don't over-optimize the team narrative for a specific account; keep it as the natural expansion, not the launch pitch.
3. **No hard constraints, and crucially: this is not a full-time, well-backed project.** Adoption has to be **guerilla and word-of-mouth**. This is a hard design input, not a footnote:
   - **Name** must be trivially easy to say, spell, and search — word-of-mouth dies on "wait, how do you spell that?"
   - **Messaging** must be demoable in seconds and *shareable* — the unit of growth is "I tried this, here's the one-liner," not a sales deck.
   - **The artifact itself must be the marketing.** A committed `code-change-review.yaml` that a teammate sees in a repo, or a run trace someone screenshots, has to sell itself.
   - **No paid distribution, no sales motion.** Channels are GitHub, HN/Show HN, dev Twitter/Bluesky, Reddit, and the project's own README. Lean into honesty and craft (the tier-1/tier-2 candor is a trust asset that travels well in this crowd).
   - **Low maintenance burden matters for credibility.** A guerilla project must look alive; scope and cadence should be sustainable for a part-time maintainer.
