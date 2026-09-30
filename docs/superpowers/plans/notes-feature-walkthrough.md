# Notes Feature Walkthrough

這份文件不是單純介紹「筆記功能怎麼用」，而是用這次新增的筆記功能，反過來帶你理解這個專案平常是怎麼運作、為什麼改動會分散在不同層、以及後續開發時應該怎麼切問題。

如果你未來要加第二個功能，最有價值的不是記住這次改了哪些檔案，而是看懂：

1. 使用者的一句話怎麼進到系統。
2. 哪一層負責判斷功能。
3. 哪一層負責資料存取。
4. 哪一層負責功能開關與對外說明。
5. 哪些地方故意不要碰。

## 先用一句話理解這個專案

這個 repo 是一個以 LINE 為前端、OpenAI 為預設 AI、Supabase/Postgres 為 durable state 的個人助理。

它不是單純「收到訊息就回覆」，而是把流程拆成兩層：

1. 入口與可靠性層：確保 webhook、queue、delivery、retry、安全邊界不亂掉。
2. 功能邏輯層：例如聊天、搜尋、行程、任務、提醒、這次新增的筆記。

這個分層很重要，因為你加功能時通常只需要改功能邏輯層，不應該一開始就去碰 queue、worker 或 runtime preflight。

## 從外到內看一次執行流程

以使用者在 LINE 傳送：

```text
新增筆記 這週要整理報稅資料
```

為例，整體路徑可以簡化成：

```text
LINE webhook
→ api/index.js
→ durable enqueue / drain
→ app/app.js handler pipeline
→ app/handlers/notes.js
→ repositories/notes.js
→ Postgres
→ context.pushText(...)
→ replyMessage(...)
→ LINE
```

### 第 1 層：HTTP 入口與 durable runtime

入口在 [api/index.js](../../../api/index.js)。

這一層先做幾件事：

1. 驗簽。
2. 檢查 runtime 是否 ready。
3. 把事件 durable 入列。
4. 在回 `200` 後觸發 queue drain。

這代表新功能通常**不用自己處理 webhook 重送、retry、reply token lifecycle**。那些屬於共用 runtime，已經由 queue / worker 路徑處理。

對新增筆記功能來說，這是第一個關鍵設計點：

筆記只是「新的 handler」，不是「新的 webhook 或新的 queue 類型」。

所以這次完全沒有改 [api/index.js](../../../api/index.js) 的入口語意，也沒有改 [services/worker.js](../../../services/worker.js) 的 checkpoint contract。

## 第 2 層：事件如何進入 handler pipeline

真正把一則訊息導向某個功能的地方，在 [app/app.js](../../../app/app.js)。

最重要的是這個 handler chain：

```text
activate
→ command
→ continue
→ deactivate
→ deploy
→ doc
→ draw
→ forget
→ enquire
→ report
→ retry
→ search
→ version
→ weather
→ notes
→ reminders
→ tasks
→ schedule
→ talk
```

它的語意不是「全部都跑」，而是「依序嘗試，誰接住誰處理」。

這次新增筆記功能，就是把 `notesHandler` 掛進這條鍊上，位置在 weather 後、reminders/tasks/schedule 前。原因是：

1. 它屬於明確文字指令型功能，不應該落到最後的 `talkHandler` 當成一般 AI 對話。
2. 它不像 reminders 那樣需要先處理 postback 或排程副作用。
3. 它與 tasks 類似，都是使用者明確輸入指令後做 CRUD。

因此這次改了：

- [app/app.js](../../../app/app.js)
- [app/handlers/index.js](../../../app/handlers/index.js)

這是這個專案新增功能時最常見的掛點之一。

## 第 3 層：handler 是功能的控制器

筆記功能真正的控制器在 [app/handlers/notes.js](../../../app/handlers/notes.js)。

你可以把 handler 理解成「使用者指令到業務行為」的橋接層。它的責任通常包括：

1. 檢查這則訊息是不是自己要處理的。
2. 驗證功能是否啟用。
3. 驗證必要依賴是否存在，例如 DB。
4. 解析指令文字。
5. 呼叫 repository / service。
6. 把結果轉成 LINE 要回的文字或按鈕。

這次的 `notesHandler` 也是這樣拆的：

### `check(context)`

判斷訊息是否命中：

- `新增筆記`
- `我的筆記`
- `刪筆記`

這一步用的是 command 物件搭配 `context.hasCommand(...)`，和其他 handler 的風格一致。

### `exec(context)`

這裡先做兩個 fail-closed 檢查：

1. `ENABLE_NOTES` 是否開啟。
2. `DATABASE_URL` 是否存在。

這樣做的原因很務實：

- 筆記是持久化功能，沒有 DB 就不應該假裝成功。
- 這個專案對 durable state 的原則很一致，不能在沒有持久層時偷偷退回記憶體內暫存。

### `createNewNote()`

這一步做的事很單純：

1. 從指令文字中移除 `新增筆記` 前綴。
2. 去掉尾端標點。
3. 若內容為空，回 usage。
4. 呼叫 repository 建立資料。
5. 回使用者「已新增筆記」。

