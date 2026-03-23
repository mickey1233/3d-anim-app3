## 技能：Mate / 組裝

### 先做推論（推薦）
工具：`query.mate_vlm_infer`

args（常用）：
{
  "sourcePart": { "partId": "<id>" },
  "targetPart": { "partId": "<id>" },
  "instruction": "<使用者原句>",
  "maxPairs": 12,
  "maxViews": 6,
  "maxWidthPx": 960,
  "maxHeightPx": 640,
  "format": "jpeg"
}

### 再做執行
工具：`action.mate_execute`

args（常用）：
{
  "sourcePart": { "partId": "<id>" },
  "targetPart": { "partId": "<id>" },
  "sourceGroupId": "<group UUID if source part is in a group — from context.groups>",
  "targetGroupId": "<group UUID if target part is in a group — from context.groups>",
  "sourceFace": "top|bottom|left|right|front|back",
  "targetFace": "top|bottom|left|right|front|back",
  "sourceMethod": "planar_cluster|face_projection|geometry_aabb|object_aabb|obb_pca|picked",
  "targetMethod": "planar_cluster|face_projection|geometry_aabb|object_aabb|obb_pca|picked",
  "mode": "translate|twist|both",
  "mateMode": "face_flush|face_insert_arc",
  "pathPreference": "auto|arc",
  "commit": true,
  "pushHistory": true,
  "stepLabel": "Mate <A> to <B>"
}

**重要**：若使用者說「mate Group X and partY」，sourcePart 設 Group X 第一個成員的 partId，並加上 `sourceGroupId: <group.id>`。這樣整個群組會作為剛體一起移動。

### Method 選擇提示
- `planar_cluster`（預設）：幾何有明顯平面時最準確。
- `face_projection`：**複雜 CAD 零件首選**。當 `planar_cluster` 各個 face 都落在同一位置、或零件無大平面時改用此方法。它選「中心點在該軸方向最極端」的面群，不依賴法線方向。
- `geometry_aabb`：快速但被凸出物干擾時失準。
- `object_aabb`：最粗糙，有插槽時避免使用。
- `obb_pca`：斜放/旋轉零件較穩定。

### 提高 VLM/VLA 推論準確度（你在「分析」時可以做的事）
1) 確保 source/target 兩個零件同時完整出現在畫面中，避免遮擋。
2) 用多角度：至少包含 Top + 兩個「沿著 source->target / target->source」方向的視角。
3) 解析度不必太高，但要清楚：建議寬 640~960px、jpeg。
4) 若零件距離很遠，先用 translate 把它們拉近到同一個視野內再做推論。
