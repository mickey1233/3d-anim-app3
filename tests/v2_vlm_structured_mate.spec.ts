import { test, expect } from '@playwright/test';

const buildMateContext = () => ({
  instruction: 'mate part2 to part1 and cover',
  sourcePartName: 'part2',
  targetPartName: 'part1',
  captureViews: [
    { name: 'overview', label: 'overview' },
    { name: 'top', label: 'top' },
    { name: 'source_to_target', label: 'source_to_target' },
  ],
  geometry: {
    intent: 'cover',
    suggestedMode: 'both',
    expectedFromCenters: { sourceFace: 'bottom', targetFace: 'top' },
    candidates: [
      {
        candidateIndex: 0,
        candidateKey: 'c0-bottom-top',
        sourceFace: 'bottom',
        targetFace: 'top',
        sourceMethod: 'planar_cluster',
        targetMethod: 'planar_cluster',
        score: 0.9,
        semanticScore: 0.95,
        tags: ['vertical_pair', 'cover_friendly', 'bottom_to_top'],
      },
      {
        candidateIndex: 1,
        candidateKey: 'c1-left-right',
        sourceFace: 'left',
        targetFace: 'right',
        sourceMethod: 'object_aabb',
        targetMethod: 'object_aabb',
        score: 0.4,
        semanticScore: 0.3,
        tags: ['lateral_pair'],
      },
    ],
  },
});

