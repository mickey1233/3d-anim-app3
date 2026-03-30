/**
 * partSemanticRegistry.ts — Scene-level semantic card registry (frontend, session cache).
 *
 * Cards are populated by calling the server-side labelPart() via WS command
 * `agent.label_part`. Results are cached in memory (per session) and
 * invalidated when a new model is loaded.
 *
 * Usage:
 *   await ensurePartLabeled(partId, partName, geometrySummary);
 *   const card = getCard(partId);
 *   const matches = findPartsByText("fan");
 */
import type { PartSemanticCard } from './partSemanticTypes';

/** In-memory registry keyed by partId */
const registry = new Map<string, PartSemanticCard>();

/** Reset registry when a new model is loaded */
export function clearRegistry(): void {
  registry.clear();
}

/** Register or update a card */
export function setCard(card: PartSemanticCard): void {
  registry.set(card.partId, card);
}

/** Get a card by partId */
export function getCard(partId: string): PartSemanticCard | undefined {
  return registry.get(partId);
}

/** Get all cards */
export function getAllCards(): PartSemanticCard[] {
  return Array.from(registry.values());
}

/** Get cards that have VLM labels */
export function getLabeledCards(): PartSemanticCard[] {
  return getAllCards().filter(c => c.vlmCategory !== undefined);
}

/**
 * Register a basic card (geometry only, no VLM yet).
 * Call this when parts are loaded.
 */
export function registerPartBasic(params: {
  partId: string;
  partName: string;
  displayName?: string;
  bboxSize?: [number, number, number];
  featureTypes?: string[];
  featureCount?: number;
}): PartSemanticCard {
  const existing = registry.get(params.partId);
  const card: PartSemanticCard = {
    partId: params.partId,
    partName: params.partName,
    displayName: params.displayName ?? existing?.displayName,
    geometrySummary: {
      bboxSize: params.bboxSize ?? existing?.geometrySummary.bboxSize,
      featureTypes: params.featureTypes ?? existing?.geometrySummary.featureTypes,
      featureCount: params.featureCount ?? existing?.geometrySummary.featureCount,
    },
    // Preserve existing VLM fields if card already exists
    vlmCategory: existing?.vlmCategory,
    vlmAliases: existing?.vlmAliases,
    vlmDescription: existing?.vlmDescription,
    vlmRoles: existing?.vlmRoles,
    confidence: existing?.confidence,
    lastUpdatedAt: existing?.lastUpdatedAt,
  };
  registry.set(params.partId, card);
  return card;
}

/**
 * Update a card with VLM label results.
 */
export function applyVlmLabel(partId: string, label: {
  vlmCategory?: string;
  vlmAliases?: string[];
  vlmDescription?: string;
  vlmRoles?: string[];
  confidence?: number;
}): PartSemanticCard | null {
  const card = registry.get(partId);
  if (!card) return null;
  const updated: PartSemanticCard = {
    ...card,
    ...label,
    lastUpdatedAt: new Date().toISOString(),
  };
  registry.set(partId, updated);
  return updated;
}

/**
 * Find parts whose VLM labels match a text query.
 * Returns scored candidates.
 */
export function findPartsByText(
  query: string,
  selectedPartIds?: Set<string>,
): Array<{ partId: string; partName: string; score: number; matchedSignals: string[]; semanticLabel: string; reason: string }> {
  const q = query.toLowerCase().trim();
  const qTokens = q.split(/[\s,，、]+/).filter(t => t.length > 0);
  const results: Array<{ partId: string; partName: string; score: number; matchedSignals: string[]; semanticLabel: string; reason: string }> = [];

  for (const card of registry.values()) {
    let score = 0;
    const matchedSignals: string[] = [];
    const reasons: string[] = [];

    // Selection bonus: if this part is selected, strong boost
    if (selectedPartIds?.has(card.partId)) {
      score += 0.5;
      matchedSignals.push('selection');
      reasons.push('selected in UI');
    }

    // VLM category match
    if (card.vlmCategory) {
      const catLower = card.vlmCategory.toLowerCase();
      for (const tok of qTokens) {
        if (catLower.includes(tok) || tok.includes(catLower)) {
          score += 0.4 * (card.confidence ?? 0.7);
          matchedSignals.push('vlm_category');
          reasons.push(`category "${card.vlmCategory}" matches "${tok}"`);
          break;
        }
      }
    }

    // VLM alias match
    if (card.vlmAliases) {
      for (const alias of card.vlmAliases) {
        const aliasLower = alias.toLowerCase();
        for (const tok of qTokens) {
          if (aliasLower.includes(tok) || tok.includes(aliasLower)) {
            score += 0.35 * (card.confidence ?? 0.7);
            matchedSignals.push('vlm_alias');
            reasons.push(`alias "${alias}" matches "${tok}"`);
            break;
          }
        }
        if (matchedSignals.includes('vlm_alias')) break;
      }
    }

    // VLM description match
    if (card.vlmDescription) {
      const descLower = card.vlmDescription.toLowerCase();
      for (const tok of qTokens) {
        if (tok.length >= 3 && descLower.includes(tok)) {
          score += 0.15 * (card.confidence ?? 0.7);
          matchedSignals.push('vlm_description');
          reasons.push(`description mentions "${tok}"`);
          break;
        }
      }
    }

    // Part name token match (weak fallback)
    const nameLower = card.partName.toLowerCase().replace(/[_\-\.]/g, ' ');
    const nameTokens = nameLower.split(/\s+/);
    for (const tok of qTokens) {
      if (tok.length >= 2 && nameTokens.some(nt => nt.includes(tok) || tok.includes(nt))) {
        score += 0.15;
        matchedSignals.push('name_token');
        reasons.push(`name "${card.partName}" token-matches "${tok}"`);
        break;
      }
    }

    if (score > 0.05) {
      const label = card.vlmCategory ?? card.partName;
      results.push({
        partId: card.partId,
        partName: card.partName,
        score: Math.min(1, score),
        matchedSignals: [...new Set(matchedSignals)],
        semanticLabel: label,
        reason: reasons.slice(0, 2).join('; ') || 'name match',
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
