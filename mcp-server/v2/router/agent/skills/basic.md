## 基礎技能：常見工具

### Grid
- 開/關格線：`view.set_grid_visible`
  - args: `{ "visible": true|false }`

### Reset
- 重置某個零件：`action.reset_part`
  - args: `{ "part": { "partId": "<id>" } }`
- 重置全部零件：`action.reset_all`

### Select
- 選取零件：`selection.set`
  - args:
    - `selection.kind = "part"`
    - `selection.part.partId = "<id>"`
    - `replace = true`

### Mode
- 切模式：`mode.set_interaction_mode`
  - args: `{ "mode": "select|move|rotate|mate", "reason": "chat_router" }`

### Undo/Redo
- `history.undo` / `history.redo`

### Steps
- 新增 step：`steps.add`
  - args: `{ "label": "<text>", "select": true }`

