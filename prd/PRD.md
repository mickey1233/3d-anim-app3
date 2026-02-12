# 產品需求文件（PRD）— 3D CAD 組裝與動畫工作台 v2

| 欄位 | 值 |
|---|---|
| 文件 ID | PRD-3DCAD-v2.0 |
| 版本 | 1.0（草稿 — 待三 Agent 審閱） |
| 日期 | 2026-02-03 |
| 狀態 | 草稿 |
| 負責人 | 開發團隊 |

> 本文件中的需求狀態（DONE / PARTIAL / NOT DONE）皆以 2026-02-03 的原始碼檢視為依據。  
> 狀態對照：DONE=已完成、PARTIAL=部分完成、NOT DONE=未完成。  
> 需要多 Agent 討論的待決事項收斂於 **第 10 節**。  
> 討論流程與 prompts 請見 `MULTI_AGENT_DISCUSSION.md` 與 `AGENT_PROMPTS.md`。

---

## 1. 執行摘要

### 1.1 產品願景

3D CAD Studio 是一個以瀏覽器為核心、結合 AI 的組裝與動畫工作台。它讓工程師、教育訓練人員與設計師能夠載入多零件 CAD 模型、定義精準的面對面（face-to-face）貼合（mating）約束、將這些操作記錄為有順序的 SOP（Standard Operating Procedure）步驟，並以平滑的動畫序列回放 —— 不必安裝桌面軟體。

AI 層會從兩個方向加速工作流：**向上**（把自然語言指令轉為結構化的貼合操作）與 **向內**（上傳組裝照片，交由 Vision Language Model 分析並自動產生步驟序列）。

v2 重構版本是目前活躍的程式碼庫，也是本文件的目標版本。舊版 v1 仍可透過 `?legacy=1` 存取，但不再接受新開發。

### 1.2 問題描述

1. **複雜度門檻。** 專業參數式 CAD 套件（SolidWorks、CATIA、FreeCAD）在使用者能產出組裝 SOP 前需要大量訓練；貼合約束系統強大但不透明。
2. **缺乏 AI 捷徑。** 主流工具很少把自然語言或影像輸入當成一級的組裝規格入口。
3. **SOP 與 3D 工作分離。** 工程師通常在完成 3D 後才把 SOP 產出為靜態 PDF；缺少一個工具能讓「3D 組裝序列本身就是 SOP」。
4. **安裝與部署摩擦。** 僅桌面端部署代表：不易即時協作、難以瀏覽器審閱、也不利於手機/平板存取。

### 1.3 解法提案

一個單頁 React 應用，搭配輕量的 Node.js WebSocket gateway，提供：

- 透過 Three.js / React Three Fiber 在瀏覽器直接載入 GLB、GLTF（可含 Draco）、USD/USDZ CAD 檔。
- 多算法的面基貼合（face-based mating）系統，支援 translate / twist / both 三種模式，以及每軸偏移微調。
- 每次貼合結果可記錄為 SOP 步驟（全場景快照），支援拖曳排序、刪除、更新，並可平滑序列播放（含 easing）。
- 透過 command bar 與持久化 AI Chat 面板接受文字指令：本地指令零延遲執行；複雜意圖則轉送後端 LLM/mock provider。
- 支援多張圖片上傳，VLM pipeline 產出結構化步驟、物件偵測與 scene-part mapping 候選。
- 以 Zustand 的 snapshot-based 狀態管理維持完整 undo/redo 歷史。

---

## 2. 使用者角色（Personas）

### 2.1 Persona A — 製程工程師（主要）

| 屬性 | 內容 |
|---|---|
| 姓名 | Marcus R. |
| 角色 | 中型 OEM 的資深機械／製程工程師 |
| 技術背景 | 熟悉 SolidWorks；Web App 經驗有限 |
| 目標 | 在單次工作時段內完成一個 10 步驟子組裝的動畫 SOP，並分享給產線 |
| 痛點 | 現行 SOP 流程：從 CAD 匯出截圖 → 貼到 Word → 手動標註；每個組裝可能要花數天 |
| 使用方式 | 載入匯出的 GLB。用 Mate 面板逐步對齊零件。把每次對齊記錄成 SOP step。按 Run 驗證序列。 |

### 2.2 Persona B — 技術訓練人員（次要）

