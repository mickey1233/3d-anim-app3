# Skill: Object Grounding (Natural Language Part Reference)

## Recommended high-level command (use this first for assembly requests)

When user wants to assemble parts using natural language, use this single tool that handles grounding + assembly planning in one step:

```json
{
  "tool": "query.plan_assembly_from_utterance",
  "args": {
    "utterance": "<user's exact text>",
    "selectedPartIds": ["<ids of selected parts if any>"]
  }
}
```

**If `status: "ready"`**: Apply the top candidate using `action.apply_candidate` with `sourcePart: { partId: resolvedSource.partId }` and `targetPart: { partId: resolvedTarget.partId }` and `candidateId: topCandidate.id`.

**If `status: "needs_clarification"`**: Return `clarificationQuestion` to user directly. Do NOT guess.

**If `status: "resolved_but_objects_not_found"`**: Report the resolved parts but explain Three.js objects aren't loaded yet.

---

## When to use this skill

When the user refers to parts using:
- Natural language descriptions: "風扇", "機殼", "那塊板子", "散熱器"
- Deictic references: "這個", "這兩個", "這塊", "this one", "these parts"
- Vague assembly commands: "把這兩個組起來", "幫我組裝一下"

## Quick Decision Flow

### 1. Check if part names are already explicit
If user says "mate FAN_LEFT and THERMAL" → both names match parts exactly → skip grounding, use directly.

### 2. Check for deictic references
If user says "這個"/"this"/"these" AND parts are selected in UI → use selected parts directly.

### 3. Use grounding tool
For all other cases where parts need to be resolved from natural language (lower-level alternative to `query.plan_assembly_from_utterance`):

```json
{
  "tool": "query.ground_objects_from_utterance",
  "args": {
    "utterance": "<user's exact text>",
    "selectedPartIds": ["<ids of currently selected parts if any>"],
    "parsedSourceConcept": "<extracted source concept if you can identify it>",
    "parsedTargetConcept": "<extracted target concept if you can identify it>"
  }
}
```

### 4. Handle the result

**If `resolved: true`**: Proceed with assembly using `topSource.partId` and `topTarget.partId`.

**If `needsClarification: true`**: Reply with `clarificationQuestion` to user. Do NOT guess.

**If source/target candidates found but not unambiguous**: Show user the options. Example:
> 我找到兩個可能的風扇：HOR_FAN_LEFT、HOR_FAN_RIGHT。你要哪一個？

### 5. After clarification
Once user confirms which part, re-run assembly with the confirmed part IDs.

## Refreshing part semantics

If you notice no VLM labels exist (all cards are unlabeled), trigger labeling:

```json
{
  "tool": "query.refresh_part_semantics",
  "args": {}
}
```

## Viewing scene part descriptions

To see what the system knows about parts:

```json
{
  "tool": "query.describe_scene_parts",
  "args": { "includeUnlabeled": true }
}
```

## Important rules

- **Never silently pick** one fan out of two fans without clarification
- **Always prefer deictic + selection** when user says "這個"
- **VLM labels are cached** — no need to refresh on every query
- **Grounding is upstream of assembly** — always ground first, then assemble
