import { Effect } from "effect"
import { Auth } from "@/auth"
import { Octokit } from "@octokit/rest"

/**
 * GitHub token resolution for the `lingcode github` subcommands, mirroring
 * `src/cloud/cloud.ts`. A single token (with `repo` scope) is reused both for
 * the GitHub REST API (repo creation) and as the push credential.
 */

/** Auth-store key under which the GitHub token is persisted (auth.json). */
export const AUTH_KEY = "github"

/**
 * Resolve the GitHub token: GITHUB_TOKEN env wins, else the value stored by
 * `github login` in the CLI auth store. Returns undefined when absent.
 */
export const resolveToken = Effect.fn("Github.resolveToken")(function* () {
  const env = process.env.GITHUB_TOKEN?.trim()
  if (env) return env
  const auth = yield* Auth.Service
  const info = yield* auth.get(AUTH_KEY).pipe(Effect.orElseSucceed(() => undefined))
  if (info && info.type === "api") return info.key
  return undefined
})

/** Verify a token and return the authenticated login. Throws on rejection. */
export async function verify(token: string): Promise<string> {
  const octo = new Octokit({ auth: token })
  const me = await octo.users.getAuthenticated()
  return me.data.login
}

export * as GithubAuth from "./auth"
