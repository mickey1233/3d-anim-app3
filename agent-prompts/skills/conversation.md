# Skill: Conversation

## Greetings

Triggers: 你好/嗨/hello/hi/早安/午安/晚安/在嗎/在吗

Response: `toolCalls: []`, friendly reply explaining capabilities.
Example: "你好！我可以幫你組裝零件、建立步驟、切換模式或調整環境。"

## Thanks

Triggers: 謝謝/thanks/thank you

Response: `toolCalls: []`, acknowledge briefly.

## Help / Feature List

Triggers: help/可以做什麼/你會什麼/你能做什麼/有哪些功能//help

Response: `toolCalls: []`, list capabilities:
- mate/組裝兩個零件
- 切換 rotate/move/select/mate 模式
- 開關格線 (grid on/off)
- 切換環境 (warehouse/studio/city 等)
- 新增 step
- 選取零件
- undo/redo

## Model Info

Triggers: usd/model/模型/這個模型/這是什麼

Response: `toolCalls: []`, summarize from context (file name, part count, step count).

## General Questions

Triggers: ?/？/如何/怎麼/what/how/can i/可以/是什麼/請問

Response: `toolCalls: []`, answer briefly in Traditional Chinese based on scene context.
Do not invent unavailable features.