| 屬性 | 內容 |
|---|---|
| 姓名 | Lisa K. |
| 角色 | 製造訓練專員 |
| 技術背景 | 中等；每天使用簡報軟體，沒有 3D CAD 背景 |
| 目標 | 製作給新進作業員的互動式組裝教學 |
| 痛點 | 靜態圖難以表達空間關係；作業員容易裝錯 |
| 使用方式 | 從工程端取得 GLB + 組裝參考照片。把照片上傳到 VLM 面板。審閱並調整自動產生的步驟。用播放功能演練。 |

### 2.3 Persona C — 設計驗證工程師（次要）

| 屬性 | 內容 |
|---|---|
| 姓名 | David L. |
| 角色 | 進行 DFA（Design for Assembly）審查的產品設計工程師 |
| 技術背景 | CAD 熟練度高；重視速度勝於精緻 |
| 目標 | 快速驗證某個組裝序列在物理上是否可行 |
| 痛點 | 在 CAD 套件內跑完整模擬很慢；希望在數分鐘內完成草圖級別的組裝可行性檢查 |
| 使用方式 | 載入組裝模型。用 command bar 快速貼合（`mate PartA bottom to PartB top`）。觀看播放。若有碰撞就調整。 |

### 2.4 Persona D — AI/ML 研究工程師（第三順位）

| 屬性 | 內容 |
|---|---|
| 姓名 | Yuki M. |
| 角色 | 評估 VLM 在組裝任務上的準確度研究者 |
| 目標 | Benchmark 不同 VLM 後端將組裝照片轉為結構化指令的能力 |
| 使用方式 | 透過環境變數切換 VLM provider。上傳控制組的影像集合。把輸出與 ground truth 比較。 |

---

## 3. 功能需求（Functional Requirements）

需求依功能領域分組。每一列包含 ID、使用者故事、優先級（P0 / P1 / P2），以及根據原始碼檢視得出的目前實作狀態。

### 3.1 模型載入與視覺化（FR-ML）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-ML-01 | 作為使用者，我可以載入 GLB 或 GLTF 檔（可選 Draco 壓縮）並在視窗中看到渲染結果 | P0 | DONE | `ModelLoader.tsx` — `useLoader` + GLTFLoader + DracoLoader |
| FR-ML-02 | 作為使用者，我可以載入 USDZ 檔 | P0 | DONE | USDZLoader（three-stdlib） |
| FR-ML-03 | 載入模型時，相機會自動 fit 到模型 bounding box | P0 | DONE | `ModelLoader` 的 AABB-based auto-fit |
| FR-ML-04 | 我可以在不重新載入頁面的情況下切換背景環境（studio、city、warehouse…） | P0 | DONE | `ViewPanel` 下拉；預先生成的 AI 背景圖片 |
| FR-ML-05 | 預設顯示地面網格（grid），並可切換關閉 | P0 | DONE | store 內 `view.showGrid`；指令 `grid on/off` |
| FR-ML-06 | 模型最大到 800 MB 也不會默默失敗；會顯示載入指示 | P0 | DONE | Suspense + ErrorBoundary 模式 |
| FR-ML-07 | 作為使用者，我可以把模型檔拖曳到視窗中以載入 | P1 | NOT DONE | v2 尚未有 drop-zone handler |
| FR-ML-08 | 作為使用者，我可以載入多個模型檔並同時看到所有零件 | P1 | NOT DONE | 目前流程假設單一 CAD 檔 |

### 3.2 零件選取與變換（FR-PT）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-PT-01 | 在視窗點擊 mesh 即可選取，並以 outline 高亮 | P0 | DONE | `SelectionOutline`（Box3Helper） |
| FR-PT-02 | 被選取的零件會在左側 Parts list 中高亮 | P0 | DONE | `PartsList.tsx` 以 `selection.partId` 判斷 |
| FR-PT-03 | 我可以用三軸 TransformGizmo 拖曳選取零件；拖曳期間 Orbit 會被停用 | P0 | DONE | `TransformGizmo.tsx` + `OrbitCoordinator.tsx` |
| FR-PT-04 | 我可以用數字查看/編輯選取零件的 position/rotation，並支援拖曳 scrub | P0 | DONE | `SelectionPanel.tsx` + `ScrubbableNumber` |
| FR-PT-05 | 我可以用文字輸入在任意軸上 nudge 選取零件 | P0 | DONE | 指令 `nudge x 0.01` |
| FR-PT-06 | 我可以把單一零件或全部零件重設回初始 transform | P0 | DONE | 指令 `reset part <name>` / `reset all` |
| FR-PT-07 | 系統會追蹤 selection 來源（dropdown/canvas/command/system），且 dropdown 的選取不會被 canvas 點擊覆寫 | P0 | DONE | `selection.source` enum + priority logic |

