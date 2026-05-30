# Fadeno — Launch Demo Shooting Script

> The single highest-leverage launch asset (per `05-gtm.md`). Goal: a ~45–50s autoplaying GIF at the top of the README that takes a skeptical dev from "what is this" to "oh, I get it" without a single click.

## Decisions (locked)

- **Format:** autoplaying GIF in the README (GitHub autoplays GIFs, no JS player needed). Recorded as a terminal session, exported to GIF.
- **Harness:** Claude Code (`/`-style invocation, `.claude/skills/`, `CLAUDE.md`).
- **Agent moment:** a **real** Claude Code session, sped up in post — not staged.
- **Demo task:** add a `--json` flag to `fadeno validate`, performed **in the Fadeno repo itself** (dogfooding — "we build Fadeno with Fadeno").

Because Claude Code runs in the terminal, the *entire* demo is one continuous terminal recording. No splicing a GUI into a terminal cast.

## Output specs

- **Length:** 45–52s final.
- **Terminal:** 100×28, a clean monospace (JetBrains Mono / SF Mono), generous font size — it must be legible at README width (~880px) and on mobile.
- **Theme:** near-black background, low-chrome prompt. Hide your real hostname/username (use a plain `~/fadeno $` prompt).
- **File size:** target < 4 MB so it loads fast and GitHub doesn't choke. Optimize with `gifsicle`.

## Recording pipeline

Tooling (all free, macOS/Linux):

```bash
brew install asciinema agg gifsicle      # agg = asciinema-cast → GIF
# optional, for the scripted framing scenes: brew install vhs
```

Two viable approaches:

**A. One continuous real session (simplest — recommended for v1).**
Record the whole flow with `asciinema rec demo.cast`, run Claude Code live inside it, then trim and speed-ramp the agent portion in post. Most authentic, fewest moving parts.

