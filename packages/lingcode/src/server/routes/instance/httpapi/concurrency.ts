import { Flag } from "@lingcode-ai/core/flag/flag"
import { Effect } from "effect"
import { HttpMiddleware, HttpServerResponse } from "effect/unstable/http"

// In-process count of requests currently being served. The headless server is a
// single Node process, so a module-level counter is sufficient — there are no
// workers to share state across.
let inFlight = 0

// Global middleware mirroring the Swift CLI's `serve --max-concurrent`: once the
// configured number of requests are in flight, additional requests get an
// immediate HTTP 429 instead of queueing. `--max-concurrent` (the
// LINGCODE_MAX_CONCURRENT flag) unset or <= 0 means unlimited, so this is a
// no-op by default. Wired into the outer HttpRouter middleware in server.ts.
export const concurrencyMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const limit = Flag.LINGCODE_MAX_CONCURRENT
    if (limit <= 0) return yield* effect
    if (inFlight >= limit) {
      return HttpServerResponse.jsonUnsafe(
        { error: "too_many_requests", message: `server is at its concurrency limit (${limit})` },
        { status: 429 },
      )
    }
    inFlight++
    // Decrement on every exit path — success, failure, or interruption — so a
    // slot is never leaked.
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          inFlight--
        }),
      ),
    )
  })