### 3.3 面基貼合（FR-MATE）

這是產品的技術核心：貼合系統接受兩個零件與兩個 face 識別，透過可插拔的方法鏈（method chain）解析 anchor 點，並產生可將 source face 對齊 target face 的剛體變換（rigid transform）。

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-MATE-01 | 我可以透過下拉選單或視窗點選指定 source 與 target 零件 | P0 | DONE | `MatePanel.tsx` dropdowns + `pickFaceMode` state |
| FR-MATE-02 | 我可以從 6 個方向指定 source/target face：top、bottom、left、right、front、back | P0 | DONE | FaceId 型別；solver 映射到方向向量 |
| FR-MATE-03 | 我可以針對每一側選擇 anchor 解析方法：Auto、Planar Cluster、Geometry AABB、Object AABB、Extreme Vertices、OBB（PCA）、Picked | P0 | DONE | `anchorMethods.ts`；7 種方法 + 自動 fallback chain |
| FR-MATE-04 | 我可以直接在 mesh 上點選 face，以取得最高精度的 anchor 放置 | P0 | DONE | `pickFaceMode` 觸發 raycaster |
| FR-MATE-05 | 我可以選擇貼合模式：Translate Only、Twist、或 Both | P0 | DONE | `MateMode`；`buildMateTransform` 依模式分支 |
| FR-MATE-06 | 在 Twist/Both 模式中，我可以指定自訂 twist axis、axis space 與角度（deg） | P0 | DONE | `TwistSpec`；`computeTwistFromSpec` |
| FR-MATE-07 | 在求解前，我可以對 source/target anchor 各自套用本地偏移（X/Y/Z） | P0 | DONE | `mateDraft` 內 `sourceOffset` / `targetOffset` |
| FR-MATE-08 | Apply 前可看到 preview markers：顯示 anchor 解析位置、使用的方法與是否發生 fallback | P0 | DONE | `matePreview` state；`MatePreviewMarkers.tsx` |
| FR-MATE-09 | Apply 後會顯示 trace panel：完整分解 pivot、rotations、translation、before/after poses | P0 | DONE | `mateTrace` state；MatePanel 內渲染 |
| FR-MATE-10 | 若主要 anchor 方法失敗，系統會依定義好的 chain 自動 fallback，不會 crash | P0 | DONE | `anchorMethods.ts` 的 `resolveAnchor` fallback loop |
| FR-MATE-11 | 貼合結果可 undo | P0 | DONE | `setPartOverride` 走 `dispatch` → history snapshot |
| FR-MATE-12 | command bar 支援 `mate <source> <face> to <target> <face>`，並可用 flags 指定 mode/methods/twist spec | P0 | DONE | `useCommandRunner.ts` 完整 flag parsing |
| FR-MATE-13 | 系統會計算貼合精度指標（normal alignment cosine、residual plane distance）並隨每次求解存入 | P1 | DONE | `MateTransform.quality`；UI 尚未呈現 |

### 3.4 SOP 步驟編排（FR-SOP）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-SOP-01 | 我可以新增一個步驟，捕捉目前所有零件 transforms 的 snapshot | P0 | DONE | `addStep` clone `overridesById` |
| FR-SOP-02 | 我可以為每個步驟命名；未提供時自動產生預設名稱 | P0 | DONE | `StepsPanel` label input + placeholder |
| FR-SOP-03 | 我可以把既有步驟的 snapshot 更新為目前場景狀態 | P0 | DONE | `updateStepSnapshot` |
| FR-SOP-04 | 我可以刪除步驟；若刪除的是目前步驟，selection 會移到前一個步驟 | P0 | DONE | `deleteStep` fallback logic |
| FR-SOP-05 | 我可以在 timeline bar 拖曳步驟以重新排序 | P0 | DONE | `TimelineBar` 使用 HTML5 drag-and-drop |
| FR-SOP-06 | 我可以按 Run 依序播放所有步驟，使用平滑插值（lerp/slerp）與 easing | P0 | DONE | `StepRunner.tsx`；quadratic ease-in-out；`durationMs` 預設 900ms |
| FR-SOP-07 | 播放會從初始（override 前）狀態開始，而非目前視窗狀態 | P0 | DONE | 播放開始時 `clearAllPartOverridesSilent()` |
| FR-SOP-08 | 我可以隨時停止播放 | P0 | DONE | `stopPlayback` |
| FR-SOP-09 | timeline bar 永遠顯示所有步驟，且目前步驟會有視覺高亮 | P0 | DONE | current step button 的 border/bg accent |
| FR-SOP-10 | SOP steps 與其 snapshots 會隨 undo/redo 一起回溯 | P0 | DONE | `steps` 是 `Snapshot` 的一部分 |
| FR-SOP-11 | 我可以透過 UI 控制播放速度（每步 duration） | P1 | PARTIAL | state 有 `durationMs`，但尚無 UI 控制 |

