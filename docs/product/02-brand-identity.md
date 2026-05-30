# Fadeno — Brand Identity

> Working doc. Builds on `01-positioning.md`. Audience: individual-dev beachhead, guerilla/word-of-mouth growth. Every choice here is filtered through "does this travel by word of mouth?"

## Name verdict: **Keep "Fadeno"**

It clears every practical bar a word-of-mouth dev tool needs, and it comes with an unearned gift.

**Why it works:**
- **The npm name is free.** `npx fadeno init` works as the headline install. This alone is a strong reason not to rename — clean install names are scarce.
- **No collision in the dev/software space.** The only "fadeno" results are a thread-lift beauty brand, a soap dispenser, and a dinosaur artist. None compete for developer mindshare or search terms. "fadeno agents," "fadeno playbook," "fadeno cli" are wide open for SEO.
- **It has a real meaning, and it's the *right* meaning.** In Esperanto, **fadeno = "thread."** That's a gift: a playbook is a thread that runs through every step of a task; a run trace is a thread of execution you can follow. An invented name with a true, on-topic origin story is *better* for word-of-mouth than a random coinage — people repeat the story, and the story does the explaining.
- **Short, ownable, brandable.** Six letters, three syllables, easy to type.

**The one real weakness — and the fix:**
- **Pronunciation is ambiguous** (fah-DEH-no? FAY-deno?). For a word-of-mouth tool this is the only thing that can bite — a name people aren't sure how to say gets said less.
- **Fix: own it.** State pronunciation + meaning explicitly and early (README, repo description, social bios) so the correct version propagates:

  > **Fadeno** /fah-DEH-no/ — Esperanto for "thread." The thread that runs through every agent task.

  A name *with* a pronunciation guide and a story spreads cleanly; a name left ambiguous mutates.

**Bottom line:** renaming a project you've already committed to would need a strong reason, and there isn't one. Fadeno is good. Lean into the "thread" story and publish the pronunciation.

## Tagline

The tagline does the 3-second job: a stranger reads it on GitHub and knows what this is and why they'd care.

**Primary (recommended):**
> **The playbook layer for AI coding agents.**

Descriptive, honest, searchable, category-defining. It says *what* it is. Pair it with the punchy hook below for the emotional pull.

**Hook line (for hero/social, paired with the primary):**
> **Stop re-typing "be careful" to your coding agent.**

This is the word-of-mouth line — it names the daily papercut every Codex/Claude Code user feels. It's the sentence people will actually repeat.

**Alternates (by register):**

*Descriptive:*
- Repeatable workflows for AI coding agents.
- Repo-native playbooks for AI coding agents.

*Punchy / emotional:*
- Define how your agent works. Once.
- Same disciplined run, every time.
- Your agent's playbook, committed to the repo.

*Leaning on the "thread" meaning (use sparingly, e.g. About section):*
- The thread that runs through every agent task.

**Recommended pairing:**
> **Fadeno — the playbook layer for AI coding agents.**
> Stop re-typing "be careful, plan, review, test." Define the workflow once, commit it to your repo, and any agent runs it the same way.

## Voice & tone

The audience is skeptical, craft-literate, allergic to hype. The voice that wins here is **honest, precise, low-key, and a little dry.** Fadeno's own design honesty (tier-1 enforcement is *advisory*, not a guarantee) is the perfect expression of the brand voice — candor as a feature.

**Principles:**
1. **Plain over grand.** "Define the workflow once" beats "revolutionize your agentic engineering velocity." No "revolutionize," "unleash," "supercharge," "seamless," "10x."
2. **Show the artifact.** A real `code-change-review.yaml` and a real run trace persuade better than adjectives. Lead with the thing.
3. **Be honest about limits — it builds trust.** Say plainly what's advisory vs. enforced. This crowd rewards candor and punishes overclaiming.
4. **Dry wit, not jokes.** A light touch ("agent-roulette," "stop babysitting your agent") lands; forced humor doesn't.
5. **Respect the reader's time.** Short sentences. Get to the code fast. Assume they're smart and busy.

**Litmus test:** would this sentence get upvoted or eye-rolled on Hacker News? Write for upvotes.

**On-brand vs. off-brand:**

| Off-brand (don't) | On-brand (do) |
|---|---|
| "Fadeno revolutionizes AI-powered development workflows." | "Fadeno is a playbook layer for AI coding agents." |
| "Seamlessly orchestrate your agentic pipelines at scale." | "Define a workflow once; any agent runs it the same way." |
| "Enterprise-grade governance for AI agents." | "Wire approval gates to your CI so they're actually enforced — not just suggested." |
| "Unleash the full power of autonomous coding." | "Stop re-typing 'be careful' every run." |

## Visual direction (notes for a logo/mark concept)

Not a final design — direction to brief a mark against. The **thread** motif is the obvious, ownable anchor, and it ties the name's meaning to the product (a thread weaving through steps = a playbook).

**Concept anchor — "the thread":**
- A single continuous line/thread that weaves through or connects a few nodes (steps in a playbook). Reads as both "thread" (the name) and "workflow/flow" (the product). Simple enough to work as a 16px favicon and an ASCII-art header in a README.

**Wordmark:**
- Lowercase **`fadeno`** in a clean monospace or geometric mono (e.g. a Berkeley Mono / JetBrains Mono / Commit Mono feel). Monospace signals "developer tool" instantly and fits the repo-native, CLI-first identity.
- Optional: a subtle thread element replacing or connecting through a letter (e.g. a line threading through the "d" or under the wordmark).

**Color:**
- Dev-tool palette, not enterprise SaaS. A single confident accent on a near-black/near-white base reads best in terminals, GitHub READMEs (light *and* dark mode), and social cards.
- Candidate accent directions: a muted teal/green (calm, "tests passing"), or a warm thread-color (a spool-of-thread amber/rust) that literalizes the name. Avoid the overused AI-purple gradient — it screams "another AI tool" and undercuts the low-hype voice.
- Must render well in **both** GitHub light and dark themes (this is where the logo actually lives).

**Type & layout for README/social:**
- Monospace headers, generous whitespace, real code blocks front and center. The README *is* the landing page for a guerilla project — design it like one.

**Deliverable options (next step):** I can produce 2–3 concrete SVG mark concepts (thread-through-wordmark, node-thread glyph, pure monospace wordmark) that render in light/dark, plus a favicon crop. Say the word.

## Quick-reference brand summary

- **Name:** Fadeno /fah-DEH-no/ — Esperanto for "thread."
- **Category:** playbook layer for AI coding agents.
- **Tagline:** The playbook layer for AI coding agents.
- **Hook:** Stop re-typing "be careful" to your coding agent.
- **Voice:** honest, precise, low-hype, dry. Write for HN upvotes.
- **Visual anchor:** the thread — a line weaving through workflow steps; lowercase monospace wordmark; dev-tool palette, no AI-purple.
