# Few-Shot Examples

Each example shows user input + optional geometryHint + expected JSON output.

---

## Example 1: Generic assembly → translate (NOT both)

**User**: 幫我把part2和part1組裝起來
**Context**: parts=[{id:"part1",...},{id:"part2",...}]

**Output**:
```json
{
  "replyText": "已組裝 part2 到 part1，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part2" },
      "targetPart": { "partId": "part1" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "auto", "targetMethod": "auto",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
      "stepLabel": "Mate part2 to part1"
    }
  }]
}
```

---

## Example 2: Cover/insert → both (explicit "cover" keyword)

**User**: cover part1 on part2

**Output**:
```json
{
  "replyText": "已用蓋上模式將 part1 蓋到 part2，mode=both。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "planar_cluster", "targetMethod": "planar_cluster",
      "mode": "both", "mateMode": "face_insert_arc",
      "pathPreference": "arc", "commit": true, "pushHistory": true,
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

## Example 5: Explicit faces + method

**User**: mate part1 bottom and part2 top use object aabb method

**Output**:
```json
{
  "replyText": "已解析：part1(bottom) -> part2(top)，method=object_aabb/object_aabb，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "object_aabb", "targetMethod": "object_aabb",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
      "stepLabel": "Mate part1 to part2"
    }
  }]
}
```

---

## Example 6: Generic mate → translate

**User**: mate part1 and part2

**Output**:
```json
{
  "replyText": "已解析：part1(bottom) -> part2(top)，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "auto", "targetMethod": "auto",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
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
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "planar_cluster", "targetMethod": "planar_cluster",
      "mode": "both", "mateMode": "face_insert_arc",
      "pathPreference": "arc", "commit": true, "pushHistory": true,
      "stepLabel": "Mate part2 to part1"
    }
  }]
}
```

---

## Example 11: Align (generic) → translate

**User**: 請幫我把 part1 跟 part2 對齊

**Output**:
```json
{
  "replyText": "已解析：part1(bottom) -> part2(top)，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "part1" },
      "targetPart": { "partId": "part2" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "auto", "targetMethod": "auto",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
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

---

## Example 15: Insert intent (pin into socket) → extreme_vertices

**User**: insert pin into socket
**Context**: parts=[{id:"pin",name:"pin"},{id:"socket",name:"socket"}],
  geometryHint={sourceBboxSize:[0.01,0.05,0.01], targetBboxSize:[0.05,0.02,0.05]}

**Reasoning**: "pin" is long/thin, "socket" is wide/short → insert intent.
Pin's tip goes first → `extreme_vertices` for source. Socket opening → `planar_cluster` for target.

**Output**:
```json
{
  "replyText": "已解析：插入模式，pin(front) -> socket(top)，method=extreme_vertices/planar_cluster，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "pin" },
      "targetPart": { "partId": "socket" },
      "sourceFace": "front", "targetFace": "top",
      "sourceMethod": "extreme_vertices", "targetMethod": "planar_cluster",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
      "stepLabel": "Insert pin into socket"
    }
  }]
}
```

---

## Example 16: Geometry hint drives face selection

**User**: mate lid onto bottle
**Context**: parts=[{id:"lid",name:"lid"},{id:"bottle",name:"bottle"}],
  geometryHint={
    expectedFacePair:{sourceFace:"bottom",targetFace:"top"},
    topRankingPairs:[{sourceFace:"bottom",targetFace:"top",score:0.91,facingScore:0.95}]
  }

**Reasoning**: Part name "lid" → bottom face. "bottle" → top face.
Geometry confirms: topRankingPairs[0] has facingScore=0.95 and matches bottom/top. Use that.

**Output**:
```json
{
  "replyText": "已解析：lid(bottom) -> bottle(top)，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "lid" },
      "targetPart": { "partId": "bottle" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "planar_cluster", "targetMethod": "planar_cluster",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
      "stepLabel": "Mate lid to bottle"
    }
  }]
}
```

---

## Example 17: Cover + arc (蓋上 keyword → both)

**User**: 把蓋子蓋上瓶身
**Context**: parts=[{id:"cap",name:"cap"},{id:"bottle",name:"bottle"}]

**Reasoning**: "蓋上" = explicit cover keyword → mode=both.
Cap bottom face onto bottle top face. Lid/cap → `planar_cluster`.

**Output**:
```json
{
  "replyText": "已用蓋上模式將 cap 蓋到 bottle，mode=both。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partId": "cap" },
      "targetPart": { "partId": "bottle" },
      "sourceFace": "bottom", "targetFace": "top",
      "sourceMethod": "planar_cluster", "targetMethod": "planar_cluster",
      "mode": "both", "mateMode": "face_insert_arc",
      "pathPreference": "arc", "commit": true, "pushHistory": true,
      "stepLabel": "蓋上 cap to bottle"
    }
  }]
}
```

---

## Example 18: Side attach (geometry → left/right faces)

**User**: attach bracket to wall
**Context**: geometryHint={
    expectedFacePair:{sourceFace:"right",targetFace:"left"},
    relativePosition:{dx:-0.2,dy:0,dz:0},
    topRankingPairs:[{sourceFace:"right",targetFace:"left",score:0.88,facingScore:0.92}]
  }

**Reasoning**: Target (wall) is to the left of source (bracket). Geometry confirms right/left.
Generic attach → translate.

**Output**:
```json
{
  "replyText": "已解析：bracket(right) -> wall(left)，mode=translate。",
  "toolCalls": [{
    "tool": "action.mate_execute",
    "args": {
      "sourcePart": { "partName": "bracket" },
      "targetPart": { "partName": "wall" },
      "sourceFace": "right", "targetFace": "left",
      "sourceMethod": "planar_cluster", "targetMethod": "planar_cluster",
      "mode": "translate", "mateMode": "face_flush",
      "pathPreference": "auto", "commit": true, "pushHistory": true,
      "stepLabel": "Attach bracket to wall"
    }
  }]
}
```