**B. Scripted framing + real agent splice (more polished, re-recordable).**
Render Scenes 2–3 and 5 with a [VHS](https://github.com/charmbracelet/vhs) `.tape` file (deterministic, re-runnable when the CLI changes), record Scene 4 as a real Claude Code asciinema cast, and stitch the GIFs with `ffmpeg`. Use this for v2 once the v1 lands.

Convert and optimize:

```bash
agg --font-family "JetBrains Mono" --theme asciinema demo.cast demo.gif
gifsicle -O3 --lossy=80 --colors 128 demo.gif -o demo-optimized.gif
```

## Pre-flight (do this once before recording)

1. **Rehearse the agent run.** Do the `--json` task with Claude Code once for real, off-camera, in a throwaway branch. Confirm the runner skill writes a clean `.fadeno/runs/<…>/` (tidy `run.yaml`, readable `events.jsonl`, sensible artifacts). If the trace looks messy, that's a runner-skill wording fix — better found now than on camera.
2. **Start from a clean repo state** on a dedicated `demo` branch so the diff and the run dir are pristine.
3. **Pre-install** so `npx fadeno` doesn't pause on a download mid-take (or accept the pause and trim it).
4. **Pin the run timestamp won't matter** — but check the run-dir slug reads well (e.g. `…-add-json-flag`).
5. Have `tree` and `bat` (or `batcat`) installed for the pretty file/dir views.

---

## Scene-by-scene

Timecodes are the *final* (post-speed-ramp) target. Record naturally; fix timing in post.

### Scene 1 — the pain *(optional, 0:00–0:04)*

On-screen: a developer types the familiar wall of instructions, then it cuts off.

```
~/fadeno $ # every. single. time:
~/fadeno $ # "plan first, then implement. review your own code for edge
~/fadeno $ #  cases. run the tests. don't add deps or do anything
~/fadeno $ #  destructive without asking…"  ▮
```

> Keep it to ~4s. If it feels staged, cut Scene 1 entirely and let the README prose above the GIF carry the "before." The GIF can open straight on Scene 2.

### Scene 2 — install (0:04–0:12)

```
~/fadeno $ npx fadeno init --claude
```

Let the real output stream (created/appended/skipped lines), then immediately show what landed:

```
~/fadeno $ tree -L 3 .fadeno .claude
```

Viewer should see `.fadeno/playbooks/`, `.fadeno/schemas/`, and `.claude/skills/fadeno-runner` + `fadeno-builder`. **This is the moment they realize it's just files in the repo.**

### Scene 3 — it's just YAML (0:12–0:19)

```
~/fadeno $ bat .fadeno/playbooks/code-change-review.yaml
```

Scroll just enough to show `roles:`, the `review_gate` (gate), and the bounded `revise` loop (`max_iterations: 1`). Don't linger — ~6s. The takeaway is "readable, editable, mine."

### Scene 4 — the magic (real Claude Code, 0:19–0:39)

```
~/fadeno $ claude
```

Then type one natural line into Claude Code:

> Use the **fadeno-runner** skill to run the **code-change-review** playbook: add a `--json` flag to `fadeno validate` that prints machine-readable results and still exits non-zero on failure.

Let it run **for real**, then **speed-ramp this segment 6–8×** in post so the plan → implement → review → test cycle flies by in ~18–20s. What the viewer should be able to read as it blurs past:

- a **plan** appears,
- the **implementer** edits `validate.ts` / `cli.ts`,
- **two reviewers** weigh in (the gate),
- *(bonus if it happens naturally)* a reviewer flags an edge case → the **revise loop** fires once,
- **tests run** and pass.

Don't fake a loop that didn't happen. If the run is clean first time, that's fine — the trace in Scene 5 still proves the structure.

### Scene 5 — the proof (0:39–0:48)

Exit Claude Code, back to the shell. The payoff is the trace:

```
~/fadeno $ tree .fadeno/runs
~/fadeno $ cat .fadeno/runs/*/run.yaml
~/fadeno $ head -n 6 .fadeno/runs/*/events.jsonl
```

Viewer sees `run.yaml` (playbook, task, status, steps), the append-only `events.jsonl`, and the `artifacts/` dir. **This is the differentiator shot** — "you can see exactly what the agent did," which no chat window gives you.

Optional kicker (4s) — show it actually worked:

```
~/fadeno $ fadeno validate --json | head
```

### Scene 6 — end card (0:48–0:52)

Cut to a still: the `logo-lockup.svg` over a clean background, the tagline, and the CTA.

```
            fadeno
   The playbook layer for AI coding agents.

            npx fadeno init
```

Hold ~3s, then loop. (Add this in post as a static frame appended to the GIF, or render it as a final VHS frame.)

---

## Post-production checklist

- [ ] Trim dead air (npx download pause, your typos, long agent silences).
- [ ] Speed-ramp Scene 4 to 6–8×; keep Scenes 2/3/5 at ~1× so text is readable.
- [ ] Append the Scene 6 end-card frame (hold 3s).
- [ ] Export at 100×28, optimize with `gifsicle` to < 4 MB.
- [ ] Watch it once **muted at README width and once on a phone** — if any line is unreadable, bump the font size and re-export.
- [ ] Sanity-check no real username/email/path leaks in the frames.

## Embedding in the README

Put the GIF immediately under the hero, before "The problem":

```markdown
<p align="center">
  <img src="docs/product/assets/demo.gif" alt="Fadeno: init, run the code-change-review playbook in Claude Code, inspect the run trace" width="800">
</p>
```

Keep the static `logo-lockup.svg` above it (or composited into the end card). Commit the optimized GIF to `docs/product/assets/demo.gif`.

## Backup plan if the live agent run is fussy

If recording a clean live run proves flaky on the day, fall back to the terminal-only cut: do Scenes 1–3 and 5–6 exactly as above, and in Scene 4 invoke the runner and skip ahead to the trace, with a one-line caption ("Claude Code runs the playbook → "). Less magical, but 100% reproducible and still shows the proof. Ship that, then upgrade to the spliced real-run version for v2.
