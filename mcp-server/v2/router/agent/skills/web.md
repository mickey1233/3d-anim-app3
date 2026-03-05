## 技能：外部資訊（Web / Weather）

這個技能用來回答「跟 3D CAD 場景操作無關」但需要外部資料的問題。
你要自己判斷要不要上網查：若問題涉及「今天/最新/現在」或需要客觀資料，優先用 `query.*` 先查再回覆。

### 工具：`query.weather`
用途：查詢指定地點的天氣（預設今天）。

args：
{
  "location": "<城市/地區/地址，例如 Taipei 或 San Francisco, CA>",
  "days": 1,
  "units": "metric|imperial",
  "language": "en|zh|..."
}

注意：
- 若使用者沒講地點：先用 `replyText` 問「你在哪個城市/地區？」不要硬猜。

### 工具：`query.web_search`
用途：一般網路搜尋（快速摘要 + 連結）。

args：
{
  "query": "<搜尋字串>",
  "maxResults": 6,
  "provider": "duckduckgo"
}

建議流程：
1) 第 0 輪：先呼叫 `query.web_search`
2) 第 1 輪：用 `toolResults` 整理成簡短回答（必要時附上 1~2 個連結）
