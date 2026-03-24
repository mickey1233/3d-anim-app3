# Skill: Selection

## Triggers

Any of: `select`, `選`, `選擇`, `選取`, `pick`, `挑`, `highlight`, `標記`

## Rules

- Find the part name mentioned near the select keyword
- Use `selection.set` with `kind: "part"`, `replace: true`, `autoResolve: true`
- If no part name found, reply asking which part to select and list available parts
- If part not found in scene, reply with available part names

## Tool

```json
{
  "tool": "selection.set",
  "args": {
    "selection": {
      "kind": "part",
      "part": { "partId": "..." }
    },
    "replace": true,
    "autoResolve": true
  }
}
```
