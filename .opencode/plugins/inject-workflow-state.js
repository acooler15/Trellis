/* global process */
/**
 * Trellis Workflow State Injection Plugin
 *
 * Per-turn UserPromptSubmit equivalent for OpenCode.
 *
 * On every model request, inject a short <workflow-state> breadcrumb
 * into the in-memory copy of the latest user message. Stored history and
 * the TUI are not modified (issue #553). Breadcrumb text is pulled
 * exclusively from the project's workflow.md [workflow-state:STATUS] tag
 * blocks — workflow.md is the single source of truth. There are no
 * fallback tables in this plugin: when workflow.md is missing or a tag is
 * absent, the breadcrumb degrades to a generic
 * "Refer to workflow.md for current step." line so users see (and fix)
 * the broken state instead of the plugin silently masking it.
 *
 * Dual OpenCode entrypoint (v1 >= 1.18.29 and v2), same layout as
 * session-start.js: v1 calls `server()` for the
 * `experimental.chat.messages.transform` hook, v2 calls `setup(ctx)` and
 * registers `ctx.session.hook("context")`. The v2 `compaction` hook is
 * not registered — the breadcrumb orients agent replies only.
 *
 * Silently skips when:
 *   - No .trellis/ directory
 *   - No active task in the session runtime context
 *   - task.json malformed or missing status
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import {
  MESSAGES_TRANSFORM_HOOK,
  latestUserPromptText,
  latestUserPromptTextV2,
  platformInputFromMessages,
  prependEphemeralText,
  prependEphemeralTextV2,
} from "../lib/context-visibility.js"
import { TrellisContext, debugLog, isTrellisSubagent } from "../lib/trellis-context.js"

// Supports STATUS values with letters, digits, underscores, hyphens
// (so "in-review" / "blocked-by-team" work alongside "in_progress").
const TAG_RE = /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g

// Escape hatch for the per-turn breadcrumb (issue #427). Mirrors
// `common.config.get_prompt_injection_config()` / the shared Python hook's
// `_resolve_skip_keyword()` + `prompt_has_skip_keyword()`.
const DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-trellis"

function stripInlineComment(value) {
  let inQuote = null
  for (let idx = 0; idx < value.length; idx++) {
    const ch = value[idx]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === "#" && (idx === 0 || /\s/.test(value[idx - 1]))) return value.slice(0, idx)
  }
  return value
}

function unquoteYaml(s) {
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) return s.slice(1, -1)
  return s
}

/**
 * Line-based parser for ONLY the `prompt_injection:` block of
 * `.trellis/config.yaml`. Not a general YAML parser — mirrors
 * `common.config.get_prompt_injection_config()` semantics for this section
 * only (missing key keeps the default; non-string value keeps the default).
 */
function readSkipKeyword(directory) {
  const path = join(directory, ".trellis", "config.yaml")
  if (!existsSync(path)) return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD
  let text
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD
  }

  let inSection = false
  let sectionIndent = -1
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!inSection) {
      if (/^prompt_injection\s*:\s*(#.*)?$/.test(trimmed)) {
        inSection = true
        sectionIndent = rawLine.length - rawLine.trimStart().length
      }
      continue
    }
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = rawLine.length - rawLine.trimStart().length
    if (indent <= sectionIndent) break
    const m = trimmed.match(/^skip_keyword\s*:\s*(.*)$/)
    if (!m) continue
    return unquoteYaml(stripInlineComment(m[1]).trim())
  }
  return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD
}

/**
 * Case-insensitive, word-boundary match of `keyword` in `text`. Hyphen
 * counts as a word char so "no-trellisx" / "xno-trellis" don't match, but
 * punctuation/whitespace boundaries do. Empty keyword never matches.
 */
function promptHasSkipKeyword(text, keyword) {
  if (!keyword || typeof text !== "string") return false
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i")
  return pattern.test(text)
}

/**
 * Parse workflow.md for [workflow-state:STATUS] blocks.
 *
 * Returns {status: body}. workflow.md is the single source of truth —
 * there are no fallback tables here. Missing tags (or a missing /
 * unreadable workflow.md) fall back to a generic line in
 * buildBreadcrumb so users see the broken state and fix workflow.md
 * rather than the plugin silently masking it.
 */
function loadBreadcrumbs(directory) {
  const workflowPath = join(directory, ".trellis", "workflow.md")
  if (!existsSync(workflowPath)) return {}
  let content
  try {
    content = readFileSync(workflowPath, "utf-8")
  } catch {
    return {}
  }
  const result = {}
  for (const match of content.matchAll(TAG_RE)) {
    const status = match[1]
    const body = match[2].trim()
    if (body) result[status] = body
  }
  return result
}

/**
 * Get (taskId, status) from active task, or null if no active task.
 */
function getActiveTask(ctx, platformInput = null) {
  const active = ctx.getActiveTask(platformInput)
  const taskRef = active.taskPath
  if (!taskRef) return null
  const taskDir = ctx.resolveTaskDir(taskRef)
  if (active.stale || !taskDir || !existsSync(taskDir)) {
    return { id: taskRef.split("/").pop(), status: "stale", source: active.source }
  }
  const taskJsonPath = join(taskDir, "task.json")
  if (!existsSync(taskJsonPath)) return null
  try {
    const data = JSON.parse(readFileSync(taskJsonPath, "utf-8"))
    const status = typeof data.status === "string" ? data.status : ""
    if (!status) return null
    const id = data.id || taskRef.split("/").pop()
    return { id, status, source: active.source }
  } catch {
    return null
  }
}

