import type { ToolCall } from '../../../shared/schema/index.js';
import type { RouterContext, RouterProvider } from './types.js';
import { answerGeneralQuestionWithLlm, inferMateWithLlm } from './llmAssist.js';

type MentionedPart = RouterContext['parts'][number] & {
  index: number;
  end: number;
  volume: number;
};

const GRID_KEYWORDS = ['grid', '格線', '网格', '格子'];
const GRID_ON_KEYWORDS = ['on', 'show', '顯示', '显示', '打開', '打开', '開啟', '开启', '開'];
const GRID_OFF_KEYWORDS = ['off', 'hide', '隱藏', '隐藏', '關閉', '关闭', '關掉', '关掉', '關'];
const RESET_KEYWORDS = ['reset', '還原', '还原', '重置', '回復', '恢复'];
const ALL_KEYWORDS = ['all', '全部', '全部零件', '所有'];
const SELECT_KEYWORDS = ['select', '選', '选择', '選擇', '挑', 'pick', '選取'];
const MODE_KEYWORDS = ['mode', '模式'];
const GREETING_KEYWORDS = ['你好', '嗨', 'hello', 'hi', '早安', '午安', '晚安', '在嗎', '在吗'];
const THANKS_KEYWORDS = ['謝謝', 'thanks', 'thank you'];
const QUESTION_KEYWORDS = ['?', '？', '如何', '怎麼', '怎么', 'what', 'what is', 'how', 'can i', '可以', '是什麼', '是什么'];

const STEP_COMMAND_KEYWORDS = ['新增step', '新增 step', 'add step', 'create step', 'new step', '建立步驟', '建立步骤'];
const STEP_HELP_KEYWORDS = ['step 怎麼', 'step怎么', 'how to add step', '怎麼新增step', '如何新增step', 'step 要怎麼'];
const CHAT_HELP_KEYWORDS = ['help', '/help', '可以做什麼', '你會什麼', '你能做什麼', '有哪些功能'];
const MODEL_INFO_KEYWORDS = ['usd', 'model', '模型', '這個模型', '这个模型', '這是什麼', '这是什么'];
const MATE_KEYWORDS = ['mate', '對齊', '对齐', '組裝', '组装', '裝配', '装配', 'align', 'attach', 'fit'];

const containsAny = (text: string, keywords: string[]) => keywords.some((keyword) => text.includes(keyword));

const volumeFromSize = (size?: [number, number, number]) => {
  if (!size) return 1;
  return Math.max(1e-6, Math.abs(size[0] * size[1] * size[2]));
};

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeToken = (text: string) => normalizeText(text).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

const findPart = (text: string, parts: RouterContext['parts']) => {
  const lower = normalizeText(text);
  const tokenized = normalizeToken(text);
  let best: RouterContext['parts'][number] | null = null;
  let bestScore = -1;

  for (const part of parts) {
    const name = normalizeText(part.name);
    const nameToken = normalizeToken(part.name);
    const idToken = normalizeToken(part.id);
    let score = -1;
    if (lower === name) score = 200;
    else if (lower.includes(name)) score = 120 + name.length;
    else if (name.includes(lower)) score = 60 + lower.length;
    else if (tokenized === nameToken || tokenized === idToken) score = 110;
    else if (tokenized && (nameToken.includes(tokenized) || idToken.includes(tokenized))) score = 80 + tokenized.length;
    else if (tokenized && (tokenized.includes(nameToken) || tokenized.includes(idToken))) score = 65 + nameToken.length;

    if (score > bestScore) {
      bestScore = score;
      best = part;
    }
  }

  return bestScore >= 0 ? best : null;
};

