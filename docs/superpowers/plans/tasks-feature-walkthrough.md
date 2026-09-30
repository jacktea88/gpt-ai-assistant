# Tasks Feature Walkthrough：任務功能，以及它和筆記的共通模式

這份文件是 [notes-feature-walkthrough.md](notes-feature-walkthrough.md) 的姊妹篇。筆記是最小切片，任務是成熟切片。兩者並排，最容易看出這個專案「新增一個功能」的固定套路，以及功能複雜起來之後，各層會多長出什麼。

以下內容都對照目前的程式碼撰寫；找不到證據的地方會明說。

## 1. 任務功能的使用者視角

啟用條件：`ENABLE_TASKS=true` 且已設定 `DATABASE_URL`（[config/index.js](../../../config/index.js)）。

| 使用者輸入 | 效果 |
| --- | --- |
| `新增任務 週五前交報告 #工作` | 用 OpenAI 解析標題／期限／優先度，`#標籤` 用正則抽出，存入 `tasks` |
| `我的任務` / `我的任務 今天` / `我的任務 #工作` | 列出未完成任務，可依期間或標籤篩選，附「完成／刪除」按鈕 |
| 按下「完成」「重開」「刪除」按鈕 | 以 postback 帶任務 id 觸發同一個 handler |

## 2. 一則訊息的路徑

```text
LINE webhook
→ api/index.js（驗簽、durable enqueue）
→ services/worker.js handleLineEvent（checkpoint A：AI 只跑一次）
→ app/app.js handleContext（handler 鏈）
→ app/handlers/tasks.js
   ├─ services/task-parser.js → services/openai.js（自然語言 → 草稿）
   ├─ schemas/task-draft.js（驗證草稿）
   ├─ repositories/tasks.js → Postgres
   ├─ services/task-reminder-scheduling.js → jobs 表（提醒排程）
   └─ repositories/jobs.js enqueueJob（Google Tasks 同步）
→ context.pushText(...) → replyMessage（checkpoint B）
```

與筆記相同的部分：入口、queue、checkpoint、reply 送達完全共用。差別在中間的 handler 裡多接了三件事：AI 解析、提醒排程、Google 同步。

## 3. 逐層對照

### 3.1 handler 掛點

[app/app.js](../../../app/app.js) 的 `handleContext` 是 `||` 短路鏈：前一個 handler 的 `check()` 為 `false` 就回 `false`，交給下一個。順序是：

```text
… weather → notes → reminders → task → schedule → talk
```

任務（`taskHandler`）在 `schedule` 之前、`talk` 之前。原因是任務與行程的措辭可能相近，指令型的先接，最後才落到一般 AI 對話 `talk`。注意匯出名稱是 `taskHandler`（單數），不是 `tasksHandler`。

### 3.2 handler 本體：[app/handlers/tasks.js](../../../app/handlers/tasks.js)

結構和 [app/handlers/notes.js](../../../app/handlers/notes.js) 完全同形：

1. `check(context)`：`TASK_COMMANDS.some(context.hasCommand)`。
2. `exec(context)`：先擋 `ENABLE_TASKS` 與 `isDatabaseConfigured()`，不通過就回 `__ERROR_FEATURE_DISABLED`。
3. `upsertUser` 取得 `owner`，之後依指令分派。
4. 整段包在 `try/catch`，錯誤交給 `context.pushError`。

命令分派的順序是刻意的：`LIST → REOPEN → DONE → DELETE → 最後才是 CREATE`。因為 `hasCommand` 是 `startsWith` 比對，較長或較特定的指令必須排在通用的 `新增任務` 之前，否則會被吃掉。筆記也依同樣原則把 `LIST`、`DELETE` 放在 `CREATE` 前面。

### 3.3 共通的列表與分頁手法

兩個 handler 用同一套 LINE 互動做法：

- 多取一筆（`PAGE_SIZE + 1`）判斷「是否還有下一頁」。
- 每筆資料產生 quick reply 按鈕。`data` 放內部 id（postback），`displayText` 放使用者看得懂的「刪除 2」。
- 下一頁用 sentinel：`我的任務 <篩選>@<offset>`，再由同一個 handler 解析。

