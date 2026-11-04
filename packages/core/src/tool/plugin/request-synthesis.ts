export * as RequestSynthesisTool from "./request-synthesis.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"

export const name = "request_synthesis"

export const CONFIRMATION =
  "Synthesis mode activated. Emit final deliverable now (<= 2,000 tok) in Caveman Ultra (drop articles/filler, abbreviate DB/auth/config/req/res/fn/impl/ctx/env/err, causal arrows X -> Y, exact file:line symbols) without further tool calls."

export const DESCRIPTION = [
  "Call request_synthesis({}) once discovery, inspection, or verification tool calls finish to switch into final structured report synthesis.",
  "After calling request_synthesis({}), emit your complete final deliverable in a single pass using Caveman Ultra (or Caveman Full + Team Lead if Depth-0 user tail) without further tool calls.",
].join(" ")

export const Input = Schema.Struct({
  summary_plan: Schema.optional(Schema.String).annotate({
    description: "Optional brief outline of key sections to include in your final deliverable",
  }),
})

export const Output = Schema.Struct({
  synthesizing: Schema.Boolean,
  message: Schema.String,
})
export type Output = typeof Output.Type

export const Plugin = {
  id: "opencode.tool.request_synthesis",
  effect: Effect.fn("RequestSynthesisTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (_input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Unable to activate synthesis mode", error })),
                Effect.as({
                  output: { synthesizing: true, message: CONFIRMATION },
                  content: CONFIRMATION,
                  metadata: { synthesizing: true },
                }),
              ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
