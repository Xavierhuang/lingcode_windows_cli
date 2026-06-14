import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

let initSettings: undefined | (() => ReturnType<typeof import("./settings").useSettings>)

mock.module("@lingcode-ai/ui/context", () => ({
  createSimpleContext: (input: { init: () => unknown }) => {
    initSettings = input.init as () => ReturnType<typeof import("./settings").useSettings>
    return {
      use: () => {
        throw new Error("useSettings is not available in this test")
      },
      provider: () => null,
    }
  },
}))

mock.module("@/utils/persist", async () => {
  const { createStore } = await import("solid-js/store")
  return {
    persisted: <T,>(_: string, tuple: ReturnType<typeof createStore<T>>) => {
      const [store, setStore] = tuple
      return [store, setStore, null, () => true] as const
    },
  }
})

beforeAll(async () => {
  await import("./settings")
})

describe("settings followup mode", () => {
  test("keeps queue mode when selected", () => {
    if (!initSettings) throw new Error("settings init not captured")

    createRoot((dispose) => {
      const settings = initSettings!()

      settings.general.setFollowup("queue")

      expect(settings.general.followup()).toBe("queue")

      dispose()
    })
  })
})
