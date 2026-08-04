# Host-dispatch contract

Status: frozen for the MVP implementation.

The host executor adapter is named `host`. A drive that has native work which
has not yet received a terminal receipt returns `awaiting_host_dispatch` and
the durable request records are exposed to the host. The lifecycle vocabulary
is:

- `host_dispatch_requested` — Fadeno has planned a native call.
- `actor_dispatched` — the host has started it and attested the native agent.
- `actor_completed` / `actor_failed` — the host has submitted the one terminal
  receipt.

The receipt commands are `dispatch-start`, `dispatch-complete`, and
`dispatch-fail`. Start accepts a native `--agent-id`; completion accepts a
temporary output file and optional commit; failure accepts host text. Start is
idempotent for the same native agent id, and terminal receipt submission is
idempotent for the same output digest.

Run inputs use repeated `--input Name=path`. The playbook declares each logical
name and media type. Fadeno copies exact bytes to `artifacts/inputs/`, records a
manifest and digest, and retains the source filename only as provenance. The
logical name remains stable even when source filenames differ.

The run ledger is format `0.3`. Format `0.2` and unversioned ledgers are
readable only through explicit compatibility mode; writers reject them. The
director is the sole ledger writer during the MVP. Native agents return work
and receipts to the host; they do not invoke Fadeno ledger commands.