### 3.5 AI Chat 與命令列（FR-AI）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-AI-01 | App 頂部的 command bar 接受文字輸入；按 Enter 即執行 | P0 | DONE | `CommandBar.tsx` 的 `onKeyDown` Enter handler |
| FR-AI-02 | 本地指令（select/mate/nudge/reset/env/grid/help）在前端直接執行，無需網路往返 | P0 | DONE | `useCommandRunner.ts` |
| FR-AI-03 | 無法本地解析的指令會轉送到 WS 後端 router | P0 | DONE | fallback 到 `v2Client.request('router_execute', ...)` |
| FR-AI-04 | AI Chat 面板的訊息在同一 session 內切 tab 不會消失 | P0 | DONE | `chat.messages` 存在 Zustand store |
| FR-AI-05 | 當 WebSocket 斷線時，Chat 面板會顯示警告與 Retry 按鈕 | P0 | DONE | `wsConnected` 檢查 + retry UI |
| FR-AI-06 | 後端 router 支援 mock provider（可預期、無 API key），供 CI 與離線使用 | P0 | DONE | `MockRouterProvider`；`ROUTER_PROVIDER=mock` 時為預設 |
| FR-AI-07 | 後端 router 支援正式的 Gemini provider | P1 | NOT DONE | v2 router 尚無 Gemini provider class |
| FR-AI-08 | 指令內的零件名稱解析支援模糊子字串匹配 | P0 | DONE | `findPartId`：exact → includes |
| FR-AI-09 | 指令內接受 face alias（例如 `up`= `top`、`+y`= `top`、`-x`= `left`） | P0 | DONE | `useCommandRunner` 的 `parseFace` |

### 3.6 VLM（Vision Language Model）流程（FR-VLM）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-VLM-01 | 我可以在 VLM 面板一次上傳多張圖片（任意順序） | P0 | DONE | 檔案 input `multiple`；`addVlmImages` |
| FR-VLM-02 | 分析前我可以調整圖片順序（上下箭頭）並刪除單張圖片 | P0 | DONE | `moveVlmImage` / `removeVlmImage` |
| FR-VLM-03 | 點擊 Analyze 會把所有圖片（base64）+ 目前 parts list 送到後端 | P0 | DONE | `VlmPanel.handleAnalyze` |
| FR-VLM-04 | 後端回傳結構化結果：推論步驟、偵測物件（含信心分數）、mapping candidates，以及（可選）組裝指令 | P0 | DONE | `VlmResultSchema`（Zod） |
| FR-VLM-05 | 提供 mock VLM provider 以利離線測試 | P0 | DONE | `mcp-server/v2/vlm/mockProvider.ts` |
| FR-VLM-06 | 提供正式 Gemini VLM provider 供 production 使用 | P1 | NOT DONE | `analyze.ts` 目前只呼叫 `mockAnalyze` |
| FR-VLM-07 | 提供 Ollama VLM provider（llava / qwen3-vl）作為替代 | P1 | PARTIAL | v1 有 `callOllama`；尚未移植到 v2 |
| FR-VLM-08 | 分析後使用者可先審閱偵測結果與 mapping candidates，再決定是否執行 | P0 | DONE | 面板呈現結果；不會自動執行 |
| FR-VLM-09 | VLM 的 `assembly_command` 可以一鍵送入 command bar 執行 | P1 | NOT DONE | schema 有 `assembly_command.mcp_text_command`，但尚無 UI 綁定按鈕 |

