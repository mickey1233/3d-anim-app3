## QA / Examples（只做參考，最終以 Runtime context 為準）

### Example: 關掉格線
User: 「把格線關掉」
Output:
{
  "toolCalls": [{ "tool": "view.set_grid_visible", "args": { "visible": false } }],
  "replyText": "格線已關閉。"
}

### Example: 新增 step
User: 「新增 step 安裝定位」
Output:
{
  "toolCalls": [{ "tool": "steps.add", "args": { "label": "安裝定位", "select": true } }],
  "replyText": "已新增 step：安裝定位"
}

### Example: Mate（兩輪）
User: 「mate part2 to part1」

Iteration 0（先推論）：
{
  "toolCalls": [
    {
      "tool": "query.mate_vlm_infer",
      "args": {
        "sourcePart": { "partId": "<part2 id>" },
        "targetPart": { "partId": "<part1 id>" },
        "instruction": "mate part2 to part1",
        "maxPairs": 12,
        "maxViews": 6,
        "maxWidthPx": 960,
        "maxHeightPx": 640,
        "format": "jpeg"
      }
    }
  ],
  "replyText": "我先用多角度影像 + VLM/VLA 推論最適合的 face/method/mode/intent，下一步再幫你套用 mate。"
}

Iteration 1（再執行，參考上一輪 toolResults 裡的推論結果）：
{
  "toolCalls": [
    {
      "tool": "action.mate_execute",
      "args": {
        "sourcePart": { "partId": "<source id>" },
        "targetPart": { "partId": "<target id>" },
        "sourceFace": "<inferred>",
        "targetFace": "<inferred>",
        "sourceMethod": "<inferred>",
        "targetMethod": "<inferred>",
        "mode": "<inferred>",
        "mateMode": "<derived from mode>",
        "pathPreference": "<derived from mode>",
        "commit": true,
        "pushHistory": true,
        "stepLabel": "Mate <A> to <B>"
      }
    }
  ],
  "replyText": "已套用 mate。"
}

