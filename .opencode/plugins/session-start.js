/* global process */
/**
 * Trellis Session Start Plugin
 *
 * Injects compact SessionStart context into the copy of the latest user
 * message that OpenCode sends to the model, so TUI / Web / SQLite history
 * stay untouched (issue #553).
 *
 * Dual OpenCode entrypoint (v1 >= 1.18.29 and v2):
 *   - v1 calls `server()` and merges the returned hook map.
 *   - v2 calls `setup(ctx)` and registers through domain hooks.
 * Both read the same injection core below; only the transport differs:
 *   v1 `experimental.chat.messages.transform` ({info, parts}[] transcript)
 *   v2 `ctx.session.hook("context")` ({role, content}[] request messages)
 * The v2 `compaction` hook is deliberately NOT registered: v1 fired the
 * transform on compaction too, but the session context exists to orient
 * agent replies, not compaction summaries.
 */

import { TrellisContext, debugLog, isTrellisSubagent } from "../lib/trellis-context.js"
import {
  MESSAGES_TRANSFORM_HOOK,
  platformInputFromMessages,
  prependEphemeralText,
  prependEphemeralTextV2,
  transcriptHasAssistantMessage,
  transcriptHasAssistantMessageV2,
} from "../lib/context-visibility.js"
import { buildSessionContext } from "../lib/session-utils.js"

const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g

function stripFirstReplyNotice(context) {
  return context.replace(FIRST_REPLY_NOTICE_RE, "")
}

function hooksDisabled() {
  return (
    process.env.TRELLIS_HOOKS === "0" ||
    process.env.TRELLIS_DISABLE_HOOKS === "1" ||
    process.env.OPENCODE_NON_INTERACTIVE === "1"
  )
}

export default {
  id: "trellis-session-start",

  // OpenCode v1 (>= 1.18.29): `server()` returns the v1 hook map.
  async server({ directory }) {
    const ctx = new TrellisContext(directory)
    debugLog("session", "Plugin loaded (v1 server), directory:", directory)

    return {
      [MESSAGES_TRANSFORM_HOOK]: async (_input, output) => {
        try {
          const messages = output?.messages
          const platformInput = platformInputFromMessages(messages)
          const agent = platformInput?.agent || "unknown"
          debugLog("session", "messages.transform called, agent:", agent)

          if (isTrellisSubagent(platformInput)) {
            debugLog("session", "Skipping trellis subagent turn:", agent)
            return
          }

          if (hooksDisabled()) {
            debugLog("session", "Skipping - hooks disabled")
            return
          }

          let context = buildSessionContext(ctx, platformInput)
          if (transcriptHasAssistantMessage(messages)) {
            context = stripFirstReplyNotice(context)
          }
          debugLog("session", "Built context, length:", context.length)
          prependEphemeralText(messages, context)
        } catch (error) {
          debugLog("session", "Error in messages.transform:", error.message, error.stack)
        }
      },
    }
  },

  // OpenCode v2: `setup(ctx)` registers the domain-hook equivalent.
  //
  // v1 never calls `setup()` on a module that exports `server()` — its loader
  // short-circuits on the `server` export, so v1 injection happens entirely
  // through `server()`. (v1's promise adapter does invoke `setup()`, but only
  // for separately-registered v2 promise plugins, whose context carries no
  // `location`/`session` domains.) Stand down on any host that calls
  // `setup()` without the required domains: registration needs the real v2
  // host context.
  async setup(pluginCtx) {
    const directory = pluginCtx?.location?.directory
    if (!directory || !pluginCtx?.session?.hook) {
      debugLog("session", "setup() skipped: host has no location/session domain (incomplete setup context)")
      return
    }
    const ctx = new TrellisContext(directory)
    debugLog("session", "Plugin loaded (v2 setup), directory:", directory)

    await pluginCtx.session.hook("context", (event) => {
      try {
        const agent = event?.agent || "unknown"
        debugLog("session", "session context hook called, agent:", agent)

        if (isTrellisSubagent(event)) {
          debugLog("session", "Skipping trellis subagent turn:", agent)
          return
        }

        if (hooksDisabled()) {
          debugLog("session", "Skipping - hooks disabled")
          return
        }

        const platformInput = { sessionID: event?.sessionID, agent: event?.agent }
        let context = buildSessionContext(ctx, platformInput)
        if (transcriptHasAssistantMessageV2(event?.messages)) {
          context = stripFirstReplyNotice(context)
        }
        debugLog("session", "Built context, length:", context.length)
        prependEphemeralTextV2(event?.messages, context, "sessionStart")
      } catch (error) {
        debugLog("session", "Error in session context hook:", error.message, error.stack)
      }
    })
  },
}