差別在頁面大小。任務用 `config.TASK_LIST_LIMIT`，註解寫明是 LINE quick reply 上限 13 = 6 筆 × 2 個動作 + 1 個「下一頁」。筆記每筆只有 1 個動作，所以 `PAGE_SIZE = 10`（10 + 1 = 11，不超過 13）。這個數字不是隨便選的，是每筆動作數決定的。

### 3.4 為什麼任務多了 AI 解析：[services/task-parser.js](../../../services/task-parser.js)

任務的價值在「期限」，而使用者是用自然語言說「週五前」。所以：

1. `#標籤` 先用正則確定性抽出，省 token 也更可靠。
2. 剩下文字交給 OpenAI（`json_schema` 嚴格輸出 `title / dueAt / priority`）。
3. `resolveWeekdayDate` 等函式先算出日期提示，模型若給錯，會被 `alignDateTimeToDate` 校正。
4. 模型解析失敗時，退回「整段當標題的無期限任務」，任務不阻塞、不追問。
5. 結果一定要經過 [schemas/task-draft.js](../../../schemas/task-draft.js) 驗證：拒絕未定義欄位、驗證 IANA 時區與日期，標籤最多 5 個、每個最多 20 字。

筆記完全沒有這層，因為它不需要理解內容。這是兩個功能最大的分歧點，也對應到 AGENTS.md 的原則：AI 只在有價值的地方用，且解析結果必須經過確定性驗證才能寫入。

### 3.5 為什麼任務用 transaction，筆記不用

`createNewTask` 的寫法：

```js
const task = await withTransaction(async (client) => {
  const executor = client.query.bind(client);
  const created = await createTask(owner.id, taskDraft, executor);
  await scheduleTaskReminder(owner, created, executor);
  return created;
});
```

建立任務與排提醒（寫入 `jobs` 表）必須在同一個交易裡：要嘛「任務與提醒 job 都存在」，要嘛都不存在。否則任務建好了、提醒沒排到，就會靜默漏提醒。這就是 outbox 模式。

筆記只寫一張表，所以 [repositories/notes.js](../../../repositories/notes.js) 直接用 `query` 即可，不需要 transaction。**判斷要不要用 transaction 的標準是：一次使用者動作是否要改動超過一個資料集合**。

### 3.6 任務狀態機與冪等

[repositories/tasks.js](../../../repositories/tasks.js)：

- `completeTask` 的 SQL 帶 `WHERE status = 'open'`。
- `reopenTask` 的 SQL 帶 `WHERE status = 'done'`。
- 兩者每次成功都 `version = version + 1`。

回傳 `null` 時，handler 再用 `getTask` 區分「已經是該狀態」與「根本不存在」，分別回 `DONE_ALREADY` / `NOTFOUND`。LINE 使用者常會連點按鈕，這樣重複點擊不會出錯也不會重複產生副作用。

筆記沒有狀態，只有「存在或不存在」，所以 `deleteNote` 回傳 `rowCount > 0` 就夠了。

`version` 也是提醒與同步的冪等鍵一部分：`task-reminder:<id>:due:<version>`、`google-tasks-sync:<id>:<version>:<action>`。版本一變，舊提醒自然失效，並由 `cancelPendingTaskReminders` 主動取消。

### 3.7 提醒排程：[services/task-reminder-scheduling.js](../../../services/task-reminder-scheduling.js)

有期限、`ENABLE_REMINDERS=true`、且使用者有 `channel_target` 時，才排提醒。

- 到期時間一筆，加上 `config.REMINDER_OFFSETS` 的提前提醒。
- 已過去的時間不排。
- 以 `idempotencyKey` 去重，重複執行不會排出重複的 job。
- 迴圈裡刻意循序 `await`，註解說明是因為同一個 transaction client 不能同時跑多個 query。

這是為什麼任務 handler 的 `upsertUser` 會多帶 `channelTarget`（僅在 reminders 啟用時），而筆記不需要。

### 3.8 Google Tasks 同步（可選）

