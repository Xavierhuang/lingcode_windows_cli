# Plan: `lingcode build` + RTK on Linux/Windows

The two remaining *closeable* Swift-parity gaps (everything else still open is
Mac-only by design — IPC, Xcode/simulator/icon generators). Written 2026-06-20
against the rc15 codebase. These are real multi-day features, not one-shots; each
is broken into checkpoints that can each be built, typechecked (CI), and shipped
independently behind a flag.

---

## 1. `lingcode build` — autonomous project bootstrap (~5–7 days)

Cosine/Genie-style: from a single prompt, scaffold and iterate a project to a
working state, running its own tools in a loop until done or budget-exhausted.

**Reuse, don't reinvent.** The headless run loop already exists — `cli/cmd/run.ts`
+ `cli/cmd/run/` drive a model with the tool registry (`tool/registry.ts`),
permissions, and streaming. `build` is a thin orchestrator on top, not a new agent
engine.

**Checkpoints**
1. **Command skeleton** — `cli/cmd/build.ts` (`lingcode build "<prompt>" [--dir] [--max-iterations] [--yolo]`),
   registered in `index.ts`. Resolves provider/model like `run`. Behind `LINGCODE_EXPERIMENTAL_BUILD`.
2. **Bootstrap loop** — wrap the run session: (a) plan → (b) apply edits via the
   existing write/edit/bash tools → (c) run the project's build/test command → (d)
   feed failures back. Terminate on success signal, `--max-iterations`, or token budget.
3. **Workspace scaffolding** — empty-dir detection, framework templates (or let the
   model scaffold), `.gitignore`/git-init, dependency install step.
4. **Verification gate** — a configurable "done" check (build passes / test passes /
   dev server boots) before declaring success. Mirror `verify` skill semantics.
5. **Stream/JSON output** — reuse `run`'s stream-json so `build` is scriptable.

**Risks:** loop non-termination (cap iterations + budget), destructive edits in a
non-empty dir (require `--force` or empty dir), provider cost (surface token spend).

---

## 2. RTK (Rust Token Killer) — transparent bash rewriting (~2 days)

Rewrites verbose shell output (and optionally commands) to token-cheaper forms
before they hit the model — a small Rust binary the CLI shells out to, or a WASM
module. Needs a Rust toolchain wired into the build.

**Checkpoints**
1. **Rust crate** — `crates/rtk/` (or a subdir), `cargo` lib+bin. Pure function:
   stdin (raw tool output) → stdout (compacted). Start with the highest-value
   rewrites (dedupe repeated lines, truncate hex/log noise, collapse whitespace).
2. **Build integration** — cross-compile `rtk` for the same 12 targets in
   `lingcode-cli-release.yml` (add a `cargo build --release --target …` matrix step;
   this is the only place the Rust toolchain is needed). Embed the binary in the zip
   alongside `bin/lingcode`, or ship as a sidecar.
3. **CLI hook** — invoke RTK in the tool-output path (where bash/tool results are
   appended to the conversation) behind `LINGCODE_RTK=1`. Fail open: if the binary is
   missing or errors, pass output through unchanged.
4. **Measure** — log tokens-before/after so the win is quantified; default off until
   it clearly pays for itself.

**Risks:** cross-compile complexity (musl/arm64/windows — same matrix the TS build
already solves, so reuse it); correctness (never alter semantics the model needs —
keep rewrites conservative and reversible-in-meaning); startup cost per call.

---

## Sequencing recommendation

Do **`serve --max-concurrent`** (done, rc15) → **`lingcode build`** (biggest
user-facing value, no new toolchain) → **RTK** (most infra risk; needs Rust in CI).
Ship each behind its experimental flag, default off, until proven.
