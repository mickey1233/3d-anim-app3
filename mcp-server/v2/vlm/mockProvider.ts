import type { VlmResult } from '../../../shared/schema/index.js';

export async function mockAnalyze(images: { name: string }[], parts: { name: string }[]): Promise<VlmResult> {
  const steps =
    images.length > 1
      ? images.slice(0, -1).map((img, i) => {
          const next = images[i + 1] ?? img;
          return {
          from_image: img.name,
          to_image: next.name,
          changes: ['object moved'],
          inferred_action: 'align object',
        };
        })
      : [];

  const objects = parts.slice(0, 2).map((p: { name: string }) => ({
    label: p.name.toLowerCase().includes('cap') ? 'cap' : p.name,
    description: `Mock object for ${p.name}`,
    confidence: 0.6,
  }));

  const mapping_candidates = objects.map((o: { label: string }) => ({
    label: o.label,
    scene_part_names: parts.map((p: { name: string }) => p.name),
    chosen: parts[0]?.name ?? '',
    confidence: 0.5,
  }));

  const first = parts[0];
  const second = parts[1];
  const assembly_command =
    first && second
      ? {
          source_label: first.name,
          target_label: second.name,
          source_face: 'bottom',
          target_face: 'top',
          mcp_text_command: `move ${first.name} bottom to ${second.name} top`,
        }
      : undefined;

  return { steps, objects, mapping_candidates, assembly_command };
}
