/**
 * assemblyEntityRegistry.ts — Derives and queries AssemblyEntity objects from
 * the current Zustand store state + partSemanticRegistry.
 *
 * This is the single place that converts raw store state (Parts + AssemblyGroups)
 * into the canonical AssemblyEntity abstraction. Downstream code (grounding,
 * planning, demo flow) should consume AssemblyEntity rather than raw partIds.
 *
 * Design:
 *   - Stateless: every call re-derives from the live store snapshot.
 *   - Read-only: does NOT write to the store.
 *   - Zero side-effects: safe to call at any point during rendering or tool execution.
 *
 * Limitations (current phase):
 *   - 'subassembly' entities are scaffolded but not yet built from any source.
 *   - bbox is not computed (Three.js objects not accessed here to keep this pure).
 *   - semanticTags are derived from heuristic name patterns + vlmCategory only.
 */

import type { AssemblyEntity } from '../../../../shared/schema/assemblyEntity';
import { useV2Store } from '../../store/store';
import { getCard } from './partSemanticRegistry';

// ---------------------------------------------------------------------------
// Semantic tag derivation
// ---------------------------------------------------------------------------

const TAG_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /fan|FAN|風扇|blower|cooling/i,            tag: 'fan' },
  { pattern: /thermal|heatsink|heat_sink|散熱/i,        tag: 'thermal' },
  { pattern: /chassis|frame|housing|機殼|殼體/i,        tag: 'chassis' },
  { pattern: /cover|lid|cap|蓋/i,                       tag: 'cover' },
  { pattern: /board|pcb|motherboard|主板/i,             tag: 'pcb' },
  { pattern: /screw|bolt|nut|螺絲/i,                    tag: 'fastener' },
  { pattern: /bracket|mount|support|架/i,               tag: 'bracket' },
  { pattern: /connector|plug|socket|接頭/i,             tag: 'connector' },
];

function deriveSemanticTags(name: string, vlmCategory?: string): string[] {
  const text = `${name} ${vlmCategory ?? ''}`;
  const tags = new Set<string>();
  for (const { pattern, tag } of TAG_PATTERNS) {
    if (pattern.test(text)) tags.add(tag);
  }
  return [...tags];
}

// ---------------------------------------------------------------------------
// Entity builders
// ---------------------------------------------------------------------------

function entityFromPart(
  partId: string,
  partName: string,
): AssemblyEntity {
  const card = getCard(partId);
  const semanticTags = deriveSemanticTags(partName, card?.vlmCategory);
  return {
    entityId: partId,
    entityType: 'part',
    memberPartIds: [partId],
    representativePartId: partId,
    displayName: card?.displayName ?? partName,
    semanticCategory: card?.vlmCategory,
    semanticDescription: card?.vlmDescription,
    semanticTags,
  };
}

