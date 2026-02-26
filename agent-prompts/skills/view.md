# Skill: View / Environment

## Triggers

Environment names (any language): warehouse/倉庫, studio/工作室, city/城市, sunset/黃昏, dawn/清晨, night/夜晚, forest/森林, apartment/公寓, lobby/大廳, park/公園

Camera: reset camera/重置鏡頭/reset view

## Rules

- Match environment name and pass to `view.set_environment`
- For camera reset, use `view.reset_camera`

## Tool

```json
{
  "tool": "view.set_environment",
  "args": { "environment": "warehouse" }
}
```