### 3.7 Undo / Redo（FR-UD）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-UD-01 | 所有使用者可感知的 mutation 都走 `dispatch`，並推入 history snapshot | P0 | DONE | 可見狀態 actions 皆用 `get().dispatch(...)` |
| FR-UD-02 | Top bar 的 Undo/Redo 按鈕會依 history 深度啟用/停用 | P0 | DONE | `canUndo` / `canRedo` 由 history lengths 派生 |
| FR-UD-03 | Selection 變更不會污染 undo stack | P0 | DONE | `setSelection` 直接用 `set()` |
| FR-UD-04 | 鍵盤快捷鍵 Ctrl+Z / Ctrl+Shift+Z 觸發 undo/redo | P1 | NOT DONE | v2 尚無全域 `keydown` listener |

### 3.8 匯出與持久化（FR-EXP）

| ID | 使用者故事 | 優先級 | 狀態 | 備註 |
|---|---|---|---|---|
| FR-EXP-01 | 使用者可以把目前 scene state 匯出為 YAML 或 JSON | P1 | NOT DONE | v2 尚無匯出 UI 或 serializer |
| FR-EXP-02 | 使用者可以在 GLB 與 USD 格式間轉換 | P1 | PARTIAL | 有 `mcp-server/convert_to_usd.py`，但 UI 未曝光 |
| FR-EXP-03 | 使用者可儲存並重載完整 SOP session（steps + snapshots + view state） | P1 | NOT DONE | v2 尚無 session save/load |

---

## 4. 非功能性需求（Non-Functional Requirements）

### 4.1 效能（NFR-PERF）

| ID | 需求 | 目標 |
|---|---|---|
| NFR-PERF-01 | 典型 50MB GLB 的初次視窗渲染（模型可見） | 現代筆電 < 3s |
| NFR-PERF-02 | 單次貼合求解時間（兩零件） | < 200ms |
| NFR-PERF-03 | SOP 播放不論零件數都需維持 60fps | 每幀 < 16ms |
| NFR-PERF-04 | 500+ meshes 的 parts list 渲染不得卡頓 | list render < 100ms |
| NFR-PERF-05 | WebSocket 往返（command → router → response） | mock < 500ms；live LLM < 2s |

### 4.2 可靠性（NFR-REL）

| ID | 需求 |
|---|---|
| NFR-REL-01 | 不合法或過大的模型檔不得讓頁面崩潰；錯誤邊界需捕捉失敗並提供 retry UI |
| NFR-REL-02 | WebSocket 斷線不得影響本地操作；App 需能優雅降級並提示重連 |
| NFR-REL-03 | Anchor method 解析不得 throw；若所有方法皆失敗，solver 回傳 null 並由 UI 顯示失敗原因 |

### 4.3 無障礙（NFR-ACC）

| ID | 需求 | 狀態 |
|---|---|---|
| NFR-ACC-01 | 所有互動控制皆有可存取 label 或 aria-label | PARTIAL — 多數 dropdown 與僅 icon 的按鈕缺少 label |
| NFR-ACC-02 | 鍵盤導覽涵蓋所有 panel 控制 | NOT DONE |
| NFR-ACC-03 | 狀態不可只靠顏色傳達 | PARTIAL — StatusPill 用「顏色 + 文字」；selection 用「outline + list highlight」 |

### 4.4 安全（NFR-SEC）

| ID | 需求 | 狀態 |
|---|---|---|
| NFR-SEC-01 | API keys（Gemini、Ollama）只存在 server 端，永不送到瀏覽器 | DONE — `.env` 只在 server |
| NFR-SEC-02 | 上傳圖片（VLM）只在 server 端處理且不永久儲存 | DONE（mock）；live provider 接上後需再驗證 |
| NFR-SEC-03 | WebSocket 不得暴露原始檔案系統路徑或 protocol 之外的內部狀態 | DONE — `WsGatewayV2` 只處理 `router_execute` 與 `vlm_analyze` |

### 4.5 可維護性（NFR-MAINT）

| ID | 需求 | 狀態 |
|---|---|---|
| NFR-MAINT-01 | 所有 WebSocket 訊息在前後端皆以 Zod schema 驗證 | DONE |
| NFR-MAINT-02 | 測試套件以 Playwright E2E 覆蓋主要 user flows | DONE — 16+ tests |
| NFR-MAINT-03 | 專案在 strict mode 下 TypeScript 編譯零錯誤 | DONE |

### 4.6 國際化（NFR-I18N）

