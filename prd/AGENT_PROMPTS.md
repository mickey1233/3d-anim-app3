# 三代理協作（檔案式）— Agent Prompts（通用版）

> 目的：當你不方便用 API 直接觸發其他 agent（或需要人工備援流程）時，仍能用「同一個 repo 內的檔案」讓多位 agent 協作。
>
> 使用方式：在 Cursor/IDE 開三個 agent 視窗（Codex / Claude Code / OpenCode），讓他們**讀同一份 PRD/Plan**，並把各自的 review 寫回指定檔案。  
> 你的工作只剩下「確認最後的 Plan」與「確認最後的 PRD」。

---

## 角色定義

- Agent A：主導者 / Integrator（Codex）
  - 產出初版 Plan/PRD
  - 整合 Agent B/C 的 review，推進到收斂版本
- Agent B：Reviewer（Claude Code）
  - 只審閱：缺漏、風險、邊界案例、可測性
- Agent C：Reviewer（OpenCode）
  - 只審閱：可實作性、一致性、相容性、測試完整性

---

## 檔案寫入規則（重要）

1) 所有人都只能改自己負責的 review 檔（避免互相覆寫）
2) Review 必須是「可執行修改點」，不要泛泛而談
3) 若認為已可接受：只寫 `APPROVE`

Review 輸出格式（強制）：

- [Severity: High/Med/Low] <問題>
  - 建議修改：<具體修改>
  - 影響範圍：<檔案/段落/模組>
  - 原因：<一句話>

---

## Review 檔案位置（建議）

請把各 agent 的輸出寫入：

- `prd/reviews/agent-a-integrator.md`（Agent A 整合紀錄，可選）
- `prd/reviews/agent-b-reviewer.md`（Agent B）
- `prd/reviews/agent-c-reviewer.md`（Agent C）

> 你也可以改名，但請維持一人一檔。

---

## 最小流程（人工備援）

1) Agent A：產出 Plan v1 → 寫入 `plan/<id>-plan.md`（或直接更新 `plan/PLAN.md`）
2) Agent B/C：審閱 Plan → 寫入各自 review 檔
3) Agent A：整合成 Plan v2 → 回到 (2) 直到收斂或最多 5 輪
4) Agent A：產出 PRD v1 → 更新 `prd/PRD.md`
5) Agent B/C：審閱 PRD → 寫入各自 review 檔
6) Agent A：整合成 PRD v2 → 回到 (5) 直到收斂或最多 5 輪

