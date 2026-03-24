# Skill: Mate Intent Classification

## Overview

Every assembly command has an **intent** — the relationship between the two parts.
Intent drives **mode**, **anchor method priority**, and **face selection**.

There are three intent types: `insert`, `cover`, `default`.

---

## Intent: `insert`

The source part goes **into** or **through** the target. Think: plug-in, snap-in, push-fit.

### Defining characteristics
- Source is **smaller** than target in at least 2 dimensions (fits inside)
- Movement is **along** the target's cavity axis
- Parts have **overlapping footprint** (XY or XZ overlap > 45% before movement)
- After assembly, source is **enclosed or surrounded** by target

### Real-world examples
| Source | Target | Trigger words |
|--------|--------|---------------|
| USB-A plug | USB port | insert, plug in, plug into |
| Screw | Threaded hole | screw in, thread into |
| Peg / pin | Hole / socket | plug, peg, pin into |
| Button / key cap | Keycap socket | snap in, press in, fit into, 卡入 |
| Bolt | Nut (interior) | 插入, 塞進, 塞进 |
| PCB header pin | Connector housing | insert, 插槽, socket |
| Pipe fitting | Pipe collar | slide into |
| Drawer | Cabinet opening | slide in |
| Battery | Battery compartment | slot, 塞進 |
| SIM card | SIM tray slot | 插入卡槽 |
| Lens cap | Lens tube (inner) | push on (inner fit) |

### Geometry signals (from bboxSize + relativePosition)
- `sourceSize[i] <= targetSize[i] * 0.94` in 2 axes → strong insert signal
- XY overlap ratio > 0.45 while separated on Z axis → insert along Z
- XZ overlap ratio > 0.45 while separated on Y axis → insert along Y

### Preferred anchor methods
- **Source**: `extreme_vertices` first (tip of pin/peg), then `planar_cluster`, `geometry_aabb`
- **Target**: `planar_cluster` first (inner face of hole), then `extreme_vertices`, `geometry_aabb`

### Mode
- `insert` intent → `mode: "translate"` (straight push-in)
- Exception: spiral/thread insert → `mode: "twist"` (only if "screw", "thread", "旋入" mentioned)

---

## Intent: `cover`

The source part **covers, closes, or caps** the target from **outside**. Think: lid-on-box.

### Defining characteristics
- Source is **same size or slightly larger** than the target's opening (≥ 94% in horizontal dims)
- Movement is **perpendicular** to the contact surface (usually top-to-bottom or front-to-back)
- Source sits **on top of** or **around** the target (not inside)
- After assembly, source **encloses** the target's opening from outside

### Real-world examples
| Source | Target | Trigger words |
|--------|--------|---------------|
| Bottle cap / lid | Bottle body | cover, lid, cap, 蓋上, 蓋 |
| Box lid | Box body | close, seal, 合上, 盖上 |
| Snap cover | Electronics enclosure | cover, snap on, 扣上 |
| Protective cap | Sensor / nozzle | cap, 蓋起來 |
| Camera lens cap | Camera lens | lens cap, 鏡頭蓋 |
| Pan lid | Cooking pan | 蓋鍋蓋 |
| Phone back cover | Phone body | back cover, 後蓋 |
| Manhole cover | Manhole opening | cover, 蓋子 |
| Car hood | Engine bay | hood, 引擎蓋 |
| Window shutter | Window frame | close, 關上 |

### Geometry signals
- Source bbox is **same or slightly larger** than target opening in XZ plane
- Centers are separated primarily on **Y axis** (vertical stacking)
- `abs(delta.y) > (sourceSize.y + targetSize.y) * 0.22` AND XZ overlap > 50%

### Preferred anchor methods
- Both source and target: `planar_cluster` first (flat faces), then `auto`, `geometry_aabb`

### Mode
- `cover` intent + explicit "cover/蓋上/insert/arc" keyword → `mode: "both"` (arc approach path)
- `cover` intent + generic command only → `mode: "translate"` (straight approach)
- **CRITICAL**: Generic "assemble / 組裝 / mate" commands with cover geometry → still `translate`

---

## Intent: `default`

General alignment — no clear insert or cover geometry/semantics. Flush-face contact.

### Examples
| Source | Target | Description |
|--------|--------|-------------|
| PCB board | Chassis base | flat surface mount |
| Bracket | Wall panel | side attach |
| Two flat plates | Each other | align, flush |
| Shelf | Support bracket | rest on |
| Gear | Adjacent gear | mesh/align |
| Frame component | Assembly frame | general mate |

### Mode
- `default` intent → `mode: "translate"` always

---

## Decision Priority

1. **Explicit user keywords** → highest priority
   - "insert/plug/slot/插入/塞進" → `insert`
   - "cover/lid/cap/蓋上/合上" → `cover`
   - "twist/screw/rotate and insert/旋入" → `insert` with `mode: "twist"`

2. **Geometry signals** (from bbox + relative position) → if instruction doesn't specify

3. **Default** → `default` intent, `mode: "translate"`

## Mode Rules Summary

| Intent | Generic command | Explicit cover/insert keyword |
|--------|----------------|-------------------------------|
| insert | translate | translate (or twist if "screw") |
| cover | translate | both |
| default | translate | translate |

**Never** infer `mode: "both"` from geometry alone without explicit user keywords.
