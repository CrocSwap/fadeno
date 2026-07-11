# Fadeno degraded roles (v1)

Use the pinned Fadeno `code-change-review` playbook. Native role subagents are not available for this treatment: perform coordinator, implementer, and reviewer as separate passes; save their durable outputs; emit a `roles_degraded` event; and follow the playbook's deterministic gates and revision bound. Do not claim native roles were used. Do not change Fadeno instructions during a batch.
