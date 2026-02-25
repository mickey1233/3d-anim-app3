# S11 實作計劃 — Port Migration + VLM-Guided Mate Inference

> 撰寫日期：2026-02-25
> 狀態：PLANNING（尚未開始實作）
> 目標：(A) 將所有 hardcoded port 遷移到新值；(B) 在 mockProvider mate 偵測路徑中插入 multi-angle 視角截圖 + VLM 推論，以更精準填入 mate 參數。

---

## Part A：Port Migration

### A1. 變更清單（舊值 → 新值）

| 檔案 | 位置 | 舊值 | 新值 |
|------|------|------|------|
| `start.sh` | `fuser -k 5173/tcp` | `5173` | `5274` |
| `start.sh` | `fuser -k 3001/tcp` | `3001` | `3112` |
| `start.sh` | `--port 5173` CLI flag | `5173` | `5274` |
| `start.sh` | echo URL 文字 | `localhost:5173` | `localhost:5274` |
| `src/v2/network/client.ts:5` | default WS URL | `ws://localhost:3011` | `ws://localhost:3112` |
| `mcp-server/v2/index.ts:3` | fallback port | `3011` | `3112` |
| `package.json` | `devflow:server` script | `--port 4170` | `--port 4271` |
| `CLAUDE.md` | 所有 `5173` / `3011` / `4170` 提及 | 舊值 | 新值 |
| `docs/DEVLOG.md` | HOW_TO_RESUME 所有 port 提及 | 舊值 | 新值 |
| `tests/*.spec.ts` | 所有 `127.0.0.1:5173` URL | `5173` | `5274` |

### A2. 注意事項

- `mcp-server/v2/index.ts` 的 `process.env.V2_WS_PORT || 3011` 維持 env var 覆寫機制，僅改 fallback 數字。
- `start.sh` 原本寫 `3001`（v1 legacy），遷移後改為 `3112`（v2 MCP port）。
- Playwright config 若有 `baseURL` hardcode 也需更新。

### A3. 驗證指令

```bash
npm run dev -- --host 127.0.0.1 --port 5274
npx tsx mcp-server/v2/index.ts        # 應輸出: [MCP v2] WS gateway listening on 3112
npx playwright test tests/v2_smoke.spec.ts --reporter=line
```

---

## Part B：Multi-Angle Capture Utility

### B1. 新檔案：`src/v2/three/captureUtils.ts`

抽離 `mcpToolExecutor.ts` 內的私有 helper，讓兩處共用：

```typescript
export function computeCaptureSize(
  viewportPx: { width: number; height: number },
  maxW: number, maxH: number
): { width: number; height: number }

export function dataUrlFromPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  mimeType: 'image/png' | 'image/jpeg',
  jpegQuality?: number
): string
```

### B2. 新檔案：`src/v2/three/captureMultiAngle.ts`

```typescript
export type AnglePreset = {
  label: string;                          // 'front' | 'back' | 'left' | 'right' | 'top' | 'iso'
  cameraPos: [number, number, number];    // world space
  lookAtTarget?: [number, number, number]; // 省略時使用 scene bounding box center
};

export const DEFAULT_ANGLES: AnglePreset[] = [
  { label: 'front',  cameraPos: [0,  0,  5] },
  { label: 'back',   cameraPos: [0,  0, -5] },
  { label: 'left',   cameraPos: [-5, 0,  0] },
  { label: 'right',  cameraPos: [5,  0,  0] },
  { label: 'top',    cameraPos: [0,  5,  0] },
  { label: 'iso',    cameraPos: [3,  3,  3] },
];

export type AngleCaptureResult = {
  angle: string;
  dataUrl: string;   // base64 PNG data URL
  widthPx: number;
  heightPx: number;
};

export async function captureMultiAngles(options?: {
  maxWidthPx?: number;    // 預設 512
  maxHeightPx?: number;   // 預設 384
  angles?: AnglePreset[]; // 預設 DEFAULT_ANGLES
}): Promise<AngleCaptureResult[]>
```

**實作步驟：**

