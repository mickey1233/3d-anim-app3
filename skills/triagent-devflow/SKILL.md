---
name: triagent-devflow
description: 在本機以三代理（Codex/Claude/OpenCode）自動完成 Plan→PRD→Implementation→Testing 的開發流程（含最小 context selection 與最多 5 輪收斂），並透過 `devflow` CLI 或 HTTP API 只在 Plan/PRD 兩處等待使用者核准。
---

# triagent-devflow

## 何時使用

- 你想把「使用者只輸入需求」後的工作自動化成固定 pipeline：Plan → PRD → 實作 → 測試
- 你需要每一階段都有三代理審閱收斂（最多 5 輪），且每次呼叫都要附 Context Manifest（最小檔案集）

## 快速開始（CLI）

- 產生 run 並跑到 Plan 核准點：`npx devflow "你的需求文字"`
- 讀計畫與核准：程式會在 `plan/<run_id>-plan.md` 產生 Plan 並停下來詢問
- 讀 PRD 與核准：核准 Plan 後會產生 `prd/<run_id>-prd.md` 並再次停下來詢問
- 核准 PRD 後自動進入實作與測試

> 若沒有 API key，devflow 會自動降級為 mock provider（可跑流程，但不會做有意義的內容生成）。

## 快速開始（HTTP API）

- 啟動：`npx devflow server --port 4271`
- Web UI：啟動後打開 `http://127.0.0.1:4271/`
- 建立 request：`POST /request`（回傳 `run_id`）
- 查狀態：`GET /runs/:id`
- 核准 Plan：`POST /runs/:id/approve-plan`
- 核准 PRD：`POST /runs/:id/approve-prd`

## Context Selection（重要）

- pipeline 會依階段用關鍵字 + `rg` 在有限 roots 中挑檔，並用字數上限截斷內容
- 每次呼叫都會把 manifest 寫到 `.devflow/runs/<id>/manifests/*.json`

## 參考

- 具體設定與規格：`devflow-kit/docs/DEVFLOW.md`