| ID | 需求 | 狀態 |
|---|---|---|
| NFR-I18N-01 | UI 語言需一致；目前 chat intro 與 mock router reply 有中文，需外部化或統一 | PARTIAL |

---

## 5. 技術限制與相依（Technical Constraints & Dependencies）

### 5.1 硬限制

| 限制 | 影響 |
|---|---|
| 僅瀏覽器端 3D 渲染（WebGL 2.0） | 無 server-side rendering；客戶端需可用 GPU |
| Three.js r160 API 範圍 | Loader API 與 Matrix4 操作固定在此版本家族 |
| Zustand 4（無內建 persistence） | 刷新頁面會遺失 session state，除非明確加入 save/load |
| 後端通訊僅 WebSocket | 無 REST fallback；WS 失效時 AI 功能不可用 |
| Playwright E2E（CI 只跑 Chromium） | Firefox/Safari 行為未被覆蓋 |

### 5.2 外部相依

| 相依 | 版本 | 用途 | 風險 |
|---|---|---|---|
| @google/generative-ai | ^0.24.1 | Gemini LLM/VLM client | API key 成本；rate limits |
| three / @react-three/fiber / drei | 0.160 / 8.15 / 9.96 | 3D 渲染 | 大版本升級可能破壞 loader APIs |
| zod | ^4.3.6 | runtime schema validation | v4 相對 v3 的 breaking changes |
| framer-motion | ^10.16 | UI 動畫 | bundle size（~40KB gzip） |
| Ollama（local） | runtime | 本地 VLM 推論 | 需另外安裝；模型下載 4–30GB |

### 5.3 內部架構限制

1. **單一真實來源是 Zustand store。** Three.js scene graph 不擁有 transforms；`PartTransformSync` 每幀把 store 內 overrides 推到 scene objects。任何移動零件的功能必須寫入 store。
2. **History snapshots 不包含 Three.js scene graph。** Snapshot 只捕捉 `overridesById`、`steps`、`markers`、`ui`、`vlm.result`；不在其中的狀態無法被 undo/redo。
3. **v2 WS protocol 有版本號（`version: 'v2'`）。** 新命令必須同時加到 server 的 `wsGateway.ts` 與 client 的 `wsClient.ts`。
4. **Anchor 解析是純函式（pure function）。** 必須維持無狀態、無副作用，以便 preview 計算時不改動 scene。

---

## 6. 現況 vs. 目標（Current vs. Desired）

| 領域 | 現況 | 目標（v2.0 Release） | Gap ID |
|---|---|---|---|
| 模型載入 | 可載入 GLB/GLTF/USDZ；auto-fit；單檔 | 支援 drag-and-drop；多檔合併；顯示檔案大小/進度 | GAP-01 |
| 貼合 | 7 種方法 + 3 種模式 + offsets + twist spec | 在 UI 呈現品質指標；加入碰撞檢查 pre-check | GAP-02 |
| SOP 編排 | add/delete/reorder/update/playback + easing | UI slider 可調播放速度；步驟可加註解欄位 | GAP-03 |
| AI Chat | 本地指令 + mock router；仍有少量中文文字 | 接上 Gemini router；UI 語言統一；移植 v1 的 Levenshtein fuzzy matching | GAP-04 |
| VLM | 多圖上傳 + mock analyze | 接上 Gemini/Ollama analyze；提供一鍵 Execute `assembly_command` | GAP-05 |
| 匯出/保存 | v2 無；有 Python converter 但僅 CLI | session save/load（JSON）；state export；GLB/USD conversion 以 UI 曝光 | GAP-06 |
| 快捷鍵 | 無 | Ctrl+Z / Ctrl+Shift+Z undo/redo；Escape 取消選取 | GAP-07 |
| 無障礙 | aria labels 稀少 | 全面 aria 覆蓋；panel 可鍵盤操作 | GAP-08 |
| Parts list 效能 | flat render；>~200 parts 變慢 | 超過門檻時啟用 virtualized list | GAP-09 |

---

## 7. 驗收標準（Acceptance Criteria）

### AC-MATE：貼合系統

