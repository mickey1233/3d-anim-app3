import { VlmResultSchema } from '../../../shared/schema/index.js';
import { mockAnalyze } from './mockProvider.js';
import { inferStructuredMateWithVlm } from './structuredMate.js';

const asObj = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' ? (value as Record<string, any>) : null;

export async function analyzeVlm(
  images: { name: string; data: string; mime: string }[],
  parts: { name: string }[],
  options?: { mateContext?: unknown }
) {
  const base = await mockAnalyze(images, parts, options);

  if (options?.mateContext) {
    const structured = await inferStructuredMateWithVlm(images, parts, options.mateContext);
    if (structured.mateInference) {
      const priorReason = typeof structured.mateInference.reason === 'string' ? structured.mateInference.reason : '';
      const providerNote = `provider=${structured.provider}`;
      const repairNote = `repair=${structured.repairAttempts}`;
      const diagnostics = {
        ...(asObj(base.mate_inference)?.diagnostics || {}),
        ...(asObj(structured.mateInference.diagnostics) || {}),
        provider: structured.provider,
        repair_attempts: structured.repairAttempts,
        fallback_used: false,
      };
      base.mate_inference = {
        ...(base.mate_inference || {}),
        ...structured.mateInference,
        diagnostics,
        reason: [priorReason, providerNote, repairNote].filter(Boolean).join(' | '),
      };
    } else if (base.mate_inference && structured.provider !== 'mock' && structured.provider !== 'none') {
      const fallbackReason = [
        typeof base.mate_inference.reason === 'string' ? base.mate_inference.reason : '',
        `fallback_mock(provider=${structured.provider})`,
        structured.error ? `err=${structured.error}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      base.mate_inference = {
        ...base.mate_inference,
        diagnostics: {
          ...(asObj(base.mate_inference)?.diagnostics || {}),
          provider: structured.provider,
          repair_attempts: structured.repairAttempts,
          fallback_used: true,
          ...(structured.error ? { provider_error: structured.error } : {}),
        },
        reason: fallbackReason,
      };
    }
  }

  return VlmResultSchema.parse(base);
}