const collectMentionedParts = (text: string, parts: RouterContext['parts']): MentionedPart[] => {
  const lower = normalizeText(text);
  const tokenizedText = normalizeToken(text);
  const found: MentionedPart[] = [];
  const seen = new Set<string>();

  const sorted = [...parts].sort((left, right) => right.name.length - left.name.length);
  for (const part of sorted) {
    const name = normalizeText(part.name);
    const nameToken = normalizeToken(part.name);
    const idToken = normalizeToken(part.id);
    const index = lower.indexOf(name);
    const tokenHit = tokenizedText.includes(nameToken) || tokenizedText.includes(idToken);
    if (index < 0 && !tokenHit) continue;
    if (seen.has(part.id)) continue;
    seen.add(part.id);
    found.push({
      ...part,
      index: index >= 0 ? index : Number.MAX_SAFE_INTEGER - found.length,
      end: index >= 0 ? index + name.length : Number.MAX_SAFE_INTEGER - found.length + 1,
      volume: volumeFromSize(part.bboxSize),
    });
  }

  return found.sort((left, right) => left.index - right.index);
};

const FACE_ALIASES: Array<{ face: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back'; aliases: string[] }> = [
  { face: 'top', aliases: ['top', 'up', '上', '上面', '頂部', '顶部', '+y', 'y+'] },
  { face: 'bottom', aliases: ['bottom', 'down', '下', '下面', '底', '底部', '-y', 'y-'] },
  { face: 'left', aliases: ['left', '左', '左側', '左侧', '-x', 'x-'] },
  { face: 'right', aliases: ['right', '右', '右側', '右侧', '+x', 'x+'] },
  { face: 'front', aliases: ['front', '前', '前面', '+z', 'z+'] },
  { face: 'back', aliases: ['back', '後', '后', '後面', '后面', '-z', 'z-'] },
];

const detectFaceFromSegment = (
  segment: string,
  prefer: 'first' | 'last' = 'first'
): 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | null => {
  const normalized = normalizeText(segment);
  let selectedFace: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | null = null;
  let selectedIndex = prefer === 'first' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;

  for (const item of FACE_ALIASES) {
    for (const alias of item.aliases) {
      if (!alias.trim()) continue;
      let start = 0;
      while (start < normalized.length) {
        const index = normalized.indexOf(alias, start);
        if (index < 0) break;
        if (
          (prefer === 'first' && index < selectedIndex) ||
          (prefer === 'last' && index > selectedIndex)
        ) {
          selectedIndex = index;
          selectedFace = item.face;
        }
        start = index + Math.max(alias.length, 1);
      }
    }
  }

  return selectedFace;
};

const detectFaceNear = (
  text: string,
  partName: string,
  partIndex: number,
  partEnd: number
): 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | null => {
  const lower = normalizeText(text);
  const before = lower.slice(Math.max(0, partIndex - 24), partIndex);
  const after = lower.slice(partEnd, Math.min(lower.length, partEnd + 24));
  const directAfter = detectFaceFromSegment(after, 'first');
  if (directAfter) return directAfter;
  const directBefore = detectFaceFromSegment(before, 'last');
  if (directBefore) return directBefore;

  const name = partName.toLowerCase();
  for (const item of FACE_ALIASES) {
    for (const alias of item.aliases) {
      if (lower.includes(`${name} ${alias}`) || lower.includes(`${alias} ${name}`)) return item.face;
    }
  }
  return null;
};

const METHOD_ALIASES: Array<{
  method: 'auto' | 'planar_cluster' | 'geometry_aabb' | 'object_aabb' | 'extreme_vertices' | 'obb_pca' | 'picked';
  aliases: string[];
}> = [
  { method: 'object_aabb', aliases: ['object aabb', 'object_aabb', 'obj aabb', 'whole object', '物件aabb', '对象aabb'] },
  { method: 'geometry_aabb', aliases: ['geometry aabb', 'geometry_aabb', 'mesh aabb', 'geo aabb', '幾何aabb', '几何aabb'] },
  { method: 'planar_cluster', aliases: ['planar cluster', 'planar_cluster', '平面分群', '平面聚類', '平面聚类'] },
  { method: 'extreme_vertices', aliases: ['extreme vertices', 'extreme_vertices', '極值點', '极值点'] },
  { method: 'obb_pca', aliases: ['obb', 'pca', 'obb pca', 'obb_pca'] },
  { method: 'picked', aliases: ['picked', 'pick face', 'clicked face', '手動選面', '手动选面'] },
  { method: 'auto', aliases: ['auto', '自動', '自动'] },
];