- **AC-MATE-01：** Given 兩個盒狀零件，When 選擇 source=bottom、target=top 且 mode=translate、method=auto，Then source 的 bottom face 會與 target 的 top face 貼齊（residual distance < 0.001 world units）。
- **AC-MATE-02：** Given 同樣兩個零件，When 使用 mode=both 且 twistSpec angle=90（以 target normal axis），Then mateTrace 會呈現 normal rotation 與 twist rotation 的分量，且最終 pose 正確。
- **AC-MATE-03：** Given 指令 `mate BoxA bottom to BoxB top --mode both --twist-axis normal --twist-space target_face --twist-deg 45`，When 執行後，Then 結果需與 UI 等價設定一致。
- **AC-MATE-04：** Given 一個球體（無平面 face），When 選擇 `planar_cluster`，Then 會 fallback 到 `geometry_aabb`，且 preview 顯示 `fallbackUsed: true`。

### AC-SOP：步驟編排

- **AC-SOP-01：** Given 三個不同 snapshot 的 steps，When 點擊 Run，Then 會依序播放三段動畫（每段長度 `durationMs`），且最終零件位置等於最後一步 snapshot。
- **AC-SOP-02：** Given 將 Step 2 拖到 Step 1 前面，When 點擊 Run，Then 播放順序需反映新排序。
- **AC-SOP-03：** Given 已新增一個 step，When 觸發 Undo，Then 該 step 會從列表中移除。

### AC-AI：聊天與指令

- **AC-AI-01：** Given 存在一個名為 "BoxA" 的零件，When 輸入 `select BoxA`，Then BoxA 被選取，Parts list 高亮，Selection panel 顯示其 transform。
- **AC-AI-02：** Given 已選取一個零件，When 輸入 `nudge y 0.5`，Then 物件在 Y 軸 +0.5；When 觸發 Undo，Then 回到先前位置。
- **AC-AI-03：** Given WebSocket 已連線，When 輸入一個無法本地解析的指令，Then 會在 2 秒內收到 router 回覆。

### AC-VLM：視覺分析

- **AC-VLM-01：** Given 上傳兩張圖片，When 點擊 Analyze，Then（mock provider）回傳結果至少包含一個 step、一個 object、一個 mapping candidate。
- **AC-VLM-02：** Given 分析前調整了圖片順序，When 點擊 Analyze，Then 結果中的 `from_image` / `to_image` 配對需反映新順序。

### AC-PERF：效能

- **AC-PERF-01：** Given 一台具獨顯且 16GB RAM 的機器，When 開啟 `test_model.glb`，Then 第一幀可見幾何需在牆鐘時間 < 2 秒內出現。
- **AC-PERF-02：** Given 播放一個 10-step SOP，Then 必須維持 60fps（單幀不超過 20ms）。

---

## 8. 不在範圍內（Out of Scope）

| 項目 | 理由 |
|---|---|
| 多使用者即時協作 | 需要 OT 或 CRDT；架構改動大 |
| 雲端儲存／帳號／驗證 | 缺少後端持久化層；增加基礎設施相依 |
| 參數式約束求解（零件移動時維持面貼齊） | 這是 kinematic solver，不是 constraint solver |
| 播放時的碰撞偵測 | JS 計算成本高；需要空間加速結構 |
| 手機／平板視窗優化 | 3 欄 layout 以桌機橫向為設計目標 |
| 桌面打包（Electron/Tauri） | 交付模型是瀏覽器部署 |
| 舊版 v1 的功能補齊或 bug 修復 | v1 冻結；所有開發以 v2 為主 |
| AR/VR 頭顯支援 | 需要 WebXR；目前未納入相依 |
| SOP 播放自動輸出影片 | 需要 MediaRecorder + canvas capture；延後 |
| BOM（Bill of Materials）生成 | GLB scene graph 缺少語義化零件 metadata |
| 物理模擬 | 不在組裝序列器範圍 |
| CAD 參數化建模（sketch/features/constraints） | 這是 viewer/animator，不是建模工具 |

---

## 9. 風險與緩解（Risks & Mitigations）

| ID | 風險 | 影響 | 機率 | 緩解 |
|---|---|---|---|---|
| R01 | 大模型（500+ parts）讓 UI 反應變慢 | 高 | 中 | 實作 list virtualization（GAP-09）；profile `PartTransformSync` |
| R02 | live VLM 的準確度不足以直接產出 production 可用的組裝命令 | 中 | 高 | mock provider 保持預設；加入信心門檻；要求人工確認 |
| R03 | Gemini API rate limits 或 outages 使 AI chat 不可用 | 中 | 中 | 本地指令 fallback 仍可用；明確顯示 error state |
| R04 | Zod v4 breaking changes 導致 schema validation 失敗 | 低 | 低 | pin 住 zod 版本；為 schema 加入 smoke tests |
| R05 | UI 變複雜後 Playwright 測試變 flaky | 中 | 中 | 持續使用 store injection 模式，避免過度依賴 DOM timing |
| R06 | 長時間 VLM 分析時 WebSocket 斷線 | 中 | 低 | 加入 client timeout；重連後可重新 request |