這裡**沒有**引入 OpenAI、沒有做自然語言解析、沒有排 reminder，也沒有 Google sync。這是刻意的。

原因是筆記功能的最小價值是「穩定保存文字」，不是「先做很聰明的摘要或分類」。

### `listNotesView()`

這一步會：

1. 查詢筆記列表。
2. 顯示前 10 筆。
3. 產生 quick reply / postback 按鈕給刪除。
4. 若有下一頁，追加 `下一頁`。

這裡的設計直接沿用任務功能的模式：

- LINE 很適合列表 + 按鈕式操作。
- 使用者不需要手打一個很長的 note id。
- postback 可帶內部 id，但對使用者顯示仍然是自然語言操作。

### `removeNote()`

刪除流程同樣很薄：

1. 從 postback / 指令取出 id。
2. 呼叫 repository 刪除。
3. 依結果回 `已刪除筆記` 或 `找不到那筆筆記`。

這裡也遵守 owner-scoped 原則：只能刪自己的資料。

## 第 4 層：repository 才負責資料庫

資料存取在 [repositories/notes.js](../../../repositories/notes.js)。

這一層的原則是：

1. 不做 LINE UI 決策。
2. 不做使用者文案。
3. 不處理 command 解析。
4. 只專心處理 SQL 與資料邊界。

這次做了三個最小方法：

1. `createNote(ownerId, content)`
2. `listNotes(ownerId, { limit, offset })`
3. `deleteNote(ownerId, id)`

你會發現它和 handler 分得很乾淨。這是這個 repo 很值得沿用的習慣：

- handler 決定「何時做」。
- repository 決定「怎麼存」。

好處是後續如果你要把筆記加入搜尋、標籤、全文檢視，不需要先翻整個 handler 鏈。

## 第 5 層：資料表與 migration

資料表定義在 [db/migrations/0021_notes.sql](../../../db/migrations/0021_notes.sql)。

這次新增的是一張很小的表：

- `id`
- `owner_id`
- `content`
- `created_at`
- `updated_at`

這個設計看起來簡單，但其實是有意識地保守。

### 為什麼不直接塞進 `tasks` 表？

因為 task 和 note 雖然都保存文字，但產品語意不同：

- task 有狀態、期限、提醒、同步、版本。
- note 只是純文字記錄。

若強行共用同一張表，之後會把「非任務資料」硬塞進任務模型，增加查詢與維護複雜度。

### 為什麼不一開始就做 tags / title / summary？

因為第一版的正確問題是：

> 使用者能不能穩定記下一段文字，之後列出與刪除？

先把最小可用價值落地，比一開始就做完整知識庫更合理。

### 為什麼需要獨立 rollback？

因為這個 repo 的 migration/rollback 是有明確機制的，新增 migration 就應該補對應 rollback 檔案，讓資料層變更可預期。

這次因此新增了：

- [db/migrations/0021_notes.sql](../../../db/migrations/0021_notes.sql)
- [db/rollbacks/0021_notes.sql](../../../db/rollbacks/0021_notes.sql)

## 第 6 層：command 與 locale 為什麼也要改

在這個 repo，新功能通常不只是一個 handler。若功能要真的「可被使用者發現並操作」，通常還要同步改三類東西：

1. command 定義
2. locale 文案
3. help / 文件

### command 定義

這次新增了：

- [app/commands/bot-note.js](../../../app/commands/bot-note.js)
- [app/commands/bot-note-list.js](../../../app/commands/bot-note-list.js)
- [app/commands/bot-note-delete.js](../../../app/commands/bot-note-delete.js)

原因是 `context.hasCommand(...)` 依賴 command 物件，不是硬編字串比對。這種做法有幾個好處：

1. 指令與 alias 集中管理。
2. locale 可切換。
3. help 可以重用同一組命名系統。

### locale 文案

這次同步改了：

- [locales/zh.js](../../../locales/zh.js)
- [locales/en.js](../../../locales/en.js)
- [locales/ja.js](../../../locales/ja.js)

原因不是為了做滿國際化，而是這個 repo 有一個明確規則：三份 locale key 集合要一致，測試也會檢查。你只改 zh、不改 en/ja，測試就會壞。

### help 文案

這次也改了 [app/commands/help.js](../../../app/commands/help.js)，讓 `指令` 說明在 `ENABLE_NOTES=true` 時會出現筆記區塊。

這一步很重要，因為在 LINE 介面裡，使用者通常不會知道一個新功能存在，除非：

1. 你把它放進 quick reply。
2. 你把它放進 help。
3. 你在 README/文件提到。

這次沒有把它塞進 general quick reply，原因是 quick reply 幾乎已達 LINE 的項數上限；直接再塞進去風險比較高，所以先透過 help 暴露是更穩健的選擇。

## 第 7 層：feature flag 與設定為什麼必須一起改

這次新增了 `ENABLE_NOTES`，位置在 [config/index.js](../../../config/index.js)，並同步寫進 [\.env.example](../../../.env.example) 與 [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md)。