1. 從 `SceneRegistry` 取得 `renderer`, `scene`, `camera`（任一為 null → throw）
2. 計算 scene bounding box center（作為所有角度的 lookAt target）
3. 儲存 camera 原始 `position`, `quaternion`, `aspect`
4. 建立單一 `WebGLRenderTarget`（複用於所有角度，減少 VRAM 分配）
5. 對每個 `AnglePreset`：
   - `camera.position.set(...preset.cameraPos)`
   - `camera.lookAt(lookAtTarget)`
   - `camera.updateProjectionMatrix()`
   - `renderer.setRenderTarget(rt)` → `renderer.render(scene, camera)` → `readRenderTargetPixels`
   - `dataUrlFromPixels(...)` 取得 data URL（含 Y 軸翻轉）
6. **try/finally** 還原 camera state + `renderer.setRenderTarget(null)` + `rt.dispose()`

---

## Part C：新 MCP Tool `vlm.capture_for_mate`

### C1. 設計決策

採用「新 MCP Tool」方案（而非擴充 WS 訊息類型）：
- 沿用現有 tool proxy 機制（`tool_proxy_invoke`）
- `mockProvider` 透過 `requestToolExecutionViaProxy` 呼叫，就像 `query.mate_suggestions` 一樣
- 符合現有 `ToolEnvelope<T>` 格式

### C2. Schema（新增至 `shared/schema/mcpToolsV3.ts`）

```typescript
// Args
const VlmCaptureForMateArgsSchema = z.object({
  sourcePart: PartRefSchema,
  targetPart: PartRefSchema,
  userText: z.string().optional(),
  maxWidthPx: z.number().int().min(64).max(1024).default(512),
  maxHeightPx: z.number().int().min(64).max(768).default(384),
  angleLabels: z.array(z.string()).optional(),     // 省略 = 全部 6 個角度
  confidenceThreshold: z.number().min(0).max(1).default(0.75),
});

// VLM inference result
const VlmMateInferenceSchema = z.object({
  mode: z.enum(['translate', 'twist', 'both']),
  intent: z.string(),
  method: z.enum(['auto','planar_cluster','geometry_aabb','object_aabb',
                  'extreme_vertices','obb_pca','picked']).optional(),
  sourceFace: z.enum(['top','bottom','left','right','front','back']).optional(),
  targetFace: z.enum(['top','bottom','left','right','front','back']).optional(),
  sourcePart: z.string(),
  targetPart: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),   // CoT 推理過程
});

// Tool result data
const VlmCaptureForMateDataSchema = z.object({
  capturedAngles: z.array(z.string()),
  imageCount: z.number().int().nonnegative(),
  vlmInference: VlmMateInferenceSchema.nullable(),
  confidenceThreshold: z.number(),
  meetsThreshold: z.boolean(),
  fallbackReason: z.string().optional(),
});
```

### C3. Frontend Tool Handler（`src/v2/network/mcpToolExecutor.ts`）

在 `vlm.analyze` 區塊後新增 `if (tool === 'vlm.capture_for_mate')` handler：

1. `resolvePart(input.sourcePart)` + `resolvePart(input.targetPart)`
2. `captureMultiAngles({ maxWidthPx, maxHeightPx, angles: filteredByAngleLabels })`
3. `v2Client.request('vlm_mate_analyze', { images: [...], sceneState: {...} })`
4. 解析結果，判斷 `confidence >= confidenceThreshold`
5. 回傳 `ToolEnvelope<VlmCaptureForMateData>`

若 VLM 呼叫失敗 → `vlmInference: null, meetsThreshold: false, fallbackReason: '...'`

---

## Part D：VLM Prompt Engineering

### D1. 新檔案：`mcp-server/v2/vlm/mateInfer.ts`

```typescript
export async function inferMateFromImages(
  images: { angle: string; dataUrl: string }[],
  sceneState: {
    parts: { id: string; name: string; position: [number,number,number] }[];
    sourcePart: { id: string; name: string };
    targetPart: { id: string; name: string };
    userText: string;
  }
): Promise<VlmMateInference | null>
```

