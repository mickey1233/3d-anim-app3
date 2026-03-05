import React from 'react';
import { useV2Store } from '../../store/store';
import { ENVIRONMENT_PRESETS } from '../../three/backgrounds/backgrounds';
import { callMcpTool, extractToolErrorMessage } from '../../network/mcpToolsClient';

const HELP_LINES = [
  'Examples:',
  'select <partName>',
  'mate <source> bottom to <target> top [--mode translate|twist|both]',
  '  --source-method planar_cluster|geometry_aabb|object_aabb|obb_pca|picked',
  '  --target-method planar_cluster|geometry_aabb|object_aabb|obb_pca|picked',
  '  --twist-axis normal|tangent|bitangent|x|y|z --twist-space world|source_face|target_face --twist-deg 180',
  'nudge x 0.01',
  'reset all',
  'env studio',
  'grid on',
];

export function useCommandRunner() {
  const parts = useV2Store((s) => s.parts);
  const selection = useV2Store((s) => s.selection.partId);
  const getPartTransform = useV2Store((s) => s.getPartTransform);

  const findPartId = React.useCallback(
    (name: string) => {
      const q = name.toLowerCase();
      const exact = parts.order.find((id) => parts.byId[id]?.name.toLowerCase() === q);
      if (exact) return exact;
      return parts.order.find((id) => parts.byId[id]?.name.toLowerCase().includes(q));
    },
    [parts]
  );

  const parseFace = (raw: string) => {
    const t = raw.toLowerCase();
    if (['top', 'up', '+y', 'y+'].includes(t)) return 'top';
    if (['bottom', 'down', '-y', 'y-'].includes(t)) return 'bottom';
    if (['left', '-x', 'x-'].includes(t)) return 'left';
    if (['right', '+x', 'x+'].includes(t)) return 'right';
    if (['front', '+z', 'z+'].includes(t)) return 'front';
    if (['back', '-z', 'z-'].includes(t)) return 'back';
    return null;
  };

  const runLocalCommand = React.useCallback(
    async (text: string) => {
      const tokens = text.trim().split(/\s+/);
      if (tokens.length === 0) return null;
      const head = tokens[0].toLowerCase();

      if (head === '/help' || head === 'help') {
        return HELP_LINES.join('\n');
      }

      if (head === 'env' && tokens[1]) {
        const next = tokens[1].toLowerCase();
        if (ENVIRONMENT_PRESETS.includes(next as any)) {
          const result = await callMcpTool('view.set_environment', { environment: next });
          if (!result.ok) return `Env failed: ${extractToolErrorMessage(result)}`;
          return `Environment set to ${next}`;
        }
        return `Unknown environment. Use: ${ENVIRONMENT_PRESETS.join(', ')}`;
      }

      if (head === 'grid' && tokens[1]) {
        const on = tokens[1].toLowerCase();
        if (on === 'on' || on === 'off') {
          const result = await callMcpTool('view.set_grid_visible', { visible: on === 'on' });
          if (!result.ok) return `Grid failed: ${extractToolErrorMessage(result)}`;
          return `Grid ${on}`;
        }
      }

      if (head === 'select' && tokens[1]) {
        const query = tokens.slice(1).join(' ');
        const result = await callMcpTool('selection.set', {
          selection: {
            kind: 'part',
            part: { partName: query },
          },
          replace: true,
          autoResolve: true,
        });

        if (!result.ok) {
          return `Select failed: ${extractToolErrorMessage(result)}`;
        }

        const resolvedName = (result.data as any)?.resolved?.part?.partName || query;
        return `Selected ${resolvedName}`;
      }

      if (head === 'reset') {
        if (tokens[1] === 'all') {
          const result = await callMcpTool('action.reset_all', {});
          if (!result.ok) return `Reset failed: ${extractToolErrorMessage(result)}`;
          return 'Reset all parts';
        }
        if (tokens[1] === 'part' && tokens[2]) {
          const id = findPartId(tokens.slice(2).join(' '));
          if (id) {
            const result = await callMcpTool('action.reset_part', { part: { partId: id } });
            if (!result.ok) return `Reset failed: ${extractToolErrorMessage(result)}`;
            return `Reset ${parts.byId[id]?.name || id}`;
          }
          return 'Part not found';
        }
      }

      if (head === 'nudge') {
        let partId: string | undefined;
        let axisToken: string | undefined;
        let deltaToken: string | undefined;
        if (tokens.length === 3) {
          partId = selection || undefined;
          axisToken = tokens[1];
          deltaToken = tokens[2];
        } else if (tokens.length >= 4) {
          partId = findPartId(tokens[1]);
          axisToken = tokens[2];
          deltaToken = tokens[3];
        }
        if (!partId) return 'Select a part or specify name';
        const axis = axisToken?.toLowerCase();
        const delta = deltaToken ? Number(deltaToken) : NaN;
        if (!axis || Number.isNaN(delta)) return 'Usage: nudge <part?> x|y|z <delta>';

        const deltaVec: [number, number, number] = [0, 0, 0];
        if (axis === 'x') deltaVec[0] = delta;
        if (axis === 'y') deltaVec[1] = delta;
        if (axis === 'z') deltaVec[2] = delta;

        const result = await callMcpTool('action.translate', {
          part: { partId },
          delta: deltaVec,
          space: 'world',
          previewOnly: false,
        });

        if (!result.ok) {
          return `Nudge failed: ${extractToolErrorMessage(result)}`;
        }

        return `Nudged ${parts.byId[partId]?.name || partId} ${axis} ${delta}`;
      }

      if (head === 'mate' && tokens.includes('to')) {
        const toIndex = tokens.indexOf('to');
        const modeIndex = tokens.findIndex((t) => t === '--mode' || t === 'mode');
        const getFlag = (flag: string) => {
          const idx = tokens.findIndex((t) => t === flag);
          return idx >= 0 ? tokens[idx + 1] : null;
        };

        const twistAxis = getFlag('--twist-axis');
        const twistSpace = getFlag('--twist-space');
        const twistDegToken = getFlag('--twist-deg');
        const sourceMethod = getFlag('--source-method');
        const targetMethod = getFlag('--target-method');
        const twistDeg = twistDegToken ? Number(twistDegToken) : NaN;
        const modeToken = modeIndex >= 0 ? tokens[modeIndex + 1] : null;
        const usableEnd = modeIndex >= 0 ? modeIndex : tokens.length;

        const sourceName = tokens.slice(1, toIndex - 1).join(' ');
        const sourceFaceToken = tokens[toIndex - 1];
        const targetName = tokens.slice(toIndex + 1, usableEnd - 1).join(' ');
        const targetFaceToken = tokens[usableEnd - 1];

        const sourceId = findPartId(sourceName);
        const targetId = findPartId(targetName);
        const sourceFace = parseFace(sourceFaceToken);
        const targetFace = parseFace(targetFaceToken);
        const mode =
          modeToken && ['translate', 'twist', 'both'].includes(modeToken.toLowerCase())
            ? modeToken.toLowerCase()
            : 'translate';

        const methodSet = new Set([
          'planar_cluster',
          'geometry_aabb',
          'object_aabb',
          'obb_pca',
          'picked',
        ]);

        const sm = sourceMethod ? sourceMethod.toLowerCase() : 'planar_cluster';
        const tm = targetMethod ? targetMethod.toLowerCase() : 'planar_cluster';

        if (!sourceId || !targetId || !sourceFace || !targetFace) {
          return 'Usage: mate <source> <face> to <target> <face> [--mode translate|twist|both]';
        }

        const operation = mode === 'both' ? 'both' : mode === 'twist' ? 'twist' : 'mate';
        const twist =
          twistAxis && twistSpace && !Number.isNaN(twistDeg)
            ? {
                angleDeg: twistDeg,
                axis: twistAxis.toLowerCase() as any,
                axisSpace: twistSpace.toLowerCase() as any,
                constraint: 'free' as const,
              }
            : {
                angleDeg: mode === 'twist' ? 45 : 0,
                axis: 'normal' as const,
                axisSpace: 'target_face' as const,
                constraint: 'free' as const,
              };

        const planResult = await callMcpTool('action.generate_transform_plan', {
          operation,
          source: {
            kind: 'face',
            part: { partId: sourceId },
            face: sourceFace as any,
            method: methodSet.has(sm) ? (sm as any) : 'planar_cluster',
          },
          target: {
            kind: 'face',
            part: { partId: targetId },
            face: targetFace as any,
            method: methodSet.has(tm) ? (tm as any) : 'planar_cluster',
          },
          mateMode: mode === 'both' ? 'face_insert_arc' : 'face_flush',
          pathPreference: mode === 'both' ? 'arc' : 'line',
          durationMs: 900,
          sampleCount: 60,
          flip: false,
          offset: 0,
          clearance: mode === 'both' ? 0.01 : 0,
          twist,
          arc: {
            height: mode === 'both' ? 0.08 : 0,
            lateralBias: 0,
          },
          autoCorrectSelection: true,
          autoSwapSourceTarget: true,
          enforceNormalPolicy: 'source_out_target_in',
        });

        if (!planResult.ok) {
          return `Plan failed: ${extractToolErrorMessage(planResult)}`;
        }

        const planId = (planResult.data as any)?.plan?.planId;
        if (!planId) return 'Plan failed: missing planId';

        const previewResult = await callMcpTool('preview.transform_plan', {
          planId,
          replaceCurrent: true,
          scrubT: 1,
        });

        if (!previewResult.ok) {
          return `Preview failed: ${extractToolErrorMessage(previewResult)}`;
        }

        const previewId = (previewResult.data as any)?.preview?.previewId;
        if (!previewId) {
          return 'Preview failed: missing previewId';
        }

        const commitResult = await callMcpTool('action.commit_preview', {
          previewId,
          pushHistory: true,
          stepLabel: `Mate ${parts.byId[sourceId]?.name || sourceId} to ${parts.byId[targetId]?.name || targetId}`,
        });

        if (!commitResult.ok) {
          return `Commit failed: ${extractToolErrorMessage(commitResult)}`;
        }

        return `Mate ${parts.byId[sourceId]?.name || sourceId} to ${parts.byId[targetId]?.name || targetId} (${mode})`;
      }

      const mateLike =
        head === 'mate' ||
        /(?:對齊|对齐|align|attach|裝到|装到|貼到|贴到|組裝|组装)/i.test(text);

      if (mateLike) {
        const mentioned = parts.order
          .map((id) => ({
            id,
            name: parts.byId[id]?.name || id,
            index: text.toLowerCase().indexOf((parts.byId[id]?.name || id).toLowerCase()),
          }))
          .filter((item) => item.index >= 0)
          .sort((left, right) => left.index - right.index);

        if (mentioned.length < 2) {
          return '請描述兩個零件名稱，例如：把 part1 對齊到 part2。';
        }

        const sourceId = mentioned[0].id;
        const targetId = mentioned[1].id;
        const mode = /(?:both|全部|一起|同時|arc)/i.test(text)
          ? 'both'
          : /(?:twist|rotate|旋轉|旋转)/i.test(text)
          ? 'twist'
          : 'translate';

        const operation = mode === 'both' ? 'both' : mode === 'twist' ? 'twist' : 'mate';
        const planResult = await callMcpTool('action.generate_transform_plan', {
          operation,
          source: {
            kind: 'face',
            part: { partId: sourceId },
            face: 'bottom',
            method: 'planar_cluster',
          },
          target: {
            kind: 'face',
            part: { partId: targetId },
            face: 'top',
            method: 'planar_cluster',
          },
          mateMode: mode === 'both' ? 'face_insert_arc' : 'face_flush',
          pathPreference: mode === 'both' ? 'arc' : 'line',
          durationMs: 900,
          sampleCount: 60,
          flip: false,
          offset: 0,
          clearance: mode === 'both' ? 0.01 : 0,
          twist: {
            angleDeg: mode === 'twist' ? 45 : 0,
            axis: 'normal' as const,
            axisSpace: 'target_face' as const,
            constraint: 'free' as const,
          },
          arc: {
            height: mode === 'both' ? 0.08 : 0,
            lateralBias: 0,
          },
          autoCorrectSelection: true,
          autoSwapSourceTarget: true,
          enforceNormalPolicy: 'source_out_target_in',
        });

        if (!planResult.ok) {
          return `Plan failed: ${extractToolErrorMessage(planResult)}`;
        }

        const planId = (planResult.data as any)?.plan?.planId;
        if (!planId) return 'Plan failed: missing planId';

        const previewResult = await callMcpTool('preview.transform_plan', {
          planId,
          replaceCurrent: true,
          scrubT: 1,
        });

        if (!previewResult.ok) {
          return `Preview failed: ${extractToolErrorMessage(previewResult)}`;
        }

        const previewId = (previewResult.data as any)?.preview?.previewId;
        if (!previewId) {
          return 'Preview failed: missing previewId';
        }

        const commitResult = await callMcpTool('action.commit_preview', {
          previewId,
          pushHistory: true,
          stepLabel: `Mate ${parts.byId[sourceId]?.name || sourceId} to ${parts.byId[targetId]?.name || targetId}`,
        });

        if (!commitResult.ok) {
          return `Commit failed: ${extractToolErrorMessage(commitResult)}`;
        }

        return `Mate ${parts.byId[sourceId]?.name || sourceId} to ${parts.byId[targetId]?.name || targetId} (${mode})`;
      }

      if (head === 'undo') {
        const result = await callMcpTool('history.undo', {});
        return result.ok ? 'Undo applied' : `Undo failed: ${extractToolErrorMessage(result)}`;
      }

      if (head === 'redo') {
        const result = await callMcpTool('history.redo', {});
        return result.ok ? 'Redo applied' : `Redo failed: ${extractToolErrorMessage(result)}`;
      }

      if (head === 'mode' && tokens[1]) {
        const modeToken = tokens[1].toLowerCase();
        const mode =
          modeToken === 'move' || modeToken === 'rotate' || modeToken === 'mate' || modeToken === 'select'
            ? modeToken
            : null;
        if (!mode) return 'Usage: mode move|rotate|mate|select';

        const result = await callMcpTool('mode.set_interaction_mode', {
          mode: mode as any,
          reason: 'command_bar',
        });
        return result.ok ? `Mode set to ${mode}` : `Mode failed: ${extractToolErrorMessage(result)}`;
      }

      if (head === 'status') {
        const result = await callMcpTool('ui.get_sync_state', {});
        if (!result.ok) return `Status failed: ${extractToolErrorMessage(result)}`;
        const state = (result.data as any)?.state;
        return `Mode=${state?.interactionMode || 'unknown'}, Preview=${state?.preview ? 'on' : 'off'}`;
      }

      const selectedTransform = selection ? getPartTransform(selection) : null;
      if (!selectedTransform) {
        return null;
      }

      return null;
    },
    [
      findPartId,
      getPartTransform,
      parts,
      selection,
    ]
  );

  return { runLocalCommand, helpText: HELP_LINES.join('\n') };
}
