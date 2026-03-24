import React from 'react';
import { useV2Store, type AnchorMethodId } from '../../store/store';
import { v2Client } from '../../network/client';
import { getV2Renderer } from '../SceneRegistry';
import { ANCHOR_METHOD_VERIFY_ORDER } from './anchorMethods';

/**
 * AnchorVerifier — zero-UI component that runs VLM verification of anchor points
 * after they are computed by MatePreviewMarkers.
 *
 * When the anchor preview changes, it:
 * 1. Waits 2 animation frames for the scene to render with the anchor sphere visible.
 * 2. Captures a JPEG screenshot of the viewport.
 * 3. Sends it to the backend (anchor_verify command) for VLM verification.
 * 4. If VLM says the anchor is on the wrong face, advances to the next method in
 *    ANCHOR_METHOD_VERIFY_ORDER until one is confirmed correct.
 * 5. If all methods fail, sends a logFailure request so the backend writes to
 *    logs/anchor-verify-failures.jsonl for future algorithm improvement.
 */
export function AnchorVerifier() {
  const matePreview = useV2Store((s) => s.matePreview);
  const mateDraft = useV2Store((s) => s.mateDraft);
  const setMateDraft = useV2Store((s) => s.setMateDraft);
  const partById = useV2Store((s) => s.parts.byId);
  const isMateActive = useV2Store(
    (s) => s.interaction.mode === 'mate' || s.ui.workspaceSection === 'mate'
  );

  // Per-side tracking: which methods have been tried for the current (partId, faceId) pair.
  const sourceTriedMethods = React.useRef<Set<AnchorMethodId>>(new Set());
  const targetTriedMethods = React.useRef<Set<AnchorMethodId>>(new Set());
  const sourceVlmReasons = React.useRef<Record<string, string>>({});
  const targetVlmReasons = React.useRef<Record<string, string>>({});

  // Reset tracking when the part or face changes.
  React.useEffect(() => {
    sourceTriedMethods.current.clear();
    sourceVlmReasons.current = {};
  }, [mateDraft.sourceId, mateDraft.sourceFace]);

  React.useEffect(() => {
    targetTriedMethods.current.clear();
    targetVlmReasons.current = {};
  }, [mateDraft.targetId, mateDraft.targetFace]);

  // Anchor position keys — change only when the resolved anchor position actually moves.
  const sourcePosKey = matePreview.source?.positionWorld?.map(v => v.toFixed(4)).join(',') ?? '';
  const targetPosKey = matePreview.target?.positionWorld?.map(v => v.toFixed(4)).join(',') ?? '';

  React.useEffect(() => {
    if (!isMateActive) return;
    if (!sourcePosKey && !targetPosKey) return;

    let cancelled = false;

    const run = async () => {
      // Wait 2 animation frames so the renderer has drawn the anchor sphere.
      await new Promise<void>((res) =>
        requestAnimationFrame(() => requestAnimationFrame(() => res()))
      );
      if (cancelled) return;

      const renderer = getV2Renderer();
      if (!renderer) return;

      // Capture current viewport as JPEG.
      const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.72);
      const imageBase64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
      if (!imageBase64) return;

      const verifyAnchor = async (
        side: 'source' | 'target',
        posKey: string,
      ) => {
        if (!posKey) return; // anchor not yet resolved
        const isDraft = side === 'source';
        const partId = isDraft ? mateDraft.sourceId : mateDraft.targetId;
        const faceId = isDraft ? mateDraft.sourceFace : mateDraft.targetFace;
        const currentMethod = isDraft ? mateDraft.sourceMethod : mateDraft.targetMethod;
        const triedRef = isDraft ? sourceTriedMethods : targetTriedMethods;
        const reasonsRef = isDraft ? sourceVlmReasons : targetVlmReasons;

        if (!partId || !faceId) return;
        if (triedRef.current.has(currentMethod)) return; // already tried this method

        triedRef.current.add(currentMethod);
        const partName = partById[partId]?.name || partId;

        let result: { correct?: boolean; confidence?: number; reason?: string } = {};
        try {
          result = await (v2Client as any).request('anchor_verify', {
            imageBase64,
            mime: 'image/jpeg',
            faceId,
            partName,
          }) as typeof result;
        } catch {
          return; // network error — skip verification for this round
        }
        if (cancelled) return;

        if (result.correct === false) {
          reasonsRef.current[currentMethod] = result.reason || '';

          const nextMethod = ANCHOR_METHOD_VERIFY_ORDER.find(
            (m) => !triedRef.current.has(m)
          );
          if (nextMethod) {
            // Switch to next method — triggers re-resolution in MatePreviewMarkers.
            setMateDraft(isDraft ? { sourceMethod: nextMethod } : { targetMethod: nextMethod });
          } else {
            // All methods exhausted — log failure for future algorithm improvement.
            (v2Client as any).request('anchor_verify', {
              imageBase64: '',
              mime: 'image/jpeg',
              faceId,
              partName,
              logFailure: true,
              triedMethods: ANCHOR_METHOD_VERIFY_ORDER,
              vlmReasons: reasonsRef.current,
            }).catch(() => {});
          }
        }
      };

      await verifyAnchor('source', sourcePosKey);
      if (!cancelled) await verifyAnchor('target', targetPosKey);
    };

    run().catch(() => {});
    return () => { cancelled = true; };
  }, [sourcePosKey, targetPosKey, isMateActive]);

  return null;
}