這樣改有三個原因：

1. 和既有 schedule/tasks/weather 一樣，功能可以明確開關。
2. 自架專案需要讓維護者知道這個功能需不需要 DB/migration。
3. 不會讓尚未升級 schema 的部署在功能半開狀態下誤踩資料層。

這反映出這個 repo 很重要的一條風格：

> 新能力若依賴資料表或外部設定，不能只改程式碼，還要把 feature gate 與操作說明補齊。

## 第 8 層：測試為什麼這樣寫

這次新增的是 [tests/notes.test.js](../../../tests/notes.test.js)。

測試分成兩層：

1. [tests/notes.test.js](../../../tests/notes.test.js)：走完整 `handleEvents`，驗證整合層。
   - `ENABLE_NOTES=true` 但沒有 DB 時，回覆「此功能目前已停用」。
   - `指令` help 在 `ENABLE_NOTES=true` 時會出現筆記區塊。
2. [tests/app/handlers/notes.test.js](../../../tests/app/handlers/notes.test.js)：仿照 [tests/app/handlers/tasks.test.js](../../../tests/app/handlers/tasks.test.js)，用 `jest.doMock` 換掉 repository 與 `users`，直接測 handler 行為。
   - 非筆記指令回 `false`。
   - 功能關閉、沒 DB 時不碰任何資料。
   - 建立：去掉指令與句尾標點、帶 `owner.id`、內容為空時回 usage。
   - 列表：空狀態、每筆一個刪除按鈕、超過一頁時出現 `@offset` 下一頁按鈕、依 offset 續編序號。
   - 刪除：帶 `owner.id`、找不到時回 not found、沒給 id 時回 usage。
   - repository 拋錯時走 `pushError`。

這裡的重點是：mock 掉 repository 之後，就能不連資料庫驗證 handler 的所有分支。SQL 本身（例如 `WHERE id AND owner_id`）沒有被這些測試覆蓋，因為專案沒有現成的 DB 整合測試框架；那部分只能靠實際套用 migration 後手動驗證。

## 用這次功能反推：這個專案平常新增功能的套路是什麼

如果你下次要再加一個類似功能，通常會沿這個順序思考：

1. 這是單純 handler 功能，還是需要碰 queue/runtime？
2. 要不要持久化？如果要，資料模型是新表還是延用舊表？
3. 使用者怎麼觸發？需要哪些 commands？
4. 功能要不要掛 feature flag？
5. help / locale / 文件要不要同步更新？
6. 第一輪最小驗證是什麼？

筆記功能這次的答案分別是：

1. 單純 handler 功能，不碰 queue/runtime。
2. 要持久化，且應該用新表，不和 tasks 混用。
3. 用 `新增筆記 / 我的筆記 / 刪筆記`。
4. 要，用 `ENABLE_NOTES`。
5. 要，因為這是可被使用者主動操作的新功能。
6. 先驗證 feature gate 與 help 掛載，再擴展 deeper tests。

## 哪些地方這次刻意沒有改

理解「沒改什麼」和理解「改了什麼」同樣重要。

這次沒有改：

1. [api/index.js](../../../api/index.js) 的 webhook / queue 入口語意。
2. [services/worker.js](../../../services/worker.js) 的 checkpoint 與 retry contract。
3. Google 相關 service/repository。
4. reminder / cron 流程。
5. OpenAI 相關解析或摘要流程。

原因很單純：筆記功能的最小價值不需要這些，硬碰只會放大風險。

## 如果你要繼續擴充這個功能，合理的下一步是什麼

比起立刻做「很大」的知識庫功能，更合理的下一步是沿著現在的模型增量擴充：

1. 單筆筆記全文檢視。
2. 編輯筆記。
3. 筆記標籤或分類。
4. 關鍵字搜尋筆記。
5. 長文輸入時自動截斷預覽、全文另存。

若要再更進一步，才考慮：

1. 摘要後保存。
2. 從網址摘要存成筆記。
3. 和任務/行程交叉引用。

## 閱讀順序建議

如果你要用這次筆記功能當作學習切片，建議照這個順序重讀一次：

1. [app/handlers/notes.js](../../../app/handlers/notes.js)
2. [repositories/notes.js](../../../repositories/notes.js)
3. [db/migrations/0021_notes.sql](../../../db/migrations/0021_notes.sql)
4. [app/commands/index.js](../../../app/commands/index.js)
5. [app/commands/help.js](../../../app/commands/help.js)
6. [config/index.js](../../../config/index.js)
7. [tests/notes.test.js](../../../tests/notes.test.js)
8. 再回頭對照 [app/app.js](../../../app/app.js) 與 [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md)

你讀完後，應該能回答這三個問題：

1. 為什麼筆記功能是 handler + repository + migration，而不是只改一個檔案？
2. 為什麼這次沒有碰 queue/worker，但功能仍然能正常回覆使用者？
3. 為什麼 feature flag、locale、help、文件要一起改？

如果這三題你都能自己講清楚，就代表你已經不是只看懂這次功能，而是真的開始理解這個 repo 的開發節奏了。