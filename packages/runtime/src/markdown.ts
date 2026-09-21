import type { TransferBundle } from "@memory-palace/storage-pg"

/**
 * Human-readable export.
 *
 * The JSON bundle is the machine format; this is the one a person can read,
 * diff and keep in a notes app. For a local-first product the readable export
 * matters more than it sounds — it is the evidence that the user's memory is
 * actually theirs and not trapped in a schema.
 */

const TYPE_TITLES: Record<string, string> = {
  goal: "Goals",
  preference: "Preferences",
  fact: "Facts",
  decision: "Decisions",
  relationship: "Relationships",
  experience: "Experiences",
  event: "Events",
}

const TYPE_ORDER = ["goal", "preference", "fact", "decision", "relationship", "experience", "event"]

interface MemoryRow {
  id: string
  type: string
  content: string
  status: string
  confidence: number
  importance: number
  /** ISO strings, guaranteed by `exportAll`'s normalisation. */
  valid_from?: string
  valid_until?: string
  recorded_at?: string
  last_seen_at?: string
  reinforced_count?: number
}

interface RelationRow {
  from_memory_id: string
  to_memory_id: string
  kind: string
  reason?: string
}

export function renderMarkdown(bundle: TransferBundle): string {
  const memories = bundle.memories as unknown as MemoryRow[]
  const relations = bundle.relations as unknown as RelationRow[]
  const active = memories.filter((m) => m.status === "active")
  const inactive = memories.filter((m) => m.status !== "active")

  const lines: string[] = [
    "# Memory Palace export",
    "",
    `- Exported: ${bundle.exportedAt}`,
    `- User: \`${bundle.userId}\``,
    `- Memories: ${memories.length} (${active.length} active, ${inactive.length} historical)`,
    `- Observations: ${bundle.observations.length}`,
    `- Entities: ${bundle.entities.length}`,
    "",
    "---",
    "",
    "## Currently believed",
    "",
  ]

  for (const type of TYPE_ORDER) {
    const group = active.filter((m) => m.type === type)
    if (group.length === 0) continue
    lines.push(`### ${TYPE_TITLES[type] ?? type}`, "")
    for (const m of group) {
      lines.push(`- ${m.content}${annotations(m)}`)
    }
    lines.push("")
  }

  if (inactive.length > 0) {
    lines.push(
      "---",
      "",
      "## History",
      "",
      "These are no longer current. Kept so that changes are traceable.",
      "",
    )
    const byType = new Map<string, MemoryRow[]>()
    for (const m of inactive) {
      const list = byType.get(m.type) ?? []
      list.push(m)
      byType.set(m.type, list)
    }
    for (const type of TYPE_ORDER) {
      const group = byType.get(type)
      if (!group || group.length === 0) continue
      lines.push(`### ${TYPE_TITLES[type] ?? type}`, "")
      const sorted = [...group].sort((a, b) =>
        (a.valid_from ?? "").localeCompare(b.valid_from ?? ""),
      )
      for (const m of sorted) {
        lines.push(`- ~~${m.content}~~${annotations(m)} — _${m.status}_`)
      }
      lines.push("")
    }
  }

  if (relations.length > 0) {
    lines.push("---", "", "## How memories changed", "")
    const byId = new Map(memories.map((m) => [m.id, m]))
    for (const rel of relations) {
      if (rel.kind !== "supersedes" && rel.kind !== "refines" && rel.kind !== "contradicts")
        continue
      const from = byId.get(rel.from_memory_id)
      const to = byId.get(rel.to_memory_id)
      if (!from || !to) continue
      const verb =
        rel.kind === "supersedes"
          ? "replaced"
          : rel.kind === "refines"
            ? "refined"
            : "conflicts with"
      lines.push(
        `- "${from.content}" ${verb} "${to.content}"${rel.reason ? ` — _${rel.reason}_` : ""}`,
      )
    }
    lines.push("")
  }

  return lines.join("\n")
}

function annotations(m: MemoryRow): string {
  const bits: string[] = []
  if (m.valid_from || m.valid_until) {
    const from = m.valid_from?.slice(0, 10) ?? "?"
    const until = m.valid_until?.slice(0, 10)
    bits.push(until ? `${from} → ${until}` : `${from} → now`)
  }
  if (m.confidence < 0.75) bits.push(`confidence ${m.confidence.toFixed(2)}`)
  if ((m.reinforced_count ?? 0) > 0) bits.push(`seen ${m.reinforced_count}×`)
  return bits.length > 0 ? `  _(${bits.join("; ")})_` : ""
}
