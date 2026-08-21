---
name: fadeno-bakeoff
description: Adjudicate a Fadeno shadow pair (two arms of the same task) using host `judge` subagents instead of a second command-lane vendor. Use when asked to assess, judge, compare, or adjudicate a shadow pair, or when handed a pair id and asked to form a verdict.
---

# Fadeno shadow-pair comparison

Resolve the CLI first: when `scripts/fadeno.cjs` exists beside this `SKILL.md`, use
that plugin-bundled launcher for every command written below as `fadeno`
(invoke it with `node` on Windows).
Otherwise use `fadeno` from `PATH`. Never prefer an unrelated global CLI over
the plugin launcher.

`fadeno bakeoff <pair-id>` alone dispatches both judges itself, over the
command lane — which needs a `judge` dial configured with `--via` a second
vendor. Most hosts already have a `judge` subagent for free (the same one a
Fadeno playbook's judging step spawns). This skill inverts control: it drives
`fadeno bakeoff` in two phases so YOU spawn the judges, as host subagents,
instead of the CLI shelling out to a second command-lane process.

## Procedure

1. **Prepare.** Run `fadeno bakeoff <pair-id> --prepare`. This measures the
   pair and writes two blinded prompt files under `.fadeno/local/prompts/` —
   it writes NO artifact and consults no model. The result names
   `comparisonPromptPath`, `adversarialPromptPath`, and `judgeArchetype`
   (always `judge`).

   Add `--evidence explored` when the arms' diffs are large or when the
   question is whether the change FITS the code it landed in. It reconstructs
   each arm's tree under `.fadeno/local/judge/<pair-id-8>/arm_a|arm_b/` and
   puts paths in the prompt instead of the diff bytes — on this repo's pair
   `49a1f92a` that took the comparison prompt from 55 KB to 11 KB while
   giving the judge strictly more to look at. Your judge subagents then need
   file-reading tools, which a host subagent has and a `claude -p` command
   lane may not. Default is `inlined`, which embeds both diffs and keeps the
   prompt file a complete record of what was judged.
2. **Spawn two `judge` subagents — INDEPENDENTLY.** One per prompt file, as
   separate spawns with no shared context between them. Each spawn's
   instruction is just: "Read `<promptPath>` and follow its instructions
   exactly. Return ONLY the JSON object it asks for — no prose before or
   after it." That is the entire instruction — see Rules below for why you
   must not add to it.
3. **Capture each subagent's raw returned text to a file**, unedited — e.g.
   `.fadeno/local/prompts/judge-comparison-<pair-id-8>.result.json` and the
   adversarial counterpart. Write exactly what the subagent returned; do not
   reformat, trim, or extract the JSON yourself. `--record` does its own
   tolerant extraction (a stray code fence or a line of prose around the
   object is fine) — that logic lives in one place so both delivery paths
   fail the same way on the same malformed output.
4. **Record.** Run
   `fadeno bakeoff <pair-id> --record --comparison <comparison-file> --adversarial <adversarial-file>`,
   adding `--evidence explored` if you used it in step 1. `--record`
   re-derives everything from the ledger rather than carrying state from
   `--prepare`, so it has no way to know which mode you chose; passing the
   wrong one mislabels your own evidence in the artifact.
   This validates both judgments against `bakeoff.schema.json`,
   unblinds, renders, and writes `.fadeno/bakeoffs/<pair-id>.md` — with
   `judge_delivery: host` stamped in its frontmatter and a
   `judge_delivery_unattested` confound in its body. A judgment that fails to
   parse or fails schema validation is refused; nothing is written.
5. **Report back** exactly what the one-shot path reports: the verdict, the
   graft plan when the verdict is `graft`, and the written artifact path.

## Rules

- **The two spawns are independent.** Do not fold the adversarial pass into
  the comparison spawn, and do not let one subagent see the other's prompt or
  answer. The adversarial pass exists to find a defect BOTH arms share — a
  thing an arm-vs-arm comparison can never surface, because both arms agree
  on it. Running it as a follow-up to "which arm is better" turns it into a
  box ticked after a winner is already chosen, not an independent search.
- **You pass paths, not summaries.** Do not open the prompt files or the
  arms' diffs yourself, and do not paraphrase or excerpt them into the spawn
  instruction. Each prompt file already contains everything its judge needs.
  A coordinator that reads the diff first and then briefs the judge has
  already formed the opinion the judge exists to form independently — and has
  usually leaked something the blinding was trying to withhold.
- **The judge answers `prefer_a` / `prefer_b`, never `prefer_baseline` /
  `prefer_challenger`.** It is blinded and genuinely does not know which
  label is the primary and which is the challenger, and must not guess.
  `--record`, like the one-shot path, is the ONE place that translates the
  blinded verdict into the artifact's frame. Do not relabel, reinterpret, or
  "help" the judge's answer yourself — pass its JSON through unedited to
  `--record` and let the kernel do the one translation.
- **Blinding here is advisory, not a guarantee.** A `judge` subagent with
  repository read access can open `.fadeno/dispatches.jsonl`, walk git log,
  or inspect a retained challenger worktree and work out which label is
  which. Nothing in this flow prevents that — it only avoids handing the
  judge the answer directly. Say this plainly if asked how reliable the
  blinding is; do not imply the labels are airtight.
- **`judge_delivery: host` is the honest label, not a defect to hide.** A
  file you handed to `--record` carries no dispatch receipt the way a
  command-lane judge's output does — the same access that let the `judge`
  subagent read this pair would let a coordinator write the JSON by hand.
  That is why the artifact stamps `judge_delivery: host` and a
  `judge_delivery_unattested` confound rather than rendering identically to a
  command-lane verdict.