**環境變數 guard：**
- `MATE_VLM_ENABLE !== '1'` → return null
- `GEMINI_API_KEY` 不存在 → return null
- `MATE_VLM_MOCK_RESPONSE` 有值 → return `JSON.parse(env)` (測試用)
- VLM call timeout: `MATE_VLM_TIMEOUT_MS`（預設 3000ms）

### D2. System Prompt

```
你是一個 3D CAD 場景分析專家。你將收到多張從不同角度拍攝的零件場景截圖，
以及場景零件資訊和使用者的組裝指令。

你的任務是判斷如何將 source part 組裝到 target part，
包含：接觸面（face）、組裝方式（mode）、錨定方法（method）。

規則：
1. 優先依照影像中的視覺幾何推理，而非固定預設值
2. 面的定義：top=正Y, bottom=負Y, front=正Z, back=負Z, right=正X, left=負X
3. mode 只有三種：translate（純平移）、twist（平移+旋轉）、both（弧線插入）
4. 泛用的「組裝」「align」「attach」請一律用 mode=translate
5. 只有明確指令「cover/insert/arc/蓋上/插入」才考慮 mode=both
6. confidence < 0.75 時請誠實填低分，不要強行猜測

請先繁體中文逐步推理（reasoning），然後輸出 JSON。
```

### D3. Gemini Multimodal Call

```typescript
const imageParts = images.map(img => ({
  inlineData: {
    mimeType: 'image/png',
    data: img.dataUrl.replace(/^data:image\/\w+;base64,/, ''),
  },
}));

// generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
```

### D4. JSON Sanitizer

驗證 `mode` ∈ `['translate','twist','both']`，`sourceFace/targetFace` ∈ 6 個面，`confidence` ∈ [0,1]。未知值 fallback 到 `'translate'` / `undefined` / `0`。

### D5. wsGateway.ts 新增 command handler

```typescript
if (parsed.data.command === 'vlm_mate_analyze') {
  const inference = await inferMateFromImages(args.images, args.sceneState);
  this.sendResponse(ws, parsed.data.id, true, { inference });
  return;
}
```

---

## Part E：mockProvider 整合

### E1. 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `MATE_VLM_ENABLE` | `''`（停用） | 設 `'1'` 啟用 |
| `MATE_VLM_CONFIDENCE` | `'0.75'` | 最低信心分數 |
| `MATE_VLM_TIMEOUT_MS` | `'3000'` | VLM API 超時 ms |
| `MATE_VLM_MOCK_RESPONSE` | `''` | 測試用固定 JSON 回應 |

### E2. wsGateway.ts — Pre-fetch VLM Capture

在 `router_execute` handler 呼叫 `routeAndExecute` **之前**：

```
如果 MATE_VLM_ENABLE=1
  && text 包含 mate keyword
  && 有 ≥2 parts 被提及
→ 呼叫 requestToolExecutionViaProxy('vlm.capture_for_mate', {...})
→ 結果注入 RouterContext.vlmMateCapture
```

### E3. RouterContext 型別更新（`mcp-server/v2/router/types.ts`）

```typescript
vlmMateCapture?: {
  vlmInference: VlmMateInference | null;
  meetsThreshold: boolean;
} | null;
```

### E4. mockProvider.ts — 讀取 VLM 結果

在 mate 路徑的 `inferMateWithLlm` 呼叫**之前**插入：

```
如果 ctx.vlmMateCapture?.meetsThreshold
→ 從 vlmInference 讀取 mode / sourceFace / targetFace / method
→ 這些值優先於 NLP，但低於 explicit user input
→ 跳過 inferMateWithLlm（VLM 已覆蓋）
```

### E5. Fallback 邏輯流程

