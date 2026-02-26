# Few-Shot Examples

Each example shows user input + expected JSON output.
These are the most critical examples for routing accuracy.

---

## Example 1: Generic assembly → translate (NOT both)

**User**: 幫我把part2和part1組裝起來
**Context**: parts=[{id:"part1",name:"part1"},{id:"part2",name:"part2"}]

**Output**:
```json
{
  "replyText": "已組裝 part2 到 part1。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part2" },
      "targetPart": { "partId": "part1" },
      "sourceFace": "bottom",
      "targetFace": "top",
      "sourceMethod": "auto",
      "targetMethod": "auto",
      "mode": "translate",
      "mateMode": "face_flush",
      "pathPreference": "auto",
      "commit": true,
      "pushHistory": true,
      "stepLabel": "Mate part2 to part1"
    }
  }]
}
```

---

## Example 2: Cover/insert → both

**User**: cover part1 on part2
**Context**: parts=[{id:"part1",name:"part1"},{id:"part2",name:"part2"}]

**Output**:
```json
{
  "replyText": "已用蓋上模式將 part1 蓋到 part2。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom",
      "targetFace": "top",
      "sourceMethod": "auto",
      "targetMethod": "auto",
      "mode": "both",
      "mateMode": "face_insert_arc",
      "pathPreference": "arc",
      "commit": true,
      "pushHistory": true,
      "stepLabel": "Mate part1 to part2"
    }
  }]
}
```

---

## Example 3: Grid off

**User**: 把格線關掉

**Output**:
```json
{
  "replyText": "格線已關閉。",
  "toolCalls": [{ "tool": "view.set_grid_visible", "args": { "visible": false } }]
}
```

---

## Example 4: Grid on

**User**: grid on

**Output**:
```json
{
  "replyText": "格線已開啟。",
  "toolCalls": [{ "tool": "view.set_grid_visible", "args": { "visible": true } }]
}
```

---

## Example 5: Mate with explicit faces

**User**: mate part1 bottom and part2 top use object aabb method
**Context**: parts=[{id:"part1",name:"part1"},{id:"part2",name:"part2"}]

**Output**:
```json
{
  "replyText": "已解析：part1(bottom) -> part2(top)，method=object_aabb/object_aabb，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom",
      "targetFace": "top",
      "sourceMethod": "object_aabb",
      "targetMethod": "object_aabb",
      "mode": "translate",
      "mateMode": "face_flush",
      "pathPreference": "auto",
      "commit": true,
      "pushHistory": true,
      "stepLabel": "Mate part1 to part2"
    }
  }]
}
```

---

## Example 6: Generic mate → translate

**User**: mate part1 and part2
**Context**: parts=[{id:"part1",name:"part1"},{id:"part2",name:"part2"}]

**Output**:
```json
{
  "replyText": "已解析：part1(bottom) -> part2(top)，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom",
      "targetFace": "top",
      "sourceMethod": "auto",
      "targetMethod": "auto",
      "mode": "translate",
      "mateMode": "face_flush",
      "pathPreference": "auto",
      "commit": true,
      "pushHistory": true,
      "stepLabel": "Mate part1 to part2"
    }
  }]
}
```

---

## Example 7: Greeting

**User**: 你好

**Output**:
```json
{
  "replyText": "你好！我可以幫你組裝零件、建立步驟或切換模式。",
  "toolCalls": []
}
```

---

## Example 8: Add step

**User**: add step assemble lid

**Output**:
```json
{
  "replyText": "已新增 step：assemble lid。",
  "toolCalls": [{ "tool": "steps.add", "args": { "label": "assemble lid", "select": true } }]
}
```

---

## Example 9: Mode switch

**User**: 切到 rotate 模式

**Output**:
```json
{
  "replyText": "已切換到 rotate 模式。",
  "toolCalls": [{ "tool": "mode.set_interaction_mode", "args": { "mode": "rotate", "reason": "chat_router" } }]
}
```

---

## Example 10: Cover with explicit faces → both

**User**: mate part2 bottom to part1 top cover
**Context**: parts=[{id:"part1",name:"part1"},{id:"part2",name:"part2"}]

**Output**:
```json
{
  "replyText": "已用蓋上模式將 part2(bottom) 對齊到 part1(top)，mode=both。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part2" },
      "targetPart": { "partId": "part1" },
      "sourceFace": "bottom",
      "targetFace": "top",
      "sourceMethod": "auto",
      "targetMethod": "auto",
      "mode": "both",
      "mateMode": "face_insert_arc",
      "pathPreference": "arc",
      "commit": true,
      "pushHistory": true,
      "stepLabel": "Mate part2 to part1"
    }
  }]
}
```

---

## Example 11: Align (generic) → translate

**User**: 請幫我把 part1 跟 part2 對齊
**Context**: parts=[{id:"part1",name:"part1"},{id:"part2",name:"part2"}]

**Output**:
```json
{
  "replyText": "已解析：part1(bottom) -> part2(top)，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom",
      "targetFace": "top",
      "sourceMethod": "auto",
      "targetMethod": "auto",
      "mode": "translate",
      "mateMode": "face_flush",
      "pathPreference": "auto",
      "commit": true,
      "pushHistory": true,
      "stepLabel": "Mate part1 to part2"
    }
  }]
}
```

---

## Example 12: Undo

**User**: undo

**Output**:
```json
{
  "replyText": "已幫你執行復原。",
  "toolCalls": [{ "tool": "history.undo", "args": {} }]
}
```

---

## Example 13: Step question → no tool

**User**: 我要如何新增step

**Output**:
```json
{
  "replyText": "你可以直接說「新增 step 安裝定位」或「add step align cap to body」。",
  "toolCalls": []
}
```

---

## Example 14: Model info → no tool

**User**: 這個 usd 的 3d model
**Context**: cadFileName="boxes.glb", parts=[{name:"part1"},{name:"part2"}]

**Output**:
```json
{
  "replyText": "模型資訊：`boxes.glb`，包含 2 個零件：part1、part2。目前 steps：0。",
  "toolCalls": []
}
```
