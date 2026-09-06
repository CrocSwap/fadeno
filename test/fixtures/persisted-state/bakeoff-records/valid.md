---
kind: Bakeoff
baseline: sonnet
challenger: grok
verdict: prefer_baseline
date: 2026-09-05
pair_id: 49a1f92a-f349-4ac1-86d3-8b5f2e890ae7
dispatch_ids:
  - 3924f340-f7ac-4a00-b00f-275a1e7c9b0d
  - e0cafa2a-a22c-48ea-8311-2201149fa62c
judge_delivery: host
---

# ModelComparison

A trimmed but structurally complete record: `parseBakeoffFile` requires the
frontmatter above and every one of `BAKEOFF_REQUIRED_SECTIONS` below.

## Criteria

Correctness first, then whether the change is one a reader can verify.

## Model traits

- **verbosity** (more: challenger): wrote 65% more code for the same result.

## Confounds

The judge saw both arms unblinded.

## Shared blind spots

Neither arm read the inventory tripwire before editing the table.
