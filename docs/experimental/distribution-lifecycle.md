# Distribution and installation lifecycle

This document defines the current product boundary for installing Fadeno. The
goal is plugin-first onboarding without hiding ownership or turning Fadeno into
a daemon or global environment manager.

## Three layers

1. **Plugin capability.** The Codex or Claude plugin contains skills, immutable
   built-in definitions, and a bundled JavaScript CLI. Each skill invokes that
   bundle through its own `scripts/fadeno.cjs` launcher, so it does not depend on a
   shell `PATH` entry.
2. **User integration.** First `setup` copies the bundle to the stable XDG user
   data directory, writes shared executor/loadout configuration under the XDG
   config directory, records ownership under the XDG state directory, and
   materializes host-specific managed agents. Claude setup also records one
   user permission for the stable runtime, avoiding per-repo command prompts
   without granting a wildcard shell permission. This layer works across repos.
3. **Project customization.** `init` or `vendor` is explicit. It writes
   `.fadeno/` definitions and optional harness adapters into a repo. Built-in
   workflows do not require this layer.

Default paths (all honor their XDG variables and Fadeno-specific overrides):

| Kind | Default | Source controlled? |
|------|---------|--------------------|
| User config | `~/.config/fadeno/` | No |
| User state/ownership | `~/.local/state/fadeno/` | No |
| Stable managed runtime | `~/.local/share/fadeno/runtime/` | No |
| Codex managed agents | `~/.codex/agents/fadeno-*.toml` | No |
| Project definitions | `<repo>/.fadeno/` | Yes, except traces/local state |
| Project harness adapters | `<repo>/.agents`, `.claude`, `.grok`, `.codex` | Yes when deliberately vendored; local settings stay ignored |

## Lifecycle contract

- Plugin install alone makes bundled skills and definitions available.
- First setup is non-destructive and user-only. It must not modify the current
  repository merely because setup happened there.
- A plugin cache path is never embedded in a long-lived managed agent. Agents
  point at the stable managed runtime.
- Installation ownership is digest-backed. Uninstall removes only owned,
  unchanged, or explicitly managed files. It preserves user edits and reports
  them.
- Global uninstall never scans or mutates repositories. Repository cleanup is
  an explicit `clean` or `unvendor` operation run inside that repository.
- `--purge-user-data` is separate and requires `--force` because executor
  profiles and loadouts are user-authored data.

## Standalone and overlapping installs

The plugin runtime and an npm-installed `fadeno` may coexist. Plugin skills use
their private launcher, while humans and CI use shell `PATH`. `fadeno status`
and `fadeno doctor` report the invocation source, managed-runtime version, and
installed harness integrations so version skew is visible rather than guessed.

## Native binary boundary

The current bundle is a self-contained JavaScript application, not a native
binary, so a fresh system still needs Node.js 20 or newer. Shipping signed,
platform-specific native executables would remove that prerequisite but adds a
release matrix, signing/notarization, architecture selection, updater, and
supply-chain verification. That is deferred until installation telemetry or
dogfood shows Node is the dominant remaining onboarding failure. The private
launcher and stable-runtime contract are intentionally independent of the
payload format, so a native executable can replace the JavaScript bundle later
without changing the user journey.