---

## 10. 待決問題（供多 Agent 討論）

此草稿刻意保留以下未決事項，作為 `MULTI_AGENT_DISCUSSION.md` 定義之多 Agent 審閱流程的輸入：

1. **播放速度控制：** 要做成全域 slider（等比例影響所有 step duration），還是每步可設定？其 UX 該如何呈現？
2. **Live AI provider 選擇：** provider（Gemini/Ollama/Mock）應該在 UI 可切換，還是只允許透過環境變數設定？
3. **VLM 信心門檻：** mapping candidate 被標示為「高信心」的最低信心值是多少？哪個門檻可以允許自動執行？
4. **Session persistence：** session 應自動存到 localStorage，還是由使用者主動存？localStorage 可接受的最大 session size 為何？
5. **Parts list virtualization 門檻：** 多少 part 數開始切換為 virtualized rendering？100？200？500？
6. **快捷鍵範圍：** 除了 Ctrl+Z/Shift+Z，還需要哪些快捷鍵（例如 Delete 刪 step、Escape 取消選取、數字鍵快速選 face）？
7. **匯出格式：** session export 應用自訂 JSON envelope，或有沒有值得對齊的業界 interchange format？
8. **國際化：** 目前 codebase 有兩處中文（chat intro、router reply）。要全部改英文，或建立正式 i18n 系統？

---

## 11. 附錄（Appendix）

### A. 詞彙表

| 名詞 | 定義 |
|---|---|
| AABB | Axis-Aligned Bounding Box：與世界座標軸對齊，能包住物件的最小盒 |
| Anchor | 用於貼合的參考點：包含 position、normal、tangent 等向量 |
| Draco | Google 的 mesh 壓縮技術；透過 DracoLoader 支援 |
| Easing | 將線性時間 [0,1] 映射成更平滑視覺曲線的函式 |
| GLB | GLTF 的二進位容器格式 |
| MCP | Model Context Protocol：原始後端通訊協議（v1） |
| Mate | 以「一個零件的某個面」對齊「另一個零件的某個面」的操作 |
| OBB | Oriented Bounding Box：此處以 PCA 計算的旋轉包圍盒 |
| PCA | Principal Component Analysis：用於求 OBB 的主軸 |
| Slerp | Spherical Linear Interpolation：在 quaternion 間做正確插值的方法 |
| SOP | Standard Operating Procedure：一組有序的組裝步驟 |
| TwistSpec | 使用者指定的旋轉：axis token、axis space 與角度（deg） |
| VLM | Vision Language Model：以圖片 + 文字輸入，輸出文字/結構化結果的模型 |

### B. 主要檔案路徑

| 用途 | 路徑 |
|---|---|
| v2 Zustand store（state + history） | `src/v2/store/store.ts` |
| v2 AppShell layout | `src/v2/app/AppShell.tsx` |
| 貼合 solver | `src/v2/three/mating/solver.ts` |
| Anchor methods registry | `src/v2/three/mating/anchorMethods.ts` |
| Face clustering | `src/v2/three/mating/faceClustering.ts` |
| SOP 播放引擎 | `src/v2/three/animation/StepRunner.tsx` |
| Command parser | `src/v2/ui/CommandBar/useCommandRunner.ts` |
| WS gateway（server） | `mcp-server/v2/wsGateway.ts` |
| Tool registry（server） | `mcp-server/v2/tools/registry.ts` |
| Shared protocol schemas | `shared/schema/` |
| v2 3D Canvas root | `src/v2/three/CanvasRoot.tsx` |
| MCP Bridge（v1） | `src/services/MCPBridge.ts` |
| Global store（v1） | `src/store/useAppStore.ts` |

### C. 修訂歷史

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-02-03 | 初版中文草稿（偏設計導向，無狀態追蹤） |
| 1.0 | 2026-02-03 | 全面改寫：以原始碼為依據標注 DONE/PARTIAL/NOT DONE；新增 personas、NFR、gap analysis、Given/When/Then AC、風險等 |
