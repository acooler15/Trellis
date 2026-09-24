import { createHash } from "node:crypto"

const PART_ID_PATTERN = /^prt_([0-9a-f]{12})[0-9A-Za-z]{14}$/
const CONTEXT_PART_KINDS = {
  sessionStart: { offset: 2n, slot: "0" },
  workflowState: { offset: 1n, slot: "1" },
}
const MAX_CONTEXT_PART_OFFSET = Object.values(CONTEXT_PART_KINDS).reduce(
  (maximum, definition) => definition.offset > maximum ? definition.offset : maximum,
  0n,
)

/**
 * Return the first ordinary user-authored text part.
 *
 * Trellis plugins can run in either order, so callers must not mistake a
 * synthetic context part inserted by another plugin for the user's prompt.
 */
export function findUserTextPart(parts) {
  if (!Array.isArray(parts)) return undefined
  return parts.find(
    part => part?.type === "text" && part.synthetic !== true && part.text !== undefined,
  )
}

function findIdentitySourcePart(parts) {
  return parts
    .filter(
      part =>
        part?.synthetic !== true &&
        typeof part?.id === "string" &&
        typeof part?.sessionID === "string" &&
        typeof part?.messageID === "string" &&
        PART_ID_PATTERN.test(part.id),
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]
}

function contextPartId(source, kind) {
  const definition = CONTEXT_PART_KINDS[kind]
  if (!definition) throw new TypeError(`unknown context part kind: ${kind}`)

  const match = PART_ID_PATTERN.exec(source.id)
  if (!match) throw new TypeError(`unsupported OpenCode part ID: ${source.id}`)
  const sourceOrdinal = BigInt(`0x${match[1]}`)
  if (sourceOrdinal <= MAX_CONTEXT_PART_OFFSET) {
    throw new TypeError(`unsupported OpenCode part ID ordinal: ${source.id}`)
  }
  const ordinal = sourceOrdinal - definition.offset
  const suffix = createHash("sha256")
    .update(`${source.messageID}\0${kind}`)
    .digest("hex")
    .slice(0, 13)
  return `prt_${ordinal.toString(16).padStart(12, "0")}${definition.slot}${suffix}`
}

/**
 * Persist machine-authored context ahead of the ordinary user parts without
 * mutating any existing part. The generated identity sorts before the source
 * user part in the same order during both the first request and stored replay.
 */
export function insertSyntheticTextPart(parts, text, kind) {
  if (!Array.isArray(parts)) throw new TypeError("parts must be an array")
  if (typeof text !== "string") throw new TypeError("text must be a string")
  if (!CONTEXT_PART_KINDS[kind]) throw new TypeError(`unknown context part kind: ${kind}`)

  const source = findIdentitySourcePart(parts)
  if (!source) throw new TypeError("no ordinary OpenCode part with a persisted identity")

  const id = contextPartId(source, kind)
  if (parts.some(part => part?.id === id)) {
    throw new TypeError(`duplicate synthetic context part: ${kind}`)
  }
  const part = {
    id,
    sessionID: source.sessionID,
    messageID: source.messageID,
    type: "text",
    text,
    synthetic: true,
  }
  const insertionIndex = parts.findIndex(existing => typeof existing?.id !== "string" || id < existing.id)
  if (insertionIndex === -1) parts.push(part)
  else parts.splice(insertionIndex, 0, part)
  return part
}

/** OpenCode hook that mutates the in-memory model payload, not stored history. */
export const MESSAGES_TRANSFORM_HOOK = "experimental.chat.messages.transform"

/**
 * Index of the last user message in an OpenCode `{info, parts}[]` transcript.
 * Compaction and prompt both pass that shape to messages.transform.
 */
export function findLatestUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") return i
  }
  return -1
}

export function platformInputFromMessages(messages) {
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return null
  const info = messages[index].info
  if (!info || typeof info !== "object") return null
  return {
    sessionID: info.sessionID,
    agent: info.agent,
  }
}

export function latestUserPromptText(messages) {
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return ""
  const part = findUserTextPart(messages[index].parts)
  return typeof part?.text === "string" ? part.text : ""
}

export function transcriptHasAssistantMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(message => message?.info?.role === "assistant")
}

/**
 * Clone the latest user message and prepend an ephemeral synthetic text
 * part. The original message object and its `parts` array are left
 * untouched so a transform cannot leak into OpenCode's stored history.
 */
export function prependEphemeralText(messages, text) {
  if (!Array.isArray(messages)) return false
  if (typeof text !== "string") return false
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return false
  const original = messages[index]
  const parts = Array.isArray(original.parts) ? original.parts.slice() : []
  parts.unshift({
    type: "text",
    text,
    synthetic: true,
  })
  messages[index] = {
    ...original,
    parts,
  }
  return true
}

// ============================================================
// OpenCode 2.x request-message helpers
//
// v1 `experimental.chat.messages.transform` passed `{info, parts}[]`
// transcript rows. v2 replaced it with `ctx.session.hook("context")`
// whose `event.messages` are flat `{role, content: Part[]}[]` request
// messages (`Message` from @opencode/ai). The helpers above keep
// serving the v1 path; these serve the v2 path. Hook mutations affect
// only the outgoing model request, never stored history, so the v2
// injected parts are marked via `metadata.trellis` instead of the v1
// `synthetic` flag — the marker lets a sibling Trellis plugin tell an
// injected part from the user's own text regardless of hook order.
// ============================================================

/** True when the part was injected by a Trellis plugin on this request. */
function isTrellisInjectedPartV2(part) {
  const trellis = part?.metadata?.trellis
  return Boolean(trellis && typeof trellis === "object")
}

/** Index of the last `{role, content}` user request message. */
export function findLatestUserMessageIndexV2(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

/** Concatenated ordinary user text of the latest user request message. */
export function latestUserPromptTextV2(messages) {
  const index = findLatestUserMessageIndexV2(messages)
  if (index < 0) return ""
  const content = messages[index].content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(part => part?.type === "text" && !isTrellisInjectedPartV2(part))
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .filter(text => text !== "")
    .join("\n\n")
}

/** True once the request carries any assistant message (v1 parity gate). */
export function transcriptHasAssistantMessageV2(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(message => message?.role === "assistant")
}

/**
 * Slot-replace the latest user request message with a clone whose content
 * carries the Trellis text part first. The original message object and its
 * `content` array are never mutated, mirroring the v1 ephemeral contract.
 */
export function prependEphemeralTextV2(messages, text, kind) {
  if (!Array.isArray(messages)) return false
  if (typeof text !== "string") return false
  const index = findLatestUserMessageIndexV2(messages)
  if (index < 0) return false
  const original = messages[index]
  const content = typeof original.content === "string"
    ? [{ type: "text", text: original.content }]
    : Array.isArray(original.content)
      ? original.content.slice()
      : []
  content.unshift({
    type: "text",
    text,
    metadata: { trellis: { [kind]: true } },
  })
  messages[index] = {
    ...original,
    content,
  }
  return true
}