const detectAnchorMethod = (text: string) => {
  const lower = normalizeText(text);
  for (const item of METHOD_ALIASES) {
    if (containsAny(lower, item.aliases)) return item.method;
  }
  return 'auto' as const;
};

const hasAnchorMethodMention = (text: string) => {
  const lower = normalizeText(text);
  return METHOD_ALIASES.some((item) => containsAny(lower, item.aliases));
};

const detectExplicitMateMode = (text: string): 'translate' | 'twist' | 'both' | null => {
  const lower = normalizeText(text);
  if (containsAny(lower, ['both', 'arc', 'insert', 'cover', '插入', '蓋上', '盖上', '弧線', '弧线'])) return 'both';
  if (containsAny(lower, ['twist', 'rotate', '旋轉', '旋转'])) return 'twist';
  if (containsAny(lower, ['translate', 'move only', '平移', '只移動', '只移动'])) return 'translate';
  return null;
};

type MateFaceId = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
type MateMethodId =
  | 'auto'
  | 'planar_cluster'
  | 'geometry_aabb'
  | 'object_aabb'
  | 'extreme_vertices'
  | 'obb_pca'
  | 'picked';
type MateModeId = 'translate' | 'twist' | 'both';

type MateSuggestionPick = {
  sourceFace?: MateFaceId;
  targetFace?: MateFaceId;
  sourceMethod?: MateMethodId;
  targetMethod?: MateMethodId;
  score?: number;
};

type MateSuggestionContext = {
  sourcePartId?: string;
  targetPartId?: string;
  suggestedMode?: MateModeId;
  intent?: string;
  expectedFromCenters?: {
    sourceFace?: MateFaceId;
    targetFace?: MateFaceId;
  };
  rankingTop?: MateSuggestionPick;
};

const MATE_FACE_IDS: MateFaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
const MATE_METHOD_IDS: MateMethodId[] = [
  'auto',
  'planar_cluster',
  'geometry_aabb',
  'object_aabb',
  'extreme_vertices',
  'obb_pca',
  'picked',
];
const MATE_MODE_IDS: MateModeId[] = ['translate', 'twist', 'both'];

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asMateFace = (value: unknown): MateFaceId | undefined =>
  typeof value === 'string' && MATE_FACE_IDS.includes(value as MateFaceId) ? (value as MateFaceId) : undefined;

const asMateMethod = (value: unknown): MateMethodId | undefined =>
  typeof value === 'string' && MATE_METHOD_IDS.includes(value as MateMethodId) ? (value as MateMethodId) : undefined;

const asMateMode = (value: unknown): MateModeId | undefined =>
  typeof value === 'string' && MATE_MODE_IDS.includes(value as MateModeId) ? (value as MateModeId) : undefined;

const extractSuggestionData = (result: unknown) => {
  const root = asObject(result);
  if (!root) return null;
  const rootData = asObject(root.data);
  if (rootData) return rootData;
  const nestedResult = asObject(root.result);
  if (!nestedResult) return root;
  const nestedData = asObject(nestedResult.data);
  return nestedData || nestedResult;
};

