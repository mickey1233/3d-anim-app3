import { VlmResultSchema } from '../../../shared/schema/index.js';
import { mockAnalyze } from './mockProvider.js';

export async function analyzeVlm(
  images: { name: string; data: string; mime: string }[],
  parts: { name: string }[]
) {
  // For now: mock provider only
  const result = await mockAnalyze(images, parts);
  return VlmResultSchema.parse(result);
}
