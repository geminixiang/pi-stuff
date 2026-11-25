# Agent brief template

Fill every section; delete none. Short sentences.

```
新任務（manager 派）：<一句話目標，附 issue／PR 連結>

背景（先完整讀，含所有留言、連結的 issue／PR、PR 的 review 與 commit 歷史；可用 uv run ~/Github/pi-stuff/skills/manager-workflow/scripts/issue-context.py <repo#n> --linked，一次撈完、有快取，不要逐則打 REST）：
- <issue／PR／留言連結，特別是使用者的留言>
- <repo 的 AGENTS.md、CONTRIBUTING.md、相關 skill>

使用者已決定（附原話或留言連結）：
- …

要做：
1. …（每步一個可檢查的完成條件）

不在範圍：
- …

規則：
- 唯讀／可以改什麼；動正式環境前先回報 manager
- 照該 repo 的 issue／PR 規範；開好 `gh pr ready`；不要 merge（除非使用者說可以）
- 不加程式註解，說明放 PR 描述
- gcloud 一律加逾時：`perl -e 'alarm shift; exec @ARGV' 60 gcloud ...`；Cloud Build 狀態用 `gh api .../check-runs`
- 推論要標明；不要印出密碼或 key
- 用自己的 worktree，不要在共用 checkout 切 branch
- 有寫給人看的文件（README、docs、tool 說明、PR 描述）就照 ~/Github/pi-stuff/skills/manager-workflow/DOCS.md 用 rex 開 agy（gemini-4-neon-high）精簡一次，自己核對 diff 後獨立 commit

回報：<要回報什麼、格式>
```
