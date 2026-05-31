---
description: Author or revise a Fadeno playbook from a natural-language workflow description.
argument-hint: [what the workflow should do]
---

The user wants to create or modify a **Fadeno playbook** — a reusable agent
workflow definition under `.fadeno/playbooks/`.

Use the Fadeno **builder** skill and follow its procedure for the request below:
seed `.fadeno/` if it is missing (`fadeno init --claude --data-only`), pick the
closest starter or author from scratch, write the YAML, run `fadeno validate` and
`fadeno diagram`, show the diagram back, and get explicit approval. Do **not**
execute the playbook from the builder — that is the runner's job, and only after
the user approves.

Request: $ARGUMENTS
