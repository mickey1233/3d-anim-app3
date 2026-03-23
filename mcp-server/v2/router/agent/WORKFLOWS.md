## 常見工作流程

### 1) Mate / 組裝（推薦：多輪）
目標：把兩個零件「貼合/插入/蓋上/側向貼合」，並讓結果符合使用者意圖。

**第 0 輪（分析）**
- 呼叫：`query.mate_vlm_infer`
  - 讓 VLM/VLA 從多角度畫面 + 幾何候選中推論：
    - source/target（必要時）
    - sourceFace / targetFace
    - sourceMethod / targetMethod
    - mode（translate / twist / both）
    - intent（default / cover / insert）
  - 建議參數：`maxViews: 6~8`, `format: "jpeg"`, `maxWidthPx: 960`, `maxHeightPx: 640`

**第 1 輪（執行）**
- 從上一輪 `query.mate_vlm_infer` 的 tool result 取出推論結果，呼叫：`action.mate_execute`
  - `commit: true`, `pushHistory: true`
  - 若 mode = both，可用 `mateMode: "face_insert_arc"`、`pathPreference: "arc"`；否則可用 `mateMode: "face_flush"`。

### 2) 格線 / 視圖
- `view.set_grid_visible { visible: true/false }`
- `view.set_environment { environment: "warehouse|studio|..." }`

### 3) 選取 / 模式
- `selection.set`（選取零件）
- `mode.set_interaction_mode`（切換 select/move/rotate/mate）

### 4) 重置 / 歷史
- `action.reset_part` / `action.reset_all`
- `history.undo` / `history.redo`

### 5) Steps
- `steps.add` / `steps.select` / `steps.update_snapshot` ...