`enqueueTaskSync` 把變更包成 `google-tasks-sync` job 交給 [services/worker.js](../../../services/worker.js) 處理（`handleGoogleTasksSync`）。重點：

- 只在 `isGoogleTasksEnabled()` 且該帳號有 tasks scope 時才入列。
- 同步失敗只影響 Google 端，本機任務一律保留。
- 刪除時，若任務已有 `provider_task_id`，才在同一個交易內入列刪除 job。

這條路徑是任務獨有的。筆記沒有外部同步，也不該有。

## 4. 資料層：migration 為什麼有這麼多支

任務相關 migration 是逐步長出來的：

| Migration | 內容 |
| --- | --- |
| [0007_tasks.sql](../../../db/migrations/0007_tasks.sql) | 建立 `tasks`，含 `status` 與 `completed_at` 一致性 constraint |
| 0008_task_metadata | 加 `priority`、`tags` |
| 0011_task_sync | 加 `provider_task_id`、`sync_status`、`synced_at` |
| 0014 / 0016 | Google Tasks inbound 的輪詢時間與 claim lease（加在 `calendar_accounts`） |

對照筆記的 [0021_notes.sql](../../../db/migrations/0021_notes.sql)：一次建好一張只有 `id / owner_id / content / created_at / updated_at` 的表。

這說明一個原則：**migration 是 append-only 的歷史，功能長大就新增一支，不回頭改已發布的舊檔**（AGENTS.md：不改寫已發布 migration 的歷史語意）。

兩者共通的資料層規則：

- 主鍵 `uuid`，`owner_id` 為 `references users(id) on delete cascade`。
- 所有 SQL 都帶 `owner_id`，別人的 id 查不到、刪不到。
- 每個 migration 有對應 rollback。

## 5. 測試：兩者的寫法差很多

任務：[tests/app/handlers/tasks.test.js](../../../tests/app/handlers/tasks.test.js)

- 用 `jest.doMock` 把 `repositories/*`、`services/*` 全部換成 mock，直接 import handler。
- 手工做一個最小 `context`（`hasCommand`、`pushText`、`pushError`）。
- 因此可以直接驗證行為，例如「啟用 Google 同步時，`enqueueJob` 收到 `google-tasks-sync:t1:1:upsert`」。

筆記：[tests/notes.test.js](../../../tests/notes.test.js)

- 走完整 `handleEvents`，只驗兩件事：沒 DB 時有回應、`指令` 說明含 `【筆記】`。
- 只驗兩件事：沒 DB 時回「此功能目前已停用」、`指令` 說明含 `【筆記】`。

行為層另有 [tests/app/handlers/notes.test.js](../../../tests/app/handlers/notes.test.js)，照任務的模式 mock `repositories/notes.js` 與 `repositories/users.js`，直接測 handler 的建立、列表（含分頁）、刪除與錯誤分支。兩者的 SQL 本身都沒有被單元測試覆蓋。

## 6. 兩個功能的共通模式

不論功能大小，新增一個 LINE 指令功能都會經過下列固定步驟：

| 步驟 | 任務 | 筆記 |
| --- | --- | --- |
| 1. feature flag | `ENABLE_TASKS` | `ENABLE_NOTES` |
| 2. 資料表 + rollback | 0007 起共多支 | 0021 |
| 3. repository（只管 SQL、限定 owner） | `repositories/tasks.js` | `repositories/notes.js` |
| 4. command 物件 | `bot-task*.js` 共 5 個 | `bot-note*.js` 共 3 個 |
| 5. handler（check → 開關/DB 檢查 → upsertUser → 分派 → try/catch） | `handlers/tasks.js` | `handlers/notes.js` |
| 6. 掛到 `handleContext` 鏈 | `taskHandler` | `notesHandler` |
| 7. 三份 locale key 對齊（zh/en/ja） | 有 | 有 |
| 8. help 文案 | `__TEXT_COMMAND_HELP_TASKS` | `__TEXT_COMMAND_HELP_NOTES` |
| 9. 測試 | handler 行為測試（mock） | flag 與 help |