```
使用者 mate 指令
    ↓
[wsGateway] MATE_VLM_ENABLE=1?
    是 → 有 keyword + ≥2 parts → 執行 vlm.capture_for_mate（6 角度截圖 + VLM）
              成功 confidence ≥ threshold → vlmMateCapture = {inference, meetsThreshold: true}
              失敗/低信心 → vlmMateCapture = {inference: null, meetsThreshold: false}
    否 → vlmMateCapture = null
    ↓
[mockProvider] ctx.vlmMateCapture?.meetsThreshold?
    是 → 優先使用 VLM mode/face/method（explicit input 仍可覆蓋）
         跳過 inferMateWithLlm
    否 → 繼續 NLP + geometry inference + inferMateWithLlm
    ↓
action.mate_execute（以最終解析後的參數）
```

---

## Part F：Testing

### F1. 新測試：`tests/v2_mate_vlm_inference.spec.ts`

**Test 1:** `vlm.capture_for_mate` 回傳 6 張截圖（無 VLM key 時 meetsThreshold=false）

**Test 2:** `angleLabels` 過濾後只截取指定角度（前 3 個）

**Test 3:** 截圖後 camera position 還原（誤差 < 1e-4）
- 需要 SceneRegistry 在 DEV mode 暴露 `window.__V2_CAMERA__`

**Test 4:** 以 `MATE_VLM_MOCK_RESPONSE` 環境變數注入 mock VLM 回應，驗證 mate 指令使用 VLM 推論的 face 值

---

## 實作順序建議

```
Day 1: Part A（Port Migration）→ smoke test 通過
Day 2: Part B（captureUtils.ts + captureMultiAngle.ts）→ 截圖 unit test
Day 3: Part C（schema + tool handler）→ vlm.capture_for_mate 回傳圖片
Day 4: Part D（mateInfer.ts + wsGateway handler）→ Gemini multimodal
Day 5: Part E（mockProvider 整合 + wsGateway pre-fetch）→ E2E 流程
Day 6: Part F（完整 tests）→ 全 11 個現有 mate tests 仍通過
```

---

## 受影響的檔案一覽

### Part A（Port Migration）
- `start.sh`
- `src/v2/network/client.ts`
- `mcp-server/v2/index.ts`
- `package.json`
- `CLAUDE.md`
- `docs/DEVLOG.md`
- `tests/*.spec.ts`（所有 `5173` URL）

### Part B（Multi-Angle Capture）
- `src/v2/three/captureUtils.ts` (**新建**)
- `src/v2/three/captureMultiAngle.ts` (**新建**)
- `src/v2/network/mcpToolExecutor.ts`（import 改用 captureUtils，移除重複 helper）

### Part C（Tool Schema + Handler）
- `shared/schema/mcpToolsV3.ts`（新增 schema + registry entry）
- `src/v2/network/mcpToolExecutor.ts`（新增 vlm.capture_for_mate handler）

### Part D（VLM Inference）
- `mcp-server/v2/vlm/mateInfer.ts` (**新建**)
- `mcp-server/v2/wsGateway.ts`（新增 vlm_mate_analyze command handler）

### Part E（mockProvider 整合）
- `mcp-server/v2/router/types.ts`（RouterContext 新增 vlmMateCapture）
- `mcp-server/v2/router/mockProvider.ts`（mate 路徑讀取 VLM 結果）
- `mcp-server/v2/wsGateway.ts`（router_execute 前 pre-fetch VLM capture）

### Part F（Testing）
- `tests/v2_mate_vlm_inference.spec.ts` (**新建**)
- `src/v2/three/SceneRegistry.ts`（DEV mode 暴露 `window.__V2_CAMERA__`）

---

## 關鍵風險與對策

| 風險 | 說明 | 對策 |
|------|------|------|
| Camera 還原失敗 | 使用者視角被改動 | try/finally，test 驗證 |
| VLM 超時阻塞 | Gemini API 慢 | `MATE_VLM_TIMEOUT_MS`（預設 3000ms），timeout → fallback |
| 圖片體積過大 | 6 張 PNG base64 可達 6-12 MB | 限制 maxWidthPx ≤ 512，或改用 JPEG |
| mockProvider 型別 | `ctx.vlmMateCapture` 為 unknown | 防禦性 type check + Zod parse |
| Port 衝突 | 新 port 被其他服務佔用 | start.sh `fuser -k` 清除，DEVLOG 記錄 |
