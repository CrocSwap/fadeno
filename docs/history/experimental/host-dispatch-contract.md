# Host-dispatch contract

Status: lifecycle contract frozen; additive progress extension accepted from
live dogfood evidence on 2026-08-04.

The host executor adapter is named `host`. A drive that has host work which
has not yet received a terminal receipt returns `awaiting_host_dispatch` and
the durable request records are exposed to the host. The lifecycle vocabulary
is:

- `host_dispatch_requested` — Fadeno has planned a host call.
- `actor_dispatched` — the host has started it and attested the host agent.
- `actor_completed` / `actor_failed` — the host has submitted the one terminal
  receipt.
- `host_dispatch_withdrawn` — the third terminal receipt: a request that was
  minted and never started is retired with a reason, with no start and no
  result. The next `fadeno drive` mints attempt *n+1* for the same actor call
  under the current cascade or binding (`attempt_reason: withdrawn`, unless the
  executor changed, where `executor_override` still wins).

The receipt commands are `dispatch-start`, `dispatch-complete`,
`dispatch-fail`, and `dispatch-withdraw`. Start accepts a `--agent-id`; completion accepts a
temporary output file and optional commit; failure accepts host text. Start is
idempotent for the same host agent id, and terminal receipt submission is
idempotent for the same output digest. Withdrawal takes `--reason` and is
refused once a start exists (`dispatch-fail` or `dispatch-complete` is the
receipt for work that began); repeating the same reason is idempotent. A
withdrawal that removes a prepared isolated workspace records
`workspace_removed`, and a failed removal still records the receipt while
naming the leftover path.

A host executor may declare an exact `fallback_command` argv. When the current
Codex role is materialized for another host executor, `dispatch-fallback`
authenticates the request, prompt, and profile snapshot; invokes that argv; and
writes the start plus terminal receipts. Those events carry
`delivery_transport: command-fallback`, the argv digest, and
`identity_evidence: command_receipt`; `host_attested` is false. The logical
executor/model identity is unchanged, but the transport is never presented as
host execution.

Between start and terminal, the host may record any number of
`host_dispatch_progress` observations with `dispatch-progress`. The immutable
actor prompt names a workspace-relative JSON sidecar; agent, harness, or
director observations retain that source label. Verification checks request →
start → progress* → terminal ordering, identity agreement, source/state shape,
and host attestation. It cannot prove the semantic progress report true, and no
gate or control-flow condition may consume it.

Run inputs use repeated `--input Name=path`. The playbook declares each logical
name and media type. Fadeno copies exact bytes to `artifacts/inputs/`, records a
manifest and digest, and retains the source filename only as provenance. The
logical name remains stable even when source filenames differ.

The run ledger is format `0.3`. Format `0.2` and unversioned ledgers are
readable only through explicit compatibility mode; writers reject them. The
director is the sole ledger writer during the MVP. Host agents return work
and receipts to the host; they do not invoke Fadeno ledger commands.