function entityFromGroup(
  groupId: string,
  groupName: string,
  partIds: string[],
): AssemblyEntity {
  // Representative = first member (could be improved later to pick the
  // "heaviest" or "most grounded" part).
  const repId = partIds[0];
  const repCard = repId ? getCard(repId) : undefined;

  // Derive category from majority of members
  const categoryCounts = new Map<string, number>();
  for (const pid of partIds) {
    const cat = getCard(pid)?.vlmCategory;
    if (cat) categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  }
  let dominantCategory: string | undefined;
  let maxCount = 0;
  for (const [cat, count] of categoryCounts) {
    if (count > maxCount) { maxCount = count; dominantCategory = cat; }
  }

  // Union semantic tags across all members
  const allTagSets = partIds.map(pid => {
    const c = getCard(pid);
    return deriveSemanticTags(c?.partName ?? pid, c?.vlmCategory);
  });
  const unionTags = [...new Set(allTagSets.flat())];

  return {
    entityId: groupId,
    entityType: 'group',
    memberPartIds: [...partIds],
    representativePartId: repId,
    displayName: groupName,
    semanticCategory: dominantCategory ?? repCard?.vlmCategory,
    sourceGroupId: groupId,
    semanticTags: unionTags,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a flat list of all assembly entities from the current store state.
 *
 * Rules:
 *   1. Every AssemblyGroup becomes one 'group' entity.
 *   2. Parts NOT belonging to any group become individual 'part' entities.
 *   3. Parts that ARE in a group are represented by the group entity only
 *      (they do not appear as standalone 'part' entities in the result).
 *
 * This mirrors how the real assembly graph should work: once parts are grouped,
 * the group is the addressable unit.
 */
export function listAssemblyEntities(): AssemblyEntity[] {
  const state = useV2Store.getState();
  const { parts, assemblyGroups } = state;

  const groupedPartIds = new Set<string>();
  const entities: AssemblyEntity[] = [];

  // Step 1: build group entities
  for (const groupId of assemblyGroups.order) {
    const group = assemblyGroups.byId[groupId];
    if (!group || group.partIds.length === 0) continue;
    for (const pid of group.partIds) groupedPartIds.add(pid);
    entities.push(entityFromGroup(groupId, group.name, group.partIds));
  }

  // Step 2: build part entities for ungrouped parts
  for (const partId of parts.order) {
    if (groupedPartIds.has(partId)) continue;
    const part = parts.byId[partId];
    if (!part) continue;
    entities.push(entityFromPart(partId, part.name));
  }

  return entities;
}

/**
 * Find a single entity by entityId.
 * Searches both group entities and part entities.
 */
export function getAssemblyEntityById(entityId: string): AssemblyEntity | null {
  return listAssemblyEntities().find(e => e.entityId === entityId) ?? null;
}

/**
 * Find the group entity that contains a given partId.
 * Returns null if the part is not grouped.
 */
export function findGroupEntityForPart(partId: string): AssemblyEntity | null {
  const state = useV2Store.getState();
  for (const groupId of state.assemblyGroups.order) {
    const group = state.assemblyGroups.byId[groupId];
    if (group?.partIds.includes(partId)) {
      return entityFromGroup(groupId, group.name, group.partIds);
    }
  }
  return null;
}

/**
 * Given an entity, return the partId to use as the motion anchor / transform
 * reference. Falls back to memberPartIds[0] if representativePartId is unset.
 */
export function getRepresentativePartId(entity: AssemblyEntity): string | null {
  return entity.representativePartId ?? entity.memberPartIds[0] ?? null;
}

/**
 * Resolve a raw part reference (partId or sourceGroupId) to an AssemblyEntity.
 *
 * This is the bridge from the current ad-hoc `{ partId, sourceGroupId }` pattern
 * to the entity abstraction.  Pass `sourceGroupId` when the router has already
 * identified that the part belongs to a group.
 */
export function resolveToEntity(params: {
  partId: string;
  sourceGroupId?: string;
}): AssemblyEntity {
  if (params.sourceGroupId) {
    const groupEntity = getAssemblyEntityById(params.sourceGroupId);
    if (groupEntity) return groupEntity;
  }
  // Fall back to part entity (even if the part is in a group — caller chose
  // to address it individually, which is valid for the representative-only path).
  const state = useV2Store.getState();
  const part = state.parts.byId[params.partId];
  if (part) return entityFromPart(params.partId, part.name);

  // Last resort: synthetic entity (handles race conditions during scene load)
  return {
    entityId: params.partId,
    entityType: 'part',
    memberPartIds: [params.partId],
    representativePartId: params.partId,
    displayName: params.partId,
  };
}

/**
 * Check whether two entities refer to the same underlying assembly element
 * (same entityId, or one is a subgroup of the other).
 * Currently: identity check only.
 */
export function entitiesOverlap(a: AssemblyEntity, b: AssemblyEntity): boolean {
  if (a.entityId === b.entityId) return true;
  // Check if any member part is shared
  const aSet = new Set(a.memberPartIds);
  return b.memberPartIds.some(id => aSet.has(id));
}
