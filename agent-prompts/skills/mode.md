# Skill: Interaction Mode

## Triggers

Any of: `mode`, `模式`, `rotate`, `move`, `mate`, `select mode`

## Modes

| mode | Triggers |
|------|----------|
| `rotate` | rotate/旋轉/旋转/轉動 |
| `move` | move/移動/移动/平移 |
| `mate` | mate/對齊/组装/裝配 (mode context) |
| `select` | select mode/選取模式/选择模式 |

## Tool

```json
{
  "tool": "mode.set_interaction_mode",
  "args": { "mode": "rotate", "reason": "chat_router" }
}
```
