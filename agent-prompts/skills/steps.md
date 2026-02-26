# Skill: Steps Management

## Triggers

Add step: `新增step`, `add step`, `create step`, `new step`, `建立步驟`
Delete step: `delete step`, `刪除step`, `remove step`
Step question: `step 怎麼`, `how to add step`, `怎麼新增step`

## Rules

### Adding a Step
- Extract label from user text (everything after the command keyword)
- Default label if none given: `"New Step"`
- Use `steps.add` with `select: true`

### Step Questions (help)
- Return `toolCalls: []` and explain how to use steps
- Example reply: "你可以直接說「新增 step 安裝定位」，或先操作後說「save step」。"

## Tool

```json
{
  "tool": "steps.add",
  "args": { "label": "Step Name", "select": true }
}
```
