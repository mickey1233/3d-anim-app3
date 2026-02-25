/**
 * VLM-guided mate parameter inference.
 *
 * Takes multi-angle screenshots of the scene and sends them to a
 * multimodal VLM (Gemini) with a structured prompt to infer:
 *   mode / intent / method / sourceFace / targetFace / sourcePart / targetPart
 *
 * Environment variables:
 *   MATE_VLM_ENABLE=1          — enable (default: disabled)
 *   GEMINI_API_KEY             — required for real VLM calls
 *   GEMINI_MODEL               — model name (default: gemini-1.5-flash)
 *   MATE_VLM_TIMEOUT_MS        — API timeout in ms (default: 5000)
 *   MATE_VLM_MOCK_RESPONSE     — JSON string, skips API call (for testing)
 */

type FaceId = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
type MateMode = 'translate' | 'twist' | 'both';
type AnchorMethodId =
  | 'auto'
  | 'planar_cluster'
  | 'geometry_aabb'
  | 'object_aabb'
  | 'extreme_vertices'
  | 'obb_pca'
  | 'picked';

export type VlmMateInference = {
  mode: MateMode;
  intent: string;
  method?: AnchorMethodId;
  sourceFace?: FaceId;
  targetFace?: FaceId;
  sourcePart: string;
  targetPart: string;
  confidence: number;
  reasoning?: string;
};

export type SceneStateForMate = {
  parts: { id: string; name: string; position: [number, number, number] }[];
  sourcePart: { id: string; name: string };
  targetPart: { id: string; name: string };
  userText: string;
};

const VALID_FACES: FaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
const VALID_MODES: MateMode[] = ['translate', 'twist', 'both'];
const VALID_METHODS: AnchorMethodId[] = [
  'auto', 'planar_cluster', 'geometry_aabb', 'object_aabb',
  'extreme_vertices', 'obb_pca', 'picked',
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.ROUTER_LLM_MODEL || 'gemini-1.5-flash';
const TIMEOUT_MS = Number(process.env.MATE_VLM_TIMEOUT_MS || 5000);

function sanitizeMateInference(raw: unknown, sceneState: SceneStateForMate): VlmMateInference | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const mode = VALID_MODES.includes(obj.mode as MateMode)
    ? (obj.mode as MateMode)
    : 'translate';

  const confidence =
    typeof obj.confidence === 'number'
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0;

  const sourcePart =
    typeof obj.sourcePart === 'string' ? obj.sourcePart : sceneState.sourcePart.name;

  const targetPart =
    typeof obj.targetPart === 'string' ? obj.targetPart : sceneState.targetPart.name;

  const intent =
    typeof obj.intent === 'string' ? obj.intent.slice(0, 120) : '';

  // Use spread to avoid setting optional keys to undefined (exactOptionalPropertyTypes).
  return {
    mode,
    intent,
    sourcePart,
    targetPart,
    confidence,
    ...(VALID_METHODS.includes(obj.method as AnchorMethodId)
      ? { method: obj.method as AnchorMethodId }
      : {}),
    ...(VALID_FACES.includes(obj.sourceFace as FaceId)
      ? { sourceFace: obj.sourceFace as FaceId }
      : {}),
    ...(VALID_FACES.includes(obj.targetFace as FaceId)
      ? { targetFace: obj.targetFace as FaceId }
      : {}),
    ...(typeof obj.reasoning === 'string'
      ? { reasoning: obj.reasoning.slice(0, 600) }
      : {}),
  };
}

function buildSystemPrompt(): string {
  return [
    '你是一個 3D CAD 場景分析專家。你將收到從多個角度拍攝的零件場景截圖，',
    '以及場景零件資訊和使用者的組裝指令。',
    '',
    '你的任務是判斷如何將 source part 組裝到 target part。',
    '需要輸出：接觸面（face）、組裝方式（mode）、錨定方法（method）。',
    '',
    '規則：',
    '1. 優先依照影像中的視覺幾何推理，而非固定預設值。',
    '2. 面的定義：top=+Y, bottom=-Y, front=+Z, back=-Z, right=+X, left=-X。',
    '3. mode 只有三種：translate（純平移）、twist（平移+旋轉）、both（弧線插入）。',
    '4. 泛用的「組裝」「align」「attach」「mate」請一律用 mode=translate。',
    '5. 只有明確指令含「cover/insert/arc/蓋上/插入/套入」才考慮 mode=both。',
    '6. confidence 請誠實評估，不確定時填低分（<0.75），不要強行猜測。',
    '',
    '請先用繁體中文逐步推理（reasoning 欄位），然後輸出 JSON（只輸出 JSON，不要其他文字）。',
  ].join('\n');
}

function buildUserPrompt(
  images: { angle: string; dataUrl: string }[],
  sceneState: SceneStateForMate
): string {
  const partLines = sceneState.parts
    .map((p) => `- ${p.name} (id: ${p.id}): position [${p.position.map((v) => v.toFixed(3)).join(', ')}]`)
    .join('\n');

  return [
    `使用者指令：${sceneState.userText || '（未指定）'}`,
    '',
    `Source part（要移動的零件）：${sceneState.sourcePart.name} (id: ${sceneState.sourcePart.id})`,
    `Target part（固定基準零件）：${sceneState.targetPart.name} (id: ${sceneState.targetPart.id})`,
    '',
    '場景中所有零件（名稱、world position）：',
    partLines,
    '',
    `截圖共 ${images.length} 張，角度：${images.map((i) => i.angle).join(', ')}（已作為圖片附件傳入）。`,
    '',
    '請推理後輸出以下 JSON（只輸出 JSON）：',
    '{',
    '  "reasoning": "逐步推理過程...",',
    '  "mode": "translate|twist|both",',
    '  "intent": "描述組裝意圖的短語（英文）",',
    '  "method": "auto|planar_cluster|geometry_aabb|object_aabb|extreme_vertices|obb_pca|picked",',
    '  "sourceFace": "top|bottom|left|right|front|back",',
    '  "targetFace": "top|bottom|left|right|front|back",',
    '  "sourcePart": "零件名稱",',
    '  "targetPart": "零件名稱",',
    '  "confidence": 0.0至1.0',
    '}',
  ].join('\n');
}

export async function inferMateFromImages(
  images: { angle: string; dataUrl: string }[],
  sceneState: SceneStateForMate
): Promise<VlmMateInference | null> {
  // Mock response for testing (bypasses API entirely).
  const mockEnv = process.env.MATE_VLM_MOCK_RESPONSE;
  if (mockEnv) {
    try {
      return sanitizeMateInference(JSON.parse(mockEnv), sceneState);
    } catch {
      return null;
    }
  }

  if (process.env.MATE_VLM_ENABLE !== '1') return null;
  if (!GEMINI_API_KEY) return null;
  if (images.length === 0) return null;

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const client = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: buildSystemPrompt(),
  });

  // Convert data URLs to inline image parts for Gemini multimodal.
  const imageParts = images.map((img) => ({
    inlineData: {
      mimeType: 'image/png' as const,
      data: img.dataUrl.replace(/^data:image\/\w+;base64,/, ''),
    },
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildUserPrompt(images, sceneState) },
            ...imageParts,
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
      // @ts-ignore — AbortSignal accepted at runtime by Gemini SDK
      signal: controller.signal,
    });

    const text = result.response.text().trim();
    if (!text) return null;

    // Parse JSON from the response.
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      // Try extracting JSON block if model wrapped it in markdown.
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { raw = JSON.parse(text.slice(start, end + 1)); } catch { /* */ }
      }
    }

    return sanitizeMateInference(raw, sceneState);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
