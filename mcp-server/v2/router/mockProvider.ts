import type { ToolCall } from '../../../shared/schema/index.js';
import type { RouterContext, RouterProvider } from './types.js';

const findPart = (text: string, parts: RouterContext['parts']) => {
  const lower = text.toLowerCase();
  return parts.find((p: RouterContext['parts'][number]) => lower.includes(p.name.toLowerCase()));
};

const parseFace = (text: string) => {
  const lower = text.toLowerCase();
  if (lower.includes('top') || lower.includes('up') || lower.includes('上')) return 'top';
  if (lower.includes('bottom') || lower.includes('down') || lower.includes('下')) return 'bottom';
  if (lower.includes('left') || lower.includes('左')) return 'left';
  if (lower.includes('right') || lower.includes('右')) return 'right';
  if (lower.includes('front') || lower.includes('前')) return 'front';
  if (lower.includes('back') || lower.includes('後') || lower.includes('后')) return 'back';
  return null;
};

const parseMode = (text: string) => {
  const lower = text.toLowerCase();
    if (lower.includes('--mode')) {
    const parts = lower.split(/\s+/);
    const idx = parts.findIndex((p: string) => p === '--mode');
    const mode = idx >= 0 ? parts[idx + 1] : '';
    if (mode === 'translate' || mode === 'twist' || mode === 'both') return mode;
  }
  if (lower.includes('twist') || lower.includes('rotate') || lower.includes('旋轉') || lower.includes('旋转')) {
    return 'twist';
  }
  if (lower.includes('both') || lower.includes('full') || lower.includes('全部') || lower.includes('兩個')) {
    return 'both';
  }
  return 'translate';
};

const parseTwistSpec = (text: string) => {
  const parts = text.toLowerCase().split(/\s+/);
  const getFlag = (flag: string) => {
    const idx = parts.findIndex((p: string) => p === flag);
    return idx >= 0 ? parts[idx + 1] : null;
  };
  const axis = getFlag('--twist-axis');
  const axisSpace = getFlag('--twist-space');
  const deg = getFlag('--twist-deg');
  if (!axis || !axisSpace || !deg) return undefined;
  const angleDeg = Number(deg);
  if (Number.isNaN(angleDeg)) return undefined;
  return { axis, axisSpace, angleDeg };
};

export const MockRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext): Promise<ToolCall[]> {
    const lower = text.toLowerCase();
    const calls: ToolCall[] = [];

    if (lower.includes('select') || lower.includes('選') || lower.includes('选择') || lower.includes('選擇')) {
      const part = findPart(text, ctx.parts) || ctx.parts[0];
      if (part) {
        calls.push({ tool: 'select_part', args: { nameOrId: part.name }, confidence: 0.6 });
      }
      return calls;
    }

    if (
      lower.includes('mate') ||
      lower.includes('align') ||
      lower.includes('attach') ||
      lower.includes('對齊') ||
      lower.includes('貼') ||
      lower.includes('裝')
    ) {
      const source = findPart(text, ctx.parts) || ctx.parts[0];
      const target =
        ctx.parts.find((p: RouterContext['parts'][number]) => p.id !== source?.id) || ctx.parts[1];
      const sourceFace = parseFace(text) || 'bottom';
      const targetFace = parseFace(text) || 'top';
      const mode = parseMode(text);
      const twistSpec = parseTwistSpec(text);
      if (source && target) {
        calls.push({
          tool: 'mate_top_bottom',
          args: { sourceId: source.id, targetId: target.id, sourceFace, targetFace, mode, twistSpec },
          confidence: 0.55,
        });
      }
      return calls;
    }

    if (lower.includes('add step') || lower.includes('record')) {
      calls.push({ tool: 'add_step', args: { label: text }, confidence: 0.5 });
      return calls;
    }

    return calls;
  },
};