const extractMateSuggestionContext = (
  ctx: RouterContext,
  sourcePartId?: string,
  targetPartId?: string
): MateSuggestionContext | null => {
  const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const item = toolResults[index];
    if (!item || item.tool !== 'query.mate_suggestions' || !item.ok) continue;
    const data = extractSuggestionData(item.result);
    if (!data) continue;

    const sourceObj = asObject(data.source);
    const targetObj = asObject(data.target);
    const resultSourceId =
      (typeof sourceObj?.partId === 'string' ? sourceObj.partId : undefined) ||
      (typeof sourceObj?.partName === 'string' ? sourceObj.partName : undefined);
    const resultTargetId =
      (typeof targetObj?.partId === 'string' ? targetObj.partId : undefined) ||
      (typeof targetObj?.partName === 'string' ? targetObj.partName : undefined);

    if (sourcePartId && targetPartId) {
      if (resultSourceId && resultTargetId) {
        if (resultSourceId !== sourcePartId || resultTargetId !== targetPartId) continue;
      }
    }

    const ranking = Array.isArray(data.ranking) ? data.ranking : [];
    const rankingTop = ranking.length > 0 ? asObject(ranking[0]) : null;
    const expected = asObject(data.expectedFromCenters);
    return {
      sourcePartId: resultSourceId,
      targetPartId: resultTargetId,
      suggestedMode: asMateMode(data.suggestedMode),
      intent: typeof data.intent === 'string' ? data.intent : undefined,
      expectedFromCenters: expected
        ? {
            sourceFace: asMateFace(expected.sourceFace),
            targetFace: asMateFace(expected.targetFace),
          }
        : undefined,
      rankingTop: rankingTop
        ? {
            sourceFace: asMateFace(rankingTop.sourceFace),
            targetFace: asMateFace(rankingTop.targetFace),
            sourceMethod: asMateMethod(rankingTop.sourceMethod),
            targetMethod: asMateMethod(rankingTop.targetMethod),
            score: typeof rankingTop.score === 'number' ? Number(rankingTop.score) : undefined,
          }
        : undefined,
    };
  }
  return null;
};