`app/commands/help.js` 兩者並列，`app/commands/index.js` 也都有匯出。

### 能力複雜度依需求「加層」，而不是一開始就全都有

```text
筆記：handler → repository → table
任務：handler → parser(AI) → schema 驗證
             → repository(狀態機、version)
             → transaction + 提醒 job
             → Google 同步 job
             → 多支 migration
```

多出來的每一層都對應一個明確需求：要理解自然語言（parser）、要防止 AI 亂寫（schema）、要重複點擊安全（狀態機）、要不漏提醒（transaction + outbox）、要對外同步（job）。沒有需求就不加。

### 幾個所有功能都要遵守的設計原則

- 功能只是 handler，不碰 queue／worker／checkpoint 契約，可靠性由共用 runtime 提供。
- 沒有 DB 就 fail closed，回 `__ERROR_FEATURE_DISABLED`，不假裝成功。
- 所有資料存取都限定 `owner_id`。
- 帶副作用的動作必須冪等（狀態條件、`idempotencyKey`、`version`）。
- 使用者介面用自然語言指令 + 按鈕，postback 內部帶 id，畫面顯示序號。

## 7. 對照時看到的、值得留意的事

這些是實際比對兩份程式碼時發現的，不是既有規範：

1. `stripCommand`、`stripTrailingMarks`、`parseListArg` 這類 helper 在 `tasks.js` 與 `notes.js` 各複製一份。目前專案沒有共用位置，複製符合現況；若之後出現第三個功能，才值得抽出。
2. [app/handlers/notes.js](../../../app/handlers/notes.js) 的 `parseListArg` 內有 `const [_, offsetPart] = ...`，目前 ESLint 通過，但這個 `_` 沒有用途，可以簡化。
3. [services/runtime-preflight.js](../../../services/runtime-preflight.js) 的 `LATEST_MIGRATION` 仍是 `0020_calendar_google_origin_baseline.sql`。也就是啟動檢查目前不會要求 `0021_notes.sql` 已套用；如果開了 `ENABLE_NOTES` 卻沒跑 migration，會在第一次查詢時才出錯，由 handler 的 `catch` 轉成錯誤回覆。要不要升級是一個需要決定的政策問題（升級會讓未套用的部署在啟動時失敗），並且要同步更新 preflight 測試與 [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md) 的說明。
4. 筆記不在一般 quick reply 裡，只在 `指令` help 出現；任務則在 [app/commands/index.js](../../../app/commands/index.js) 的 quick reply 清單中（`ENABLE_TASKS` 時），因為 quick reply 數量有上限。

## 8. 建議的閱讀順序

1. [app/app.js](../../../app/app.js)：先看 `handleContext` 鏈。
2. [app/handlers/notes.js](../../../app/handlers/notes.js)：最小版本，先讀懂骨架。
3. [app/handlers/tasks.js](../../../app/handlers/tasks.js)：找出相同骨架，再找多出來的部分。
4. [repositories/notes.js](../../../repositories/notes.js) vs [repositories/tasks.js](../../../repositories/tasks.js)：看狀態機與 `version`。
5. [services/task-parser.js](../../../services/task-parser.js) 與 [schemas/task-draft.js](../../../schemas/task-draft.js)：AI 輸出如何被約束。
6. [services/task-reminder-scheduling.js](../../../services/task-reminder-scheduling.js)：outbox 與冪等鍵。
7. [tests/app/handlers/tasks.test.js](../../../tests/app/handlers/tasks.test.js)：學 handler 的 mock 測試寫法，再對照 [tests/app/handlers/notes.test.js](../../../tests/app/handlers/notes.test.js)。

## 9. 自我檢查

讀完後，試著不看文件回答：

1. 為什麼任務建立要用 `withTransaction`，筆記不用？
2. `completeTask` 回 `null` 時，為什麼還要再 `getTask` 一次？
3. 為什麼分頁大小任務是 6、筆記是 10？
4. 如果要新增一個「單筆筆記檢視」功能，你需要動哪幾層？哪幾層完全不用動？

答案分別在 3.5、3.6、3.3 與第 6 節。
