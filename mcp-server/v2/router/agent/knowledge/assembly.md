# 組裝關係（Assembly Taxonomy）與決策指南

本文件會被 Router Agent 當作 prompt input。目標是讓模型能理解「零件之間的關係」與 `mate` 相關 MCP tool 參數的語意，而不是靠程式碼寫死規則。

## 參數語意（核心）

### `intent`
- `cover`：蓋子/上蓋/外殼/罩子要「蓋上」目標零件（例如瓶蓋→瓶身、上蓋→底座、外殼→機身）。
- `insert`：零件要「插入/嵌入/塞入」目標的孔/插槽/卡槽（例如插頭→插座、插銷→孔、鍵(key)→鍵槽）。
- `default`：一般貼合/對齊/吸附/靠攏（不明確是 cover 或 insert）。

### `mode`
- `translate`：只移動，不旋轉（例如已經方向正確，只差位置對齊）。
- `twist`：只旋轉（或以旋轉為主），位置改變很小（例如「轉到對齊角度」）。
- `both`：需要「旋轉 + 移動」才能組裝成功（常見於 cover / insert，或零件方向不一致）。

### `face`
`top/bottom/left/right/front/back` 表示零件可用的接觸面（通常是零件本體的外側面）。face 語意遵循零件的**本地坐標軸（local axes）**，隨零件旋轉而旋轉：
- `top` = 零件本地 +Y　`bottom` = 本地 −Y
- `right` = 本地 +X　`left` = 本地 −X
- `front` = 本地 +Z　`back` = 本地 −Z

在 mate 時要決定：
- `sourceFace`：要被移動/旋轉的零件上，哪個面去對齊
- `targetFace`：目標零件上，哪個面做為對齊面
- 整體場景旋轉後 face 語意應保持一致（不要用 world Y 當「上方」的固定判斷）。

### `method`
Anchor 解析方法（用來算接觸面的 anchor / normal）：
- `planar_cluster`：從幾何中找平面群，選「法線最接近請求方向」的群。通常比 bbox 更貼近真正的接觸面。適合有明顯平面的零件。
- `face_projection`：從幾何中找平面群，選「**中心點在請求軸方向上最突出**」的群（例如 top → center.Y 最大的群）。**不依賴法線方向**，適合複雜 CAD 零件（無大平面對齊坐標軸、面法線雜亂、各 face 都解析到同一位置的情況）。結果位置類似 `geometry_aabb` 但落在真實幾何面上。**優先用於複雜形狀零件**（spark\_.glb 類型）。
- ~~`extreme_vertices`~~：**暫時停用**（目前執行時會 fallback 到 `planar_cluster`，保留名稱只為舊資料相容）。
- `geometry_aabb`：幾何 bbox，快速但可能被凸出物干擾。
- `object_aabb`：物件 bbox（更粗糙；插槽/凹槽場景可能導致「插不進去」）。
- `obb_pca`：PCA 估計 OBB，對斜放/旋轉零件可能較穩定。
- 不建議 `auto`：目前策略改為明確 method（預設 `planar_cluster`）。

**method 決策邏輯**：
```
零件形狀簡單（有明顯大平面 / 方塊體）？
  → planar_cluster（能找到正確法線面）
零件形狀複雜（多曲面、凹凸多、無大平面）？
  → 先試 face_projection（找幾何位置最極端的面）
  → 若還是不對，嘗試 geometry_aabb
有插槽/凹槽？
  → 避免 object_aabb，優先 planar_cluster 或 face_projection
各個 face 都解析到同一點 / 位置錯誤？
  → 換成 face_projection
```

## 常見組裝情境（更多例子）

### 1) 蓋子蓋上（Cover: lid/cap/cover）
例：瓶蓋→瓶身、外殼→機身、盒蓋→盒身
- 常見 intent：`cover`
- 常見 mode：若法線已對齊可用 `translate`；若方向不一致或需要「對正」再蓋上，才用 `both`
- 常見 face：`bottom -> top`（蓋子底面貼到本體頂面），但也可能是側向蓋合（left/right 或 front/back）
- 方法選擇：若 bbox 因凸起造成貼合不到真正接觸面，優先嘗試 `planar_cluster` 或 `face_projection`；若零件形狀複雜（多曲面無大平面），用 `face_projection`