const inferSourceTarget = (text: string, mentioned: MentionedPart[], _ctx: RouterContext) => {
  const lower = normalizeText(text);
  const first = mentioned[0];
  const second = mentioned[1];
  if (!first || !second) return null;

  let source = first;
  let target = second;
  let explicitDirection = false;
  let sourceFromKeyword = false;
  let targetFromKeyword = false;

  const sourceKeywords = [' source ', '來源', '来源', '從', '从'];
  const targetKeywords = [' target ', '目標', '目标', '到', '向', ' into ', ' onto ', ' to '];

  const sourceNearFirst = sourceKeywords.some((token) => {
    const before = lower.slice(Math.max(0, first.index - 20), first.index);
    const after = lower.slice(first.end, Math.min(lower.length, first.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });
  const sourceNearSecond = sourceKeywords.some((token) => {
    const before = lower.slice(Math.max(0, second.index - 20), second.index);
    const after = lower.slice(second.end, Math.min(lower.length, second.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });
  const targetNearFirst = targetKeywords.some((token) => {
    const before = lower.slice(Math.max(0, first.index - 20), first.index);
    const after = lower.slice(first.end, Math.min(lower.length, first.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });
  const targetNearSecond = targetKeywords.some((token) => {
    const before = lower.slice(Math.max(0, second.index - 20), second.index);
    const after = lower.slice(second.end, Math.min(lower.length, second.end + 20));
    return before.includes(token.trim()) || after.includes(token.trim());
  });

  if (sourceNearFirst && targetNearSecond) {
    source = first;
    target = second;
    explicitDirection = true;
    sourceFromKeyword = true;
    targetFromKeyword = true;
  } else if (sourceNearSecond && targetNearFirst) {
    source = second;
    target = first;
    explicitDirection = true;
    sourceFromKeyword = true;
    targetFromKeyword = true;
  }

  const directionTokens = [' to ', ' into ', ' onto ', ' -> ', ' 到 ', '到', '對齊到', '对齐到'];
  let directionIndex = -1;
  for (const token of directionTokens) {
    directionIndex = lower.indexOf(token);
    if (directionIndex >= 0) break;
  }
  if (directionIndex >= 0) {
    const before = [...mentioned].filter((item) => item.index < directionIndex).pop();
    const after = mentioned.find((item) => item.index > directionIndex);
    if (before && after && before.id !== after.id) {
      source = before;
      target = after;
      explicitDirection = true;
    }
  }

  if (!explicitDirection && !sourceFromKeyword && !targetFromKeyword) {
    const placementKeywords = ['install', 'mount', 'place', 'put', 'attach', '插入', '放進', '放入', '安裝'];
    const hasPlacementVerb = containsAny(lower, placementKeywords);
    if (hasPlacementVerb) {
      const targetNameKeywords = ['base', 'ground', 'floor', 'table', 'platform', 'body', 'chassis', 'frame', '底座', '地面'];
      const firstLooksLikeTarget = targetNameKeywords.some((kw) => first.name.toLowerCase().includes(kw));
      const secondLooksLikeTarget = targetNameKeywords.some((kw) => second.name.toLowerCase().includes(kw));
      if (firstLooksLikeTarget !== secondLooksLikeTarget) {
        target = firstLooksLikeTarget ? first : second;
        source = target.id === first.id ? second : first;
      } else if (Math.max(first.volume, second.volume) / Math.min(first.volume, second.volume) >= 1.4) {
        target = first.volume >= second.volume ? first : second;
        source = target.id === first.id ? second : first;
      }
    }
  }

  return { source, target, explicitDirection };
};

const formatModelSummary = (ctx: RouterContext) => {
  const fileLabel = ctx.cadFileName ? `\`${ctx.cadFileName}\`` : '目前模型';
  const names = ctx.parts.slice(0, 6).map((part) => part.name);
  const partsLine =
    names.length > 0
      ? `${ctx.parts.length} 個零件：${names.join('、')}${ctx.parts.length > names.length ? '…' : ''}`
      : '目前尚未載入可辨識零件';
  const stepLine = typeof ctx.stepCount === 'number' ? `目前 steps：${ctx.stepCount}` : '目前 steps：未知';
  return `${fileLabel}，包含 ${partsLine}。${stepLine}。`;
};

const ENVIRONMENT_ALIASES: Array<{ alias: string; environment: string }> = [
  { alias: 'warehouse', environment: 'warehouse' },
  { alias: '倉庫', environment: 'warehouse' },
  { alias: '仓库', environment: 'warehouse' },
  { alias: 'studio', environment: 'studio' },
  { alias: '工作室', environment: 'studio' },
  { alias: 'city', environment: 'city' },
  { alias: '城市', environment: 'city' },
  { alias: 'sunset', environment: 'sunset' },
  { alias: '黃昏', environment: 'sunset' },
  { alias: '黄昏', environment: 'sunset' },
  { alias: 'dawn', environment: 'dawn' },
  { alias: '清晨', environment: 'dawn' },
  { alias: 'night', environment: 'night' },
  { alias: '夜晚', environment: 'night' },
  { alias: 'forest', environment: 'forest' },
  { alias: '森林', environment: 'forest' },
  { alias: 'apartment', environment: 'apartment' },
  { alias: '公寓', environment: 'apartment' },
  { alias: 'lobby', environment: 'lobby' },
  { alias: '大廳', environment: 'lobby' },
  { alias: '大厅', environment: 'lobby' },
  { alias: 'park', environment: 'park' },
  { alias: '公園', environment: 'park' },
  { alias: '公园', environment: 'park' },
];

const detectEnvironment = (text: string) => {
  for (const item of ENVIRONMENT_ALIASES) {
    if (text.includes(item.alias.toLowerCase())) return item.environment;
  }
  return null;
};

const detectMode = (text: string): 'select' | 'move' | 'rotate' | 'mate' | null => {
  if (containsAny(text, ['rotate', '旋轉', '旋转', '轉動', '转动'])) return 'rotate';
  if (containsAny(text, ['move', '移動', '移动', '平移'])) return 'move';
  if (containsAny(text, ['mate', '對齊', '对齐', '組裝', '组装', '裝配', '装配'])) return 'mate';
  if (containsAny(text, ['select mode', '選取模式', '选择模式'])) return 'select';
  return null;
};

const looksLikeStepQuestion = (text: string) =>
  containsAny(text, STEP_HELP_KEYWORDS) || (containsAny(text, ['step']) && containsAny(text, QUESTION_KEYWORDS));

const looksLikeGeneralQuestion = (text: string) =>
  containsAny(text, QUESTION_KEYWORDS) ||
  text.endsWith('?') ||
  text.endsWith('？') ||
  containsAny(text, ['請問', '可否', '能不能', '是不是', '是否']);

const buildStepHelpReply = () =>
  [
    '你可以直接問我，也可以直接下指令。',
    '新增 step 指令範例：',
    '- `新增 step 安裝定位`',
    '- `add step align cap to body`',
    '或先做完一個操作後輸入 `更新這個 step` / `save step`。',
  ].join('\n');

export const MockRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext) {
    const lower = normalizeText(text);
    const calls: ToolCall[] = [];

    if (!lower.trim()) {
      return { toolCalls: [], replyText: '請先輸入你想做的事。' };
    }

    if (containsAny(lower, GREETING_KEYWORDS)) {
      return {
        toolCalls: [],
        replyText:
          '你好，我可以聊天，也可以直接控制 3D 功能。你可以說「mate part1 and part2」或「如何新增step」。',
      };
    }

    if (containsAny(lower, THANKS_KEYWORDS)) {
      return { toolCalls: [], replyText: '不客氣。你可以直接用自然句子說你要做的操作。' };
    }

    if (looksLikeStepQuestion(lower)) {
      return { toolCalls: [], replyText: buildStepHelpReply() };
    }

    if (containsAny(lower, STEP_COMMAND_KEYWORDS) && !containsAny(lower, QUESTION_KEYWORDS)) {
      const match = text.match(/(?:新增\s*step|add step|create step|new step)\s+(.+)/i);
      const label = (match?.[1] || 'New Step').trim().slice(0, 80);
      calls.push({
        tool: 'steps.add',
        args: { label, select: true },
        confidence: 0.9,
      });
      return { toolCalls: calls, replyText: `已新增 step：${label}` };
    }

    if (containsAny(lower, CHAT_HELP_KEYWORDS)) {
      return {
        toolCalls: [],
        replyText: [
          '可直接對我說：',
          '- `mate part1 and part2`',
          '- `mate part1 bottom and part2 top use object aabb method`',
          '- `切到 rotate 模式`、`把格線關掉`、`重置全部`',
          '- `這個 usd 模型是什麼`、`如何新增 step`',
        ].join('\n'),
      };
    }

    if (containsAny(lower, MODEL_INFO_KEYWORDS)) {
      return {
        toolCalls: [],
        replyText: `模型資訊：${formatModelSummary(ctx)}`,
      };
    }

    if (containsAny(lower, ['undo', '撤銷', '撤销', '上一步'])) {
      calls.push({ tool: 'history.undo', args: {}, confidence: 0.92 });
      return { toolCalls: calls, replyText: '已幫你執行復原。' };
    }

    if (containsAny(lower, ['redo', '重做', '恢復', '恢复'])) {
      calls.push({ tool: 'history.redo', args: {}, confidence: 0.92 });
      return { toolCalls: calls, replyText: '已幫你執行重做。' };
    }

    if (containsAny(lower, RESET_KEYWORDS)) {
      const resetAll = containsAny(lower, ALL_KEYWORDS);
      if (resetAll) {
        calls.push({ tool: 'action.reset_all', args: {}, confidence: 0.9 });
        return { toolCalls: calls, replyText: '已重置全部零件。' };
      }

      const part = findPart(lower, ctx.parts);
      if (part) {
        calls.push({
          tool: 'action.reset_part',
          args: { part: { partId: part.id } },
          confidence: 0.86,
        });
        return { toolCalls: calls, replyText: `已重置 ${part.name}。` };
      }

      calls.push({ tool: 'action.reset_all', args: {}, confidence: 0.6 });
      return { toolCalls: calls, replyText: '沒有辨識到指定零件，已先重置全部零件。' };
    }

    if (containsAny(lower, GRID_KEYWORDS)) {
      const turnOn = containsAny(lower, GRID_ON_KEYWORDS);
      const turnOff = containsAny(lower, GRID_OFF_KEYWORDS);
      if (turnOn || turnOff) {
        calls.push({
          tool: 'view.set_grid_visible',
          args: { visible: turnOn && !turnOff },
          confidence: 0.92,
        });
        return { toolCalls: calls, replyText: turnOn && !turnOff ? '格線已開啟。' : '格線已關閉。' };
      }
      return { toolCalls: [], replyText: '你要我把格線打開還是關掉？' };
    }

    const env = detectEnvironment(lower);
    if (env) {
      calls.push({
        tool: 'view.set_environment',
        args: { environment: env },
        confidence: 0.9,
      });
      return { toolCalls: calls, replyText: `環境已切換到 ${env}。` };
    }

    const mentioned = collectMentionedParts(text, ctx.parts);
    const mateLike = containsAny(lower, MATE_KEYWORDS) || (lower.includes(' and ') && mentioned.length >= 2);
    if (mateLike) {
      if (mentioned.length < 2) {
        return {
          toolCalls: [],
          replyText: '我需要兩個零件名稱才能執行 mate，例如：`mate part1 and part2`。',
        };
      }

      const inferred = inferSourceTarget(text, mentioned, ctx);
      if (!inferred) {
        return {
          toolCalls: [],
          replyText: '我有偵測到零件名稱，但無法判定 source/target。請再描述一次「A 到 B」。',
        };
      }

      let source = inferred.source;
      let target = inferred.target;
      let mode = detectExplicitMateMode(text) ?? undefined;
      const detectedSourceFace = detectFaceNear(text, inferred.source.name, inferred.source.index, inferred.source.end);
      const detectedTargetFace = detectFaceNear(text, inferred.target.name, inferred.target.index, inferred.target.end);
      let sourceFace = detectedSourceFace || undefined;
      let targetFace = detectedTargetFace || undefined;
      const methodMentioned = hasAnchorMethodMention(text);
      const detectedMethod = detectAnchorMethod(text);
      let sourceMethod = methodMentioned ? detectedMethod : undefined;
      let targetMethod = methodMentioned ? detectedMethod : undefined;

      const explicitSourceFace = detectedSourceFace !== null;
      const explicitTargetFace = detectedTargetFace !== null;
      const explicitFace = explicitSourceFace || explicitTargetFace;
      const explicitMethod = methodMentioned;
      const explicitMode = mode !== undefined;
      const explicitDirection = Boolean(inferred.explicitDirection);
      const hasMateSuggestionContext = Boolean(extractMateSuggestionContext(ctx));

      if ((!explicitFace || !explicitMethod || !explicitMode) && !hasMateSuggestionContext) {
        const llmInference = await inferMateWithLlm(text, ctx);
        if (llmInference) {
          if (!explicitDirection && Number(llmInference.confidence ?? 0) >= 0.82) {
            const sourceCandidate = mentioned.find((part) => part.id === llmInference.sourcePartId);
            const targetCandidate = mentioned.find((part) => part.id === llmInference.targetPartId);
            if (sourceCandidate && targetCandidate && sourceCandidate.id !== targetCandidate.id) {
              source = sourceCandidate;
              target = targetCandidate;
            }
          }
          if (!explicitMode && llmInference.mode) mode = llmInference.mode;
          if (!explicitSourceFace && llmInference.sourceFace) sourceFace = llmInference.sourceFace;
          if (!explicitTargetFace && llmInference.targetFace) targetFace = llmInference.targetFace;
          if (!explicitMethod && llmInference.sourceMethod) sourceMethod = llmInference.sourceMethod;
          if (!explicitMethod && llmInference.targetMethod) targetMethod = llmInference.targetMethod;
        }
      }

      const suggestionContext = extractMateSuggestionContext(ctx, source.id, target.id);
      const needsSuggestionRound = (!explicitFace || !explicitMethod || !explicitMode) && !suggestionContext;
      if (needsSuggestionRound) {
        calls.push({
          tool: 'query.mate_suggestions',
          args: {
            sourcePart: { partId: source.id },
            targetPart: { partId: target.id },
            instruction: text,
            ...(sourceFace ? { preferredSourceFace: sourceFace } : {}),
            ...(targetFace ? { preferredTargetFace: targetFace } : {}),
            sourceMethod: sourceMethod ?? 'auto',
            targetMethod: targetMethod ?? 'auto',
            maxPairs: 12,
          },
          confidence: 0.94,
        });
        return {
          toolCalls: calls,
          replyText: `正在分析 ${source.name} 與 ${target.name} 的接觸面與裝配方式，接著會自動執行 mate。`,
        };
      }

      const rankingTop = suggestionContext?.rankingTop;
      const expectedFromCenters = suggestionContext?.expectedFromCenters;
      const useSuggestedMethod = suggestionContext?.intent === 'insert';
      const resolvedSourceFace =
        sourceFace ?? rankingTop?.sourceFace ?? expectedFromCenters?.sourceFace ?? 'bottom';
      const resolvedTargetFace =
        targetFace ?? rankingTop?.targetFace ?? expectedFromCenters?.targetFace ?? 'top';
      const resolvedSourceMethod =
        sourceMethod ?? (useSuggestedMethod ? rankingTop?.sourceMethod : undefined) ?? 'auto';
      const resolvedTargetMethod =
        targetMethod ?? (useSuggestedMethod ? rankingTop?.targetMethod : undefined) ?? 'auto';
      const resolvedMode = mode ?? suggestionContext?.suggestedMode ?? 'translate';

      calls.push({
        tool: 'action.mate_execute',
        args: {
          sourcePart: { partId: source.id },
          targetPart: { partId: target.id },
          sourceFace: resolvedSourceFace,
          targetFace: resolvedTargetFace,
          sourceMethod: resolvedSourceMethod,
          targetMethod: resolvedTargetMethod,
          mode: resolvedMode,
          mateMode: resolvedMode === 'both' ? 'face_insert_arc' : 'face_flush',
          pathPreference: resolvedMode === 'both' ? 'arc' : 'auto',
          commit: true,
          pushHistory: true,
          stepLabel: `Mate ${source.name} to ${target.name}`,
        },
        confidence: 0.9,
      });

      return {
        toolCalls: calls,
        replyText: `已解析：${source.name}(${resolvedSourceFace}) -> ${target.name}(${resolvedTargetFace})，method=${resolvedSourceMethod}/${resolvedTargetMethod}，mode=${resolvedMode}${
          suggestionContext?.intent ? `，intent=${suggestionContext.intent}` : ''
        }。`,
      };
    }

    if (containsAny(lower, MODE_KEYWORDS) || containsAny(lower, ['rotate', 'move', 'mate', 'select', '模式'])) {
      const mode = detectMode(lower);
      if (mode) {
        calls.push({
          tool: 'mode.set_interaction_mode',
          args: { mode, reason: 'chat_router' },
          confidence: 0.88,
        });
        return { toolCalls: calls, replyText: `已切換到 ${mode} 模式。` };
      }
    }

    if (containsAny(lower, SELECT_KEYWORDS)) {
      const part = findPart(lower, ctx.parts);
      if (part) {
        calls.push({
          tool: 'selection.set',
          args: {
            selection: {
              kind: 'part',
              part: { partId: part.id },
            },
            replace: true,
            autoResolve: true,
          },
          confidence: 0.84,
        });
        return { toolCalls: calls, replyText: `已選取 ${part.name}。` };
      }

      const labels = ctx.parts.slice(0, 5).map((partItem) => partItem.name);
      return {
        toolCalls: [],
        replyText:
          labels.length > 0
            ? `我沒找到你要選的零件。可用零件包含：${labels.join('、')}${ctx.parts.length > 5 ? '…' : ''}`
            : '目前場景還沒有可選零件。',
      };
    }

    if (looksLikeGeneralQuestion(lower)) {
      const llmAnswer = await answerGeneralQuestionWithLlm(text, ctx);
      if (llmAnswer) {
        return {
          toolCalls: [],
          replyText: llmAnswer,
        };
      }
    }

    return {
      toolCalls: [],
      replyText:
        '我可以回答操作問題，也能直接控制場景。你可以說「如何新增step」、「這個模型是什麼」或「mate part1 and part2」。',
    };
  },
};
