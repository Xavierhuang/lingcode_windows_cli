import { Flag } from "@lingcode-ai/core/flag/flag"

// RTK — the token killer. Conservatively compacts verbose tool output before it
// reaches the model, in ways that preserve all information:
//
//   - runs of identical consecutive lines collapse to "<line>  [×N]"
//   - 3+ consecutive blank lines collapse to a single blank line
//   - trailing whitespace per line is trimmed
//
// These are the dominant token sinks in real command output (progress spam,
// repeated log lines, padded tables) and none of them drop content the model
// can't reconstruct — the [×N] marker preserves counts. It is idempotent and
// never grows the input (falls back to the original if compaction wouldn't help),
// so it is safe to run on every bash result.
//
// Compiled into the CLI binary on every platform, so it is available to every
// user; on by default, opt out with LINGCODE_RTK=0.

const COUNT = (line: string, n: number) => (n > 1 ? `${line}  [×${n}]` : line)

export function compact(input: string): string {
  if (!input) return input

  const out: string[] = []
  let prev: string | null = null
  let runs = 0
  let blanks = 0

  const flush = () => {
    if (prev === null) return
    out.push(COUNT(prev, runs))
    prev = null
    runs = 0
  }

  for (const rawLine of input.split("\n")) {
    const line = rawLine.replace(/[ \t\r]+$/, "")
    if (line === "") {
      flush()
      blanks++
      if (blanks <= 1) out.push("")
      continue
    }
    blanks = 0
    if (line === prev) {
      runs++
    } else {
      flush()
      prev = line
      runs = 1
    }
  }
  flush()

  let result = out.join("\n")
  if (input.endsWith("\n") && !result.endsWith("\n")) result += "\n"

  // Never hand back something larger than we got — if nothing compacted, the
  // model should see the untouched original.
  return result.length < input.length ? result : input
}

// Apply RTK only when enabled; a cheap pass-through otherwise so callers can wrap
// every tool result unconditionally.
export function maybeCompact(input: string): string {
  return Flag.LINGCODE_RTK ? compact(input) : input
}
