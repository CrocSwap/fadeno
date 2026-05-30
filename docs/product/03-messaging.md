# Fadeno — Messaging & Value Props

> Working doc. Builds on `01-positioning.md` and `02-brand-identity.md`. This is the message library: pitches at every length, value props, objection handling, and competitive framing. Pull from here when writing the README, social posts, HN comments, and docs. Keep it in the brand voice: honest, precise, low-hype, dry.

## The message in one breath

> Fadeno turns "Codex, please plan, review your work, and run the tests" into "use the code-change-review playbook" — a workflow you define once, commit to your repo, and any agent runs the same way, with a trace of what it actually did.

## Pitches by length

**5 words:** The playbook layer for agents.

**One sentence:** Fadeno is a repo-native playbook layer that turns multi-step AI-agent work — plan, implement, review, test, revise — into committed YAML workflows any coding agent runs the same way every time.

**Tweet (the shareable unit):**
> Tired of re-typing "plan first, review your work, run the tests" to your coding agent every single run?
>
> Define the workflow once as a YAML playbook, commit it to your repo, and Codex or Claude Code runs it the same way every time. No runtime.
>
> `npx fadeno init`

**Elevator (≈45 sec):**
> Coding agents are powerful but inconsistent. Every nontrivial task you re-explain the same discipline — make a plan, review your own work, run the tests, don't do anything destructive without asking — and you still get different behavior each run, with no record of what happened. Fadeno fixes that. You define the workflow once as a YAML playbook that lives in your repo: roles, steps, review gates, bounded revision loops. Then you just say "use the code-change-review playbook," and Codex or Claude Code runs it the same way every time, writing a file-backed trace of every step to `.fadeno/runs/`. No runtime, no service — it's files and schemas in your repo. And because the playbooks are portable, the same workflow runs whether your team is on Codex or Claude Code.

**Paragraph (README hero):**
> **Fadeno is the playbook layer for AI coding agents.** Stop re-typing "be careful, plan, review, test" every run. Define your workflow once as a repo-native YAML playbook — roles, review gates, bounded revision loops — and any agent runs it the same disciplined way, leaving an inspectable trace of what it did. No runtime, no service, no lock-in: just files in your repo, portable across Codex and Claude Code.

## The "before / after" — the core demo

This contrast *is* the product. Lead with it everywhere.

**Before Fadeno:**
> "Codex, please be careful. Think through the problem first, make a plan, then implement it. Review your own code for edge cases and bugs. Run the tests. If anything's broken, fix it. Don't install new dependencies or run anything destructive without checking with me first."
>
> *(...retyped, slightly differently, every single task. Different results each time. No record of what happened.)*

**After Fadeno:**
> "Use the code-change-review playbook."

Same discipline. Repeatable. Inspectable. Committed to the repo so your whole team gets it.

## Value props (ranked for the beachhead)

The order matters — lead with the daily papercut, not the governance story.

1. **Stop babysitting your agent.** Replace a paragraph of careful-mode instructions with one playbook name. (Frequency of pain: every run.)
2. **Same disciplined run, every time.** Plan → implement → review → test → revise, structured and bounded — not agent-roulette.
3. **See what the agent actually did.** Every run writes a readable trace to `.fadeno/runs/` — plans, reviews, test results, decisions — instead of vanishing into a closed chat window.
4. **Two-second install, zero runtime.** `npx fadeno init` writes files into your repo. No daemon, no service, no account.
5. **No lock-in.** The same playbook runs on Codex and Claude Code. Your workflow isn't hostage to one vendor's format.
6. **Customizable and shareable.** Playbooks are plain YAML you edit and commit. Encode *your* standards; share them across a team. *(This is the bridge to the team expansion.)*

## Objection handling

Anticipate the skeptical HN reader. Answer honestly — candor is the brand.

**"Isn't this just a saved prompt / a markdown file of instructions?"**
> Partly, and that's the point — it's deliberately lightweight. But a saved prompt is personal, unstructured, and lost when the chat closes. A Fadeno playbook is committed to the repo, versioned, shared across a team, *structured* (explicit roles, review gates, bounded loops), and portable across agents. And every run leaves an inspectable trace, which a pasted prompt never does.

**"Why not just use LangGraph / Temporal / a real orchestration runtime?"**
> Those are heavyweight engines you stand up and run. Fadeno is the opposite bet: no runtime, no service, no rewrite. It rides on the coding agent you already use (Codex, Claude Code) and degrades gracefully. If you outgrow it and need a real execution engine, the same playbook format is designed to compile into one later — but most people don't need that, and shouldn't pay for it on day one.

**"The agent can just ignore the playbook. There's no real enforcement."**
> Correct, and we say so plainly. In instruction-only hosts, approval policies are **advisory** — the agent is *asked* to honor them. For hard guarantees, Fadeno's design pushes real enforcement down to your git/CI/pre-commit layer, where a deterministic check runs regardless of what any model does — and protects against human mistakes too, not just agent ones. We'd rather be honest about this than pretend a prompt is a guardrail.

**"How is this different from Codex/Claude Code subagents and skills, which I already have?"**
> Fadeno builds *on* those — it uses native subagents when they're available. What it adds is the portable recipe on top: a single workflow definition that isn't locked to one vendor's subagent format, plus the run ledger that makes execution inspectable. Skills tell the agent *how to do a thing*; a Fadeno playbook tells it *how your whole workflow runs*, the same way, in any supported harness.

**"Why YAML and not just letting the agent figure it out?"**
> Because "figure it out" is exactly the inconsistency you're trying to escape. YAML is human-friendly to author and edit; a JSON Schema makes the vocabulary machine-checkable, so `fadeno validate` catches a broken playbook before an agent runs it. Small, explicit, verifiable beats clever and implicit.

**"Is this another abandoned AI side project?"**
> It's intentionally small and boring: files, schemas, a CLI, starter playbooks. The scope is sustainable for a part-time maintainer precisely *because* it doesn't try to be a runtime. Low surface area is a feature.

## Competitive framing (one-liners)

- **vs. raw prompting:** repeatable and committed, not retyped and forgotten.
- **vs. saved prompts/snippets:** structured, shared, versioned, inspectable — and portable across agents.
- **vs. LangGraph/Temporal:** no runtime, no service, no rewrite; lives in your repo.
- **vs. native subagents/skills alone:** the portable recipe on top, not locked to one vendor's format, with a run trace.

## Proof points to show (not tell)

Word-of-mouth runs on artifacts people can see. Build the README/demo around these:
1. A real `code-change-review.yaml` — short enough to read in 20 seconds.
2. A `.fadeno/runs/<run>/` directory — `run.yaml` + `events.jsonl` + `artifacts/` — so the trace is tangible.
3. The before/after side by side.
4. A 30-second asciinema of `npx fadeno init` → "use the code-change-review playbook" → a run trace appearing.

## Words we use / words we avoid

**Use:** playbook, repo-native, workflow, run trace, inspectable, portable, advisory vs. enforced, bounded, gate, role, degrade gracefully.

**Avoid:** revolutionize, unleash, supercharge, seamless, 10x, agentic synergy, enterprise-grade (at launch), paradigm, next-generation, AI-powered (it's for AI, saying "AI-powered" is noise).
