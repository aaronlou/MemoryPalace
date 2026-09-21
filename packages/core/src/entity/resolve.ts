import type { Clock } from "@memory-palace/shared"
import { newId } from "@memory-palace/shared"
import type { Entity } from "../memory/types.js"
import type { MemoryStore } from "../ports/storage.js"

/**
 * Entity resolution.
 *
 * Deliberately lexical, not embedding-based: entity names are short and the
 * failure mode we care about ("Effect-TS" vs "effect ts" vs "EffectTS" being
 * three different entities) is a normalisation problem, not a semantic one.
 * Embedding-based entity linkage would happily merge "React" and "React Native".
 */

const ARTICLE_PREFIX = /^(the|a|an)\s+/

/** Human-facing canonical form: collapse whitespace, keep original casing. */
export function cleanEntityName(name: string): string {
  return name.replace(/\s+/g, " ").trim()
}

/**
 * Matching key. Normalises case, separators and articles so that
 * "Effect-TS", "effect ts" and "EffectTS" all collapse to one key.
 */
export function entityKey(name: string): string {
  return cleanEntityName(name)
    .toLowerCase()
    .replace(ARTICLE_PREFIX, "")
    .replace(/[-_/.]+/g, " ")
    .replace(/\s+/g, "")
}

export interface EntityInput {
  name: string
  kind: string
}

export interface ResolvedEntity {
  entity: Entity
  /** True when this entity was newly created by this resolution pass. */
  created: boolean
}

/**
 * Resolve extracted entity mentions against what is already stored, creating
 * any that are new. Matching is on the normalised key against both canonical
 * names and aliases; a new alias seen for a known entity is recorded.
 */
export async function resolveEntities(
  store: MemoryStore,
  userId: string,
  inputs: EntityInput[],
  clock: Clock,
): Promise<Map<string, ResolvedEntity>> {
  const byKey = new Map<string, ResolvedEntity>()
  if (inputs.length === 0) return byKey

  // De-duplicate the incoming mentions first — extraction often repeats entities
  // across candidates, and we must not issue one query per mention.
  const wanted = new Map<string, EntityInput>()
  for (const input of inputs) {
    const name = cleanEntityName(input.name)
    if (name === "") continue
    const key = entityKey(name)
    if (key === "") continue
    if (!wanted.has(key)) wanted.set(key, { name, kind: input.kind })
  }
  if (wanted.size === 0) return byKey

  const existing = await store.findEntitiesByNames(
    userId,
    [...wanted.values()].map((e) => e.name),
  )
  const existingByKey = new Map<string, Entity>()
  for (const entity of existing) {
    existingByKey.set(entityKey(entity.canonicalName), entity)
    for (const alias of entity.aliases) existingByKey.set(entityKey(alias), entity)
  }

  const now = clock.now().toISOString()
  for (const [key, input] of wanted) {
    const hit = existingByKey.get(key)
    if (hit) {
      byKey.set(key, { entity: hit, created: false })
      continue
    }
    const entity: Entity = {
      id: newId("ent"),
      userId,
      canonicalName: input.name,
      kind: input.kind,
      aliases: [],
      createdAt: now,
    }
    const stored = await store.upsertEntity(entity)
    existingByKey.set(key, stored)
    byKey.set(key, { entity: stored, created: true })
  }

  return byKey
}

/** Map extracted entity mentions to resolved entity ids, preserving order. */
export function entityIdsFor(resolved: Map<string, ResolvedEntity>, names: string[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const hit = resolved.get(entityKey(name))
    if (hit && !seen.has(hit.entity.id)) {
      seen.add(hit.entity.id)
      ids.push(hit.entity.id)
    }
  }
  return ids
}
