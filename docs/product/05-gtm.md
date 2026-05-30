# Fadeno — Launch & Go-to-Market Plan

> Working doc. Builds on `01`–`04`. Hard constraint: **part-time project, no backers, no budget.** Growth is guerilla and word-of-mouth or it doesn't happen. Every tactic here is free, organic, and low-maintenance — no paid acquisition, no sales motion, no community to staff full-time.

## The one strategic idea

**The artifact is the marketing.** A guerilla dev tool grows when the *thing itself* is so obviously useful and so easy to share that users do the distribution for you. That means the README, the 30-second demo, and a committed `code-change-review.yaml` someone spots in a repo have to sell the project without you in the room. Pour effort into those three; treat everything else as amplification.

The growth loop you're aiming for:

```
dev hits the "babysitting my agent" pain
  → finds Fadeno (HN / GitHub / a friend's repo)
  → `npx fadeno init`, works in 2 min
  → commits .fadeno/ to their repo
  → a teammate / follower sees it → asks "what's this?"
  → repeat
```

The committed `.fadeno/` directory is the viral surface. Optimize for "someone sees this in a repo and gets it instantly."

## Pre-launch checklist (don't launch without these)

Word-of-mouth is unforgiving of a weak first impression — you get one shot per channel. Before any public post:

1. **README is the storefront.** Polished, honest, demo-first. (Draft in `04-readme.md`.)
2. **It installs and works in under 2 minutes.** `npx fadeno init` → run a playbook → see a trace. Test on a clean machine.
3. **A 30–60s asciinema/GIF** in the README: init → "use the code-change-review playbook" → run trace appears. This is the single highest-leverage asset.
4. **The pronunciation + "thread" story is on the repo description and your bio.** /fah-DEH-no/.
5. **One starter playbook readable in 20 seconds.** `code-change-review.yaml` is the hero — make sure it reads cleanly.
6. **A repo that looks alive:** clear description, topics/tags, license, a couple of issues you've filed yourself as a roadmap, a tidy commit history.
7. **The honesty section is prominent** (advisory vs. enforced). This crowd checks for overclaiming first; passing that check earns the rest of the read.

## Channels, ranked by fit

For a free, part-time project the realistic channels are narrow. Spend where developers self-select for this exact pain.

**Tier 1 — where the beachhead actually is:**
- **Hacker News (Show HN).** The highest-leverage single moment. One good Show HN can seed the whole flywheel. (Playbook below.)
- **GitHub itself.** Topics (`ai`, `agents`, `codex`, `claude-code`, `developer-tools`), a great README, and being *findable* when people search "codex workflow" / "claude code playbook." Submit to relevant `awesome-*` lists (awesome-ai-agents, awesome-claude-code, etc.) once you have a little traction.
- **Reddit:** r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA-adjacent dev subs. Lead with the problem, not the plug.

**Tier 2 — amplification:**
- **Dev Twitter/X and Bluesky.** Short, demo-GIF-led posts. Reply into threads where people complain about flaky agent runs — that's your exact buyer mid-pain. (You already have a Bluesky presence under the fadeno handle space — check availability.)
- **Tool-specific communities:** Codex / Claude Code Discords and forums. Be a helpful member first; mention Fadeno when it actually answers someone's question.

**Tier 3 — slow-burn / compounding:**
- **A short blog post / dev.to / personal site:** "Why I stopped re-typing 'be careful' to my coding agent." Narrative SEO that keeps working.
- **One genuinely good demo video** if you enjoy making them; optional.

**Skip entirely:** paid ads, ProductHunt-as-a-priority (low fit for a repo-native dev CLI), cold outreach, conference anything. None fit a part-time guerilla motion.

## The Show HN playbook (your biggest single lever)

1. **Title:** `Show HN: Fadeno – repo-native playbooks so your coding agent runs the same way every time`. Concrete, no hype, names the harness pain.
2. **First comment (you, immediately):** the origin story in your own voice — *"I got tired of retyping 'plan, review, run the tests' to Codex every session and getting different results, so I…"*. Personal, honest, 5–6 sentences. Link the 30s demo. State plainly what it is **and isn't** (not a runtime; advisory-not-enforced in tier-1).
3. **Pre-empt the top objections** in that comment (it's-just-a-prompt, why-not-LangGraph, no-real-enforcement) — pull straight from `03-messaging.md`. Getting ahead of them sets the thread's tone.
4. **Timing:** weekday morning US Eastern tends to do well; avoid Fri/weekend. Post when you have a few hours free to reply.
5. **Be present and humble in the thread for the first 3–4 hours.** Reply to every substantive comment, concede fair criticism, file good suggestions as issues live. HN rewards a maintainer who engages honestly far more than a slick pitch.
6. **Don't ask for upvotes anywhere** — it backfires and violates the rules.

If the Show HN underperforms (common, it's variable), that's fine — iterate the README based on the questions people asked, and the GitHub/Reddit/Twitter channels keep compounding regardless.

## Messaging per channel (all from the same library)

- **HN:** the honest, technical register. Lead with the problem and the design choices; downplay polish-as-marketing. Show the trade-offs.
- **Reddit:** problem-first, conversational. *"Anyone else tired of babysitting their coding agent? I made a thing."*
- **Twitter/Bluesky:** the demo GIF + the hook line (*"Stop re-typing 'be careful' to your coding agent"*) + the npx one-liner. One idea per post.
- **GitHub/README:** the full story, demo-first, honesty section prominent.

Keep them all consistent with `03-messaging.md` — same before/after, same value-prop order, same words-we-avoid list.

## First 30 days (lightweight, sustainable)

- **Week 0:** finish the pre-launch checklist. Record the demo. Tighten the README. Dry-run install on a clean machine.
- **Week 1:** Show HN on a good weekday morning. Same day or next: a Bluesky/Twitter thread with the GIF, and one problem-first Reddit post. Be present in every thread.
- **Weeks 2–4:** turn the best questions from launch into README improvements and a short FAQ. Submit to 1–2 `awesome-*` lists. Reply helpfully (not spammily) in Codex/Claude Code communities. Write the one blog post if you have the energy.
- **Ongoing, low-effort:** ship a small, visible improvement every week or two so the repo reads as alive. Respond to issues promptly — for a guerilla project, *responsiveness is the brand*. A maintainer who answers within a day signals "this is maintained" louder than any roadmap.

## Success signals (calibrated for guerilla scale)

Don't measure this like a funded launch. Realistic early signals:
- People you don't know open issues / ask questions → the artifact is legible.
- Someone commits `.fadeno/` to *their* repo and you didn't ask them to → the growth loop is real.
- A second contributor sends a playbook PR → it's becoming a tiny ecosystem.
- The repo shows up when people search their pain → SEO/positioning is landing.

Stars are vanity; the signals above are the ones that mean word-of-mouth is actually working.

## The biggest risks (and the cheap mitigations)

1. **"Looks abandoned."** Fatal for trust. → Tiny visible cadence + fast issue replies. Low effort, high signal.
2. **"It's just a prompt in a trenchcoat."** → The run trace and the schema/validate story are the rebuttal; show them, don't argue them. Keep the honesty section up front.
3. **Pronunciation/clarity friction in word-of-mouth.** → Own the /fah-DEH-no/ + "thread" story everywhere.
4. **Spreading yourself across too many channels part-time.** → Don't. Do HN + GitHub well; let the rest be opportunistic. One channel done well beats five done thinly.

## What I'd do first, if it were one afternoon

Record the 30-second demo and finish the README. Those two assets carry every channel, and you can't launch without them. Everything else is amplification on top.
