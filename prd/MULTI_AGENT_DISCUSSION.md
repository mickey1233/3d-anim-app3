# 三代理討論記錄（檔案式）— Multi‑Agent Discussion（通用版）

> 目的：把「討論/分歧/裁決」集中在一個地方，避免每輪 review 只增加問題但沒有收斂。

---

## CURRENT_STATUS

- CURRENT_PHASE：Plan / PRD / Implementation / Testing
- CURRENT_ROUND：R1 / R2 / R3 / R4 / R5
- CURRENT_OWNER：Agent A（Codex）
- LAST_UPDATED：YYYY-MM-DDTHH:mm:ssZ

---

## 議題列表（每輪最多 5–8 個，避免爆炸）

> 寫法：一個議題只討論一件事；每個議題都要有「決策」或「下一步」。

### ISSUE-001：<標題>
- 背景：
- 分歧點：
- 方案 A：
- 方案 B：
- 裁決（誰決定/為什麼）：
- 影響範圍（檔案/模組）：
- 驗收方式：

---

## 收斂規則（強制）

- 若同一議題在下一輪仍被提出，必須標註 `REOPEN` 並說明「為何之前裁決不足」
- 若 reviewer 沒有新增阻塞問題，請輸出 `APPROVE`
- 最高 5 輪後由 Agent A 做最終裁決，並把未解分歧寫入 Plan/PRD 的「未解分歧與裁決」