### 2) 旋入/瓶蓋鎖上（Screw cover）
例：瓶蓋→瓶身（螺紋）
- intent：多半仍是 `cover`
- mode：`twist` 或 `both`（邊轉邊進）
- 選擇重點：對齊旋轉軸 + 接觸面法線一致，且需要沿軸向有進給

### 3) 插入插槽（Insert: plug/pin/key into slot/socket）
例：插頭→插座、插銷→孔、鍵→鍵槽、卡榫→卡槽
- intent：`insert`
- mode：常見 `translate` 或 `both`（若有鍵向/定位特徵需要旋轉）
- face：常見 `bottom -> top`（上往下插）或 `top -> bottom`（下往上插），也可能是側向插入
- 方法：插槽/凹槽場景避免只用 `object_aabb`，可優先 `planar_cluster` 或 `face_projection`（複雜形狀零件用後者）

### 4) 滑軌/滑槽（Slide / rail）
例：抽屜滑軌、導軌
- intent：偏 `insert` 或 `default`
- mode：多為 `translate`
- 重點：選「沿軌道方向」的 face pair，並讓非插入方向有足夠 clearance

### 5) 卡扣（Snap-fit / clip）
例：塑膠卡扣扣上底座
- intent：`insert` 或 `cover`（視結構）
- mode：常 `both`（先對正角度再卡入）
- 重點：bbox 很容易被外側凸起誤導，優先 `planar_cluster`

### 6) 鉸鏈/插銷（Hinge / pin）
例：門軸插入、鉸鏈對位
- intent：常 `insert`
- mode：常 `both`
- 重點：旋轉軸要對齊（法線/軸向），且插入方向通常沿軸

### 7) 側板貼合（Side attach）
例：側蓋貼合到機身側邊、面板貼到框架
- intent：常 `default` 或 `cover`
- mode：多為 `translate`（若面板已方向正確）
- face：常 `left<->right` 或 `front<->back`

### 8) 卡口/四分之一轉（Bayonet / quarter-turn lock）
例：燈泡卡口、相機鏡頭卡口、旋轉扣上外殼
- intent：多為 `cover`（蓋上後再旋轉鎖定）
- mode：常 `both`（邊旋轉邊沿軸向進給），或 `twist`（若已經貼合只是要轉到卡榫位置）
- face：通常是與「鎖定軸」同向的面（不一定是 bottom/top）

### 9) 燕尾/滑入（Dovetail / slide-in）
例：滑軌、燕尾槽、抽屜滑入
- intent：`insert` 或 `default`
- mode：多為 `translate`（主動作沿單一方向滑入）
- face：常是 `left/right` 或 `front/back`（看滑入方向而定）

### 10) 壓入/緊配（Press-fit）
例：軸壓入孔、塞入緊配套筒
- intent：多為 `insert`
- mode：多為 `translate`（若有鍵向/定位才可能 `both`）
- 方法：避免只用 `object_aabb`（凸出物會讓 bbox 過大），優先 `planar_cluster` 或 `face_projection`（複雜形狀用後者）

### 11) 定位銷/導柱（Dowel / alignment pin）
例：定位柱插入孔、導柱導向裝配
- intent：多為 `insert`
- mode：若已對正可 `translate`，否則 `both`
- face：依插入軸決定（可能是 front/back 或 left/right，不一定是 bottom/top）

## VLM/VLA/LLM 推論準確度提升（實務）
1) **同框**：source/target 兩個零件要同時完整出現在畫面中，避免被其他零件遮擋。
2) **多角度**：至少包含 `top` + `source_to_target` + `target_to_source`；側視角容易誤判。
3) **近距離**：若零件距離太遠，先把它們平移到同一視野再推論。
4) **顯示方向線索**：開啟 anchors/座標軸/格線能降低上下左右前後判斷錯誤。
5) **先做分析再執行**：先用 `query.mate_vlm_infer` 推論，再用 `action.mate_execute` 執行。