test.describe('v2 structured VLM mate inference', () => {
  test('retries after invalid JSON/object and repairs to valid structured mate output', async () => {
    const oldEnv = {
      V2_VLM_PROVIDER: process.env.V2_VLM_PROVIDER,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      VLM_MATE_TIMEOUT_MS: process.env.VLM_MATE_TIMEOUT_MS,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    };
    const oldFetch = globalThis.fetch;

    process.env.V2_VLM_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://fake-ollama';
    process.env.VLM_MATE_TIMEOUT_MS = '1500';
    delete process.env.GEMINI_API_KEY;

    const prompts: string[] = [];
    let chatCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      const href = String(url);
      if (href.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) } as any;
      }
      if (href.endsWith('/api/chat')) {
        chatCalls += 1;
        const body = JSON.parse(String(init?.body || '{}'));
        prompts.push(String(body?.messages?.[1]?.content || ''));
        const content =
          chatCalls === 1
            ? JSON.stringify({
                source_part_ref: 'part2',
                target_part_ref: 'part1',
                confidence: 0.51,
                reason: 'missing candidate pick',
                view_votes: [{ view_name: 'top', confidence: 0.42, reason: 'uncertain top view' }],
              })
            : JSON.stringify({
                selected_candidate_index: 0,
                selected_candidate_key: 'c0-bottom-top',
                source_part_ref: 'part2',
                target_part_ref: 'part1',
                source_face: 'bottom',
                target_face: 'top',
                source_method: 'planar_cluster',
                target_method: 'planar_cluster',
                mode: 'both',
                intent: 'cover',
                confidence: 0.89,
                reason: 'multi-view candidate ranking',
                view_votes: [
                  { view_name: 'top', candidate_index: 0, candidate_key: 'c0-bottom-top', confidence: 0.9 },
                  { view_name: 'source_to_target', candidate_index: 0, candidate_key: 'c0-bottom-top', confidence: 0.83 },
                ],
              });
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: { content } }),
        } as any;
      }
      throw new Error(`unexpected fetch url: ${href}`);
    }) as any;

    try {
      const { inferStructuredMateWithVlm } = await import('../mcp-server/v2/vlm/structuredMate.ts');
      const result = await inferStructuredMateWithVlm(
        [{ name: 'overview', data: 'iVBORw0KGgo=', mime: 'image/png' }],
        [{ name: 'part1' }, { name: 'part2' }],
        buildMateContext()
      );

      expect(result.provider).toBe('ollama');
      expect(result.repairAttempts).toBe(1);
      expect(result.error).toBeUndefined();
      expect(result.mateInference?.selected_candidate_index).toBe(0);
      expect(result.mateInference?.source_face).toBe('bottom');
      expect(result.mateInference?.target_face).toBe('top');
      expect(result.mateInference?.diagnostics?.candidate_selection_source).toBe('model');
      expect(result.mateInference?.diagnostics?.view_vote_count).toBe(2);
      expect(result.mateInference?.diagnostics?.selected_matches_consensus).toBe(true);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Previous output failed schema/context validation');
      expect(prompts[1]).toContain('missing candidate selection');
    } finally {
      globalThis.fetch = oldFetch;
      if (oldEnv.V2_VLM_PROVIDER === undefined) delete process.env.V2_VLM_PROVIDER;
      else process.env.V2_VLM_PROVIDER = oldEnv.V2_VLM_PROVIDER;
      if (oldEnv.OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = oldEnv.OLLAMA_BASE_URL;
      if (oldEnv.VLM_MATE_TIMEOUT_MS === undefined) delete process.env.VLM_MATE_TIMEOUT_MS;
      else process.env.VLM_MATE_TIMEOUT_MS = oldEnv.VLM_MATE_TIMEOUT_MS;
      if (oldEnv.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = oldEnv.GEMINI_API_KEY;
    }
  });

  test('derives selected candidate from view votes and normalizes fields without retry', async () => {
    const oldEnv = {
      V2_VLM_PROVIDER: process.env.V2_VLM_PROVIDER,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      VLM_MATE_TIMEOUT_MS: process.env.VLM_MATE_TIMEOUT_MS,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    };
    const oldFetch = globalThis.fetch;

    process.env.V2_VLM_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://fake-ollama';
    process.env.VLM_MATE_TIMEOUT_MS = '1500';
    delete process.env.GEMINI_API_KEY;

    let chatCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      const href = String(url);
      if (href.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) } as any;
      }
      if (href.endsWith('/api/chat')) {
        chatCalls += 1;
        const body = JSON.parse(String(init?.body || '{}'));
        expect(String(body?.messages?.[1]?.content || '')).toContain('Use multi-view voting');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: JSON.stringify({
                source_part_ref: ' Part2 ',
                target_part_ref: ' PART1 ',
                source_face: 'LEFT',
                target_face: 'RIGHT',
                source_method: 'AUTO',
                target_method: 'AUTO',
                mode: 'BOTH',
                intent: 'COVER',
                confidence: 1.4,
                reason: '  visual match with some drift  ',
                view_votes: [
                  { view_name: 'top', candidate_index: 0, candidate_key: 'c0-bottom-top', confidence: 1.2, reason: ' top ' },
                  { view_name: 'top', candidate_index: 1, candidate_key: 'c1-left-right', confidence: 0.1 },
                  { view_name: 'source_to_target', candidate_key: 'c0-bottom-top', confidence: 0.88 },
                ],
              }),
            },
          }),
        } as any;
      }
      throw new Error(`unexpected fetch url: ${href}`);
    }) as any;

    try {
      const { inferStructuredMateWithVlm } = await import('../mcp-server/v2/vlm/structuredMate.ts');
      const result = await inferStructuredMateWithVlm(
        [{ name: 'overview', data: 'iVBORw0KGgo=', mime: 'image/png' }],
        [{ name: 'part1' }, { name: 'part2' }],
        buildMateContext()
      );

      expect(result.provider).toBe('ollama');
      expect(result.repairAttempts).toBe(0);
      expect(chatCalls).toBe(1);
      expect(result.mateInference?.selected_candidate_index).toBe(0);
      expect(result.mateInference?.selected_candidate_key).toBe('c0-bottom-top');
      expect(result.mateInference?.source_part_ref).toBe('part2');
      expect(result.mateInference?.target_part_ref).toBe('part1');
      expect(result.mateInference?.source_face).toBe('bottom');
      expect(result.mateInference?.target_face).toBe('top');
      expect(result.mateInference?.source_method).toBe('planar_cluster');
      expect(result.mateInference?.target_method).toBe('planar_cluster');
      expect(result.mateInference?.mode).toBe('both');
      expect(result.mateInference?.intent).toBe('cover');
      expect(result.mateInference?.confidence).toBe(1);
      expect(result.mateInference?.view_votes).toHaveLength(2);
      expect(result.mateInference?.view_votes?.[0]?.confidence).toBe(1);
      expect(result.mateInference?.diagnostics?.candidate_selection_source).toBe('view_votes');
      expect(result.mateInference?.diagnostics?.selected_matches_consensus).toBe(true);
      expect(result.mateInference?.diagnostics?.consensus_candidate_key).toBe('c0-bottom-top');
      expect(result.mateInference?.diagnostics?.flags || []).toEqual(
        expect.arrayContaining([
          'selected_candidate_derived_from_view_votes',
          'candidate_field_sync_applied',
          'view_vote_deduped',
          'confidence_clamped',
          'part_ref_normalized',
        ])
      );
    } finally {
      globalThis.fetch = oldFetch;
      if (oldEnv.V2_VLM_PROVIDER === undefined) delete process.env.V2_VLM_PROVIDER;
      else process.env.V2_VLM_PROVIDER = oldEnv.V2_VLM_PROVIDER;
      if (oldEnv.OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = oldEnv.OLLAMA_BASE_URL;
      if (oldEnv.VLM_MATE_TIMEOUT_MS === undefined) delete process.env.VLM_MATE_TIMEOUT_MS;
      else process.env.VLM_MATE_TIMEOUT_MS = oldEnv.VLM_MATE_TIMEOUT_MS;
      if (oldEnv.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = oldEnv.GEMINI_API_KEY;
    }
  });

  test('analyzeVlm falls back to mock and annotates provider error when structured provider fails', async () => {
    const oldEnv = {
      V2_VLM_PROVIDER: process.env.V2_VLM_PROVIDER,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    };

    process.env.V2_VLM_PROVIDER = 'gemini';
    delete process.env.GEMINI_API_KEY;

    try {
      const { analyzeVlm } = await import('../mcp-server/v2/vlm/analyze.ts');
      const result = await analyzeVlm(
        [{ name: 'v1', data: 'iVBORw0KGgo=', mime: 'image/png' }],
        [{ name: 'part1' }, { name: 'part2' }],
        { mateContext: buildMateContext() }
      );

      expect(result.mate_inference).toBeTruthy();
      expect(result.mate_inference?.reason || '').toContain('fallback_mock(provider=gemini)');
      expect(result.mate_inference?.reason || '').toContain('err=gemini_key_missing');
      expect(result.mate_inference?.diagnostics?.provider).toBe('gemini');
      expect(result.mate_inference?.diagnostics?.fallback_used).toBe(true);
      expect(result.mate_inference?.diagnostics?.provider_error).toBe('gemini_key_missing');
    } finally {
      if (oldEnv.V2_VLM_PROVIDER === undefined) delete process.env.V2_VLM_PROVIDER;
      else process.env.V2_VLM_PROVIDER = oldEnv.V2_VLM_PROVIDER;
      if (oldEnv.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = oldEnv.GEMINI_API_KEY;
    }
  });
});