/**
 * Build the <workflow-state>...</workflow-state> block.
 * - Known status (tag present in workflow.md) → detailed body
 * - Unknown status (no tag, or workflow.md missing) → generic
 *   "Refer to workflow.md for current step." line
 * - no_task pseudo-status (id === null) → header omits task info
 */
function buildBreadcrumb(id, status, templates) {
  let body = templates[status]
  if (body === undefined) {
    body = "Refer to workflow.md for current step."
  }
  let header = id === null ? `Status: ${status}` : `Task: ${id} (${status})`
  return `<workflow-state>\n${header}\n${body}\n</workflow-state>`
}

function hooksDisabled() {
  return (
    process.env.TRELLIS_HOOKS === "0" ||
    process.env.TRELLIS_DISABLE_HOOKS === "1" ||
    process.env.OPENCODE_NON_INTERACTIVE === "1"
  )
}

export default {
  id: "trellis-workflow-state",

  // OpenCode v1 (>= 1.18.29): `server()` returns the v1 hook map.
  async server({ directory }) {
    const ctx = new TrellisContext(directory)
    debugLog("workflow-state", "Plugin loaded (v1 server), directory:", directory)

    return {
      [MESSAGES_TRANSFORM_HOOK]: async (_input, output) => {
        try {
          const messages = output?.messages
          const platformInput = platformInputFromMessages(messages)
          // Skip Trellis sub-agent turns — the per-turn breadcrumb is for the
          // main session only; sub-agent context comes from the parent's
          // tool.execute.before injection.
          if (isTrellisSubagent(platformInput)) {
            debugLog("workflow-state", "Skipping trellis subagent turn:", platformInput?.agent)
            return
          }
          if (hooksDisabled()) {
            return
          }
          if (!ctx.isTrellisProject()) {
            return
          }

          const originalText = latestUserPromptText(messages)

          // Escape hatch (issue #427): user prompt contains the skip keyword
          // as a standalone word — emit nothing for this turn only.
          if (promptHasSkipKeyword(originalText, readSkipKeyword(directory))) {
            debugLog("workflow-state", "Skipping turn: skip keyword present in prompt")
            return
          }

          const templates = loadBreadcrumbs(directory)
          const task = getActiveTask(ctx, platformInput)
          const breadcrumb = task
            ? buildBreadcrumb(task.id, task.status, templates, task.source)
            : buildBreadcrumb(null, "no_task", templates)

          prependEphemeralText(messages, breadcrumb)
          debugLog(
            "workflow-state",
            "Injected breadcrumb for task",
            task ? task.id : "none",
            "status",
            task ? task.status : "no_task",
          )
        } catch (error) {
          debugLog(
            "workflow-state",
            "Error in messages.transform:",
            error instanceof Error ? error.message : String(error),
          )
        }
      },
    }
  },

  // OpenCode v2: `setup(ctx)` registers the domain-hook equivalent.
  // v1 >= 1.18.29 also calls `setup()` through its v2 compat host, but that
  // PluginContext carries only options/agent/aisdk/catalog/command/
  // integration/plugin/reference/skill — no location and no session domain.
  // Stand down there: v1 already injected through `server()`.
  async setup(pluginCtx) {
    const directory = pluginCtx?.location?.directory
    if (!directory || !pluginCtx?.session?.hook) {
      debugLog("workflow-state", "setup() skipped: host has no location/session domain (v1 compat host)")
      return
    }
    const ctx = new TrellisContext(directory)
    debugLog("workflow-state", "Plugin loaded (v2 setup), directory:", directory)

    await pluginCtx.session.hook("context", (event) => {
      try {
        if (isTrellisSubagent(event)) {
          debugLog("workflow-state", "Skipping trellis subagent turn:", event?.agent)
          return
        }
        if (hooksDisabled()) {
          return
        }
        if (!ctx.isTrellisProject()) {
          return
        }

        const originalText = latestUserPromptTextV2(event?.messages)
        if (promptHasSkipKeyword(originalText, readSkipKeyword(directory))) {
          debugLog("workflow-state", "Skipping turn: skip keyword present in prompt")
          return
        }

        const templates = loadBreadcrumbs(directory)
        const task = getActiveTask(ctx, { sessionID: event?.sessionID, agent: event?.agent })
        const breadcrumb = task
          ? buildBreadcrumb(task.id, task.status, templates, task.source)
          : buildBreadcrumb(null, "no_task", templates)

        prependEphemeralTextV2(event?.messages, breadcrumb, "workflowState")
        debugLog(
          "workflow-state",
          "Injected breadcrumb for task",
          task ? task.id : "none",
          "status",
          task ? task.status : "no_task",
        )
      } catch (error) {
        debugLog(
          "workflow-state",
          "Error in session context hook:",
          error instanceof Error ? error.message : String(error),
        )
      }
    })
  },
}
