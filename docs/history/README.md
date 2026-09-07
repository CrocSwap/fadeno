# docs/history

Design documents from before the 0.7 rewrite. **They describe a product that no
longer exists.** Nothing here is a specification, a plan, or a description of
how the code works today; do not implement from any of it.

They are kept because the reasoning is often still good, and because several of
the calls in `docs/redesign/decisions.html` are only legible against what they
replaced.

| File | What it was |
|------|-------------|
| `kickoff-memo.md` | The settled rationale for the v0 advisory playbook protocol: tiers, gate discipline, portability. |
| `roadmap.md` | The shipped/deferred line and the honest v0 gaps, as of 0.6. |
| `notes/architecture-overview.md` | An earlier architecture summary. |
| `experimental/` | The forward-implementation boundary documents: the next protocol, the compositional runtime, the North Star ontology, and the design notes for dials, harness-neutral routing, permissions and isolation, coordinators, and the host-dispatch contract. |

**Where the live documents are:**

- `docs/redesign/spec.html` — the specification, and the only normative document.
- `docs/redesign/decisions.html` — why each call was made, with its evidence.
- `docs/redesign/lessons.md` — what the deleted test suite had learned, harvested
  before the code that held it went.
- `docs/architecture.md`, `docs/extending.md` — how the code is built and how to
  change it.

`docs/product/` is marketing collateral for the pre-0.7 positioning and is
likewise out of date; it is left where it is because it belongs to a different
workstream.
