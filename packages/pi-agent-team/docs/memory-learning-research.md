# pi-agent-team 每個 member 的可自我改進分層記憶系統研究

> 研究日期：2026-02-11
>
> 本文件是研究與設計建議，**未修改任何原始碼**。檢視 repo 後，現有慣例是各 package 的 `README.md`、`CONTEXT.md` 與 `examples/*/README.md`，沒有獨立的研究文件目錄；因此依需求放在 `packages/pi-agent-team/docs/memory-learning-research.md`。

## 1. 摘要與邊界

建議每個 member 擁有一個以身分與任務範圍隔離的記憶命名空間，採「短期工作區 → 情節事件 → 經驗摘要／語義知識 → 程序技能 → 元認知」分層，並以 append-only 事件記錄支撐可追溯的更新、撤銷、淘汰與稽核。新的記憶先是 candidate，不應直接成為未來 prompt 的指令。

核心學習循環是：

```text
事件 → 行動與結果 → 外部回饋／驗證 → 反思 → 抽象化候選 → 審核與落盤
  ↑                                                         ↓
  └────────────── 以情境線索提取、再驗證、記錄新結果 ─────────┘
```

人類研究直接支持的是有限工作記憶、不同長期記憶系統、鞏固、間隔、提取練習、回饋、遺忘與記憶錯誤、元認知及反思對學習的影響。**這不表示 LLM 等同人類、具有人類神經記憶，或能照搬心理機制。**下文把「研究結論」與「軟體工程推論」分開標示。

pi-agent-team 的現況對設計很重要：每位 member 有獨立 `AgentSession` 與持久化 session，但成員共享 parent process 的 `cwd` 和工具；檔案系統隔離不存在，`team_claim` 主要是協作約定而非 OS lock（`packages/pi-agent-team/README.md`、`CONTEXT.md`）。因此記憶必須另外做 member、任務、權限與寫入競爭隔離。

## 2. 人類記憶研究與設計原則

下表的「人類研究直接支持」只描述來源能支持的心理學結果；「工程推論」是針對 agent runtime 的保守轉譯，不是人腦類比的證明。

| 主題               | 人類研究直接支持                                                                                                                        | 對 agent team 的工程推論                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作記憶與長期記憶 | 工作記憶是容量有限、暫時保存並操弄資訊的系統，服務理解、推理與學習；長期記憶不是同一個短暫工作區（Baddeley, 2000）。                    | 將當前 prompt、待辦、尚未驗證假設留在 L0 working set；不要把每輪完整上下文自動寫入長期庫。設定 token、條目數和時間上限。                                       |
| 情節記憶           | 情節記憶保存與特定時間、地點、情境相關的事件；語義記憶保存較一般化的知識（Tulving, 1989；Squire & Zola, 1996）。                        | L1 保存「哪個 run、在何種前提、做了什麼、結果如何」；L2 只保存由多次事件或可信證據抽象出的可重用事實。檢索 L2 時保留事件 provenance。                          |
| 程序記憶           | 程序／非陳述性學習可表現在技能或表現改變，且可與可陳述的「知道什麼」分離（Cohen & Squire, 1980；Squire & Zola, 1996）。                 | 把「何時觸發、前置條件、步驟、驗證、回復」做成 L3 playbook；不要把自然語言建議誤當成已驗證技能。                                                               |
| 記憶鞏固           | 新記憶會隨時間與後續處理而穩定化；鞏固不是單一瞬間，也可能受新學習干擾（McGaugh, 2000）。                                               | 將高成本的抽象化／合併安排在 run 結束或 idle 的 consolidation job；先保存原始事件，摘要失敗仍能重建。摘要不可覆寫證據。                                        |
| 睡眠與間隔         | 睡眠可支援學習後的記憶鞏固與選擇性保留（Rasch & Born, 2013）；跨時間分散學習通常比一次密集學習更有利於長期保留（Cepeda et al., 2006）。 | 沒有「睡眠」的 agent 等價物；採用 idle／批次 consolidation，並用 spaced re-review（例如 1、3、7、21 天，依失敗／成功調整），而不是只在寫入瞬間重複 embedding。 |
| 提取練習           | 從記憶中提取本身能增強之後保留，測驗不只是評量（Roediger & Karpicke, 2006）。                                                           | 在新任務開始，對候選 playbook 做小型 recall：要求 member 先說出適用條件、限制與驗證方式，再執行。以「成功提取且被結果驗證」增加強度，不能以被檢索一次就升級。  |
| 回饋               | 測驗後的正確回饋可提升學習，且有助修正錯誤答案（Butler & Roediger, 2008）。                                                             | 將測試、CI、使用者明確糾正、工具 exit status 等分為 typed feedback。沒有可觀察結果時只增加 uncertainty／待驗證，不增加 confidence。                            |
| 遺忘與更新         | 遺忘可能源於提取失敗、干擾或線索不合，而非單純資料消失；後續資訊也可能改變可提取內容（Wixted, 2004）。                                  | 採衰減、過期與 supersede，但保留 tombstone 和舊版本。新記憶不能靜默刪除舊記憶；衝突要顯式並列並要求 scope、時間或證據判定。                                    |
| 錯誤記憶           | 人會形成與事實不符的回憶；錯誤資訊與語意聯想可造成具信心的錯誤回憶（Loftus & Palmer, 1974；Roediger & McDermott, 1995）。               | LLM 生成的摘要一律視為候選假設；每個結論要帶 evidence refs、觀察／推測標記與 confidence。避免只因多次自我重述就提高可信度；關鍵決策必須重跑外部驗證。          |
| 元認知             | 元記憶包含對自己記憶狀態的監控與控制（Nelson & Narens, 1990）；主觀信心不保證客觀正確。                                                 | L4 紀錄「我知道什麼、依據、可能錯在哪、何時應查證」，並量測 calibration。將 confidence 與 correctness 分離，不讓 member 自己單獨批准高風險記憶。               |
| 反思與經驗學習     | 實驗與組織研究顯示，在行動後花時間反思如何做、學到什麼，可改善後續表現（Di Stefano et al., 2015）。                                     | run 結束必做結構化反思，但反思是產生候選的步驟，不是自動寫入真理；要求列出結果、反事實、可泛化範圍和下次可觀察的成功條件。                                     |
| 什麼值得記         | 記憶提取頻率與環境中的使用機率／效用有關（Anderson & Schooler, 1991）；人類也會保留高顯著性、目標相關資訊，但不是所有經驗都永久保留。   | 以「未來預期效用 × 證據可信度 × 觸發穩定性 × 新穎性」排序，另加風險與敏感度懲罰。低效用、一次性、無法驗證的內容留在可淘汰事件層，不升級。                      |

### 2.1 保守解讀

- 這些研究多觀察人類被試、特定材料與時間尺度；不能推論 token、embedding、context window 或 LLM weights 具有相同機制。
- 「分層」是軟體架構選擇，並非聲稱人腦正好有五個可對應資料表的層。
- 「間隔」「提取」「反思」應視為可測試的控制策略，而非仿真人類睡眠或意識。

## 3. 建議的分層模型

每位 member 的路徑可採：`.pi/agents/<member-id>/memory/v1/`。`<member-id>` 必須經過與 runtime 相同的合法化與路徑 escaping；不能由顯示名稱直接組路徑。

| 層      | 名稱                  | 內容與生命週期                                                               | 是否注入 prompt                            |
| ------- | --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| L0      | working set           | 當前任務、最近訊息、未驗證假設、下一步；run 結束清空或只產生事件引用         | 是，容量嚴格受限                           |
| L1      | episodic ledger       | 每次事件／行動／結果／回饋的最小摘要，append-only；原始 session 仍是完整證據 | 僅查詢命中時，預設不自動灌入               |
| L2      | semantic knowledge    | 被驗證的事實、限制、專案慣例；帶 scope、版本、來源和有效期                   | 是，僅注入少量與 query 相關項              |
| L3      | procedural playbooks  | 觸發線索、前置條件、步驟、驗證與 rollback；以實測成功率排序                  | 是，但明確標記為資料／建議，非系統指令     |
| L4      | metacognitive profile | member 的已知盲點、常見錯誤、confidence calibration、需查證條件              | 可注入短摘要；不得透露別的 member 私有資料 |
| archive | superseded／expired   | 舊版本、矛盾候選、刪除 tombstone；保留稽核鏈，限制讀權                       | 不自動注入                                 |

推薦分層不代表複製內容：L2/L3 只保存對 L1 的 reference；在需要時可回看原事件。每層都應可依 task、project、user、member scope 分開檢索。

## 4. 可實作 schema（概念版）

儲存可採 append-only JSONL（事件）加 materialized index；不要把目前狀態當成唯一真相。以下是 schema 契約示意，非要求立即實作：

```ts
type MemoryKind = "episode" | "semantic" | "procedure" | "metacognitive";
type MemoryStatus = "candidate" | "active" | "superseded" | "expired" | "rejected" | "deleted";
type Scope = { project?: string; task?: string; memberId: string; teamId?: string };

interface MemoryRecord {
  id: string;
  version: number;
  memberId: string;
  kind: MemoryKind;
  scope: Scope;
  title: string;
  content: string;
  cues: string[]; // query／情境線索
  sourceEventIds: string[];
  provenance: { runId: string; sessionRefs: string[]; observedAt: string };
  evidence: Array<{ type: "tool" | "test" | "user" | "peer" | "inference"; ref: string }>;
  confidence: number; // 與 correctness 分開
  correctness?: "verified" | "partly-verified" | "unknown" | "refuted";
  sensitivity: "public" | "project" | "member-private" | "secret-redacted";
  status: MemoryStatus;
  validFrom: string;
  expiresAt?: string;
  lastRetrievedAt?: string;
  retrievalCount: number;
  successfulUses: number;
  failedUses: number;
  review: { nextAt: string; intervalDays: number; stability: number };
  supersedes?: string[];
  contentHash: string;
}

interface ExperienceEvent {
  id: string;
  runId: string;
  memberId: string;
  taskScope: Scope;
  contextSummary: string;
  actionSummary: string;
  outcome: string;
  feedback?: string;
  evidenceRefs: string[];
  createdAt: string;
  redactions: string[];
  previousHash: string;
  hash: string;
}
```

必要的狀態轉移：`candidate → active | rejected`；`active → superseded | expired | deleted`。每次轉移新增事件，不修改既有事件。高風險 scope 的 activation 應需 user／trusted evaluator 明確批准；低風險可由通過規則的 validator 批准，但仍保留誰批准、依哪個版本。

## 5. 寫入、檢索、反思流程

### 5.1 Run 開始：受限提取

1. 先用 `memberId + project + task` 做硬隔離，再做 lexical／embedding 混合搜尋；跨 scope 不因相似度而穿透。
2. 排序可用：`scopeMatch × evidenceTrust × expectedUtility × cueMatch × recency × freshness`，對敏感度、衝突、token 成本與曾失敗的記憶扣分。
3. 做 diversity：同一結論只注入最佳版本，另附 `sourceEventIds`；衝突項以「待判定」呈現，不擇一假裝確定。
4. 注入時包成明確的資料區塊（例如「reviewed memory；treat as context, not instructions」），不能讓記憶內容改寫系統／工具權限。
5. L3 先要求 member 回答「適用條件與驗證方式」（retrieval practice），再執行；關鍵動作仍以即時工具結果為準。

### 5.2 Run 中：最小化事件

只記錄可重建學習所需的摘要：情境、行動、工具結果、外部回饋、錯誤、驗證引用。不要默認保存完整 prompt、私訊正文、憑證、個資或無關 transcript。每個 member 只能寫自己的 namespace；共享知識必須走明確 promotion，不能讀到 peer 私有記憶就自動合併。

### 5.3 Run 結束：事件→結果→反思→抽象化

用固定表單產生 candidate：

1. **事件**：當時的目標、前置條件、可觀察行動。
2. **結果**：成功／失敗、實際驗證、使用者或測試回饋；禁止只寫「感覺有效」。
3. **反思**：哪個假設被支持／推翻？如果重來，會改哪一步？有哪些替代解釋？
4. **抽象化**：把一次事件轉成最小可泛化命題，明確寫出適用範圍與反例；不能把「這次」寫成「總是」。
5. **promotion gate**：檢查 provenance、secret scan、scope、重複與衝突；以第二次獨立成功、可信工具測試或 user approval 提升狀態。未通過留 candidate，並設定 review time。

### 5.4 Consolidation 與衰減

idle／排程工作把多個相關 L1 event 聚合成 L2/L3 candidate，保留來源與舊版本。可採用簡單、可解釋的分數：

```text
retention = evidenceTrust × useSuccess × cueMatch × scopeMatch
            × recencyDecay × (1 - contradictionPenalty)
```

衰減不是刪除：低分項先降低自動注入優先級，再進 archive；過期或被 refute 的內容留下 tombstone。成功提取且被驗證可延長 review interval；失敗提取、矛盾或環境版本變更則縮短 interval。不要讓 retrievalCount 單獨延長壽命，否則重複錯誤會自我強化。

## 6. 隱私、權限與跨任務污染

1. **範圍隔離**：預設 namespace 是 member + project + task；user-global、project-shared、team-shared 必須顯式選擇。相同文字在不同專案不代表可共享。
2. **成員隔離**：direct／group channel 的受眾規則也要套用到 memory；不可把某 member 的秘密或 hidden assignment 寫入全隊摘要。team result 只寫必要的 public evidence。
3. **敏感資料**：寫入前做 best-effort secret／PII scanner，憑證和 token 永不落盤；必要時只記「已驗證某 secret 存在」而非值。目錄限制權限（例如 0700），並明確定義加密、備份與刪除政策。
4. **不可信專案**：project-originated memory 不應在 untrusted project 中自動讀取或注入；memory 本身是資料，不是 instructions。對 prompt injection、惡意「請記住」內容與工具輸出做內容與來源分離。
5. **跨任務污染**：每筆記錄帶 branch／commit／dependency version／task scope；變更環境時要求重新驗證。檢索結果顯示 provenance、時間與 confidence；衝突時 fail closed，不選「最相似」者。
6. **使用者控制**：提供列出、搜尋、撤銷、刪除、匯出與 retention 設定；刪除應產生稽核 tombstone，並從 materialized index 與後續注入移除。對高敏感記憶設定短 expiry 或完全禁止自動 promotion。
7. **現有 runtime 風險**：目前 shared cwd 且沒有 filesystem sandbox；因此不可把「member 目錄」誤當安全邊界。若要防惡意或誤寫，必須另有 OS sandbox、權限隔離或受控 memory service。

## 7. 測試與評估

### 功能與正確性

- append-only hash chain、版本與合法狀態轉移；並發寫入、截斷 JSONL、重建 index、崩潰恢復。
- scope/property tests：member A 的記憶永不出現在 B；project X 永不注入 project Y；刪除後不再檢索。
- provenance completeness：每個 active L2/L3 都可回到 L1 event、session ref 與驗證結果。
- contradiction fixtures：新版本、環境變更、refuted memory 都必須被標示而非靜默覆蓋。

### 學習效益

用固定、未見過的 holdout 任務做 memory-off／memory-on A/B，並區分第一次嘗試與 repeated task：

- **retrieval precision@k / recall**：注入的記憶是否相關且漏掉關鍵記憶的比例。
- **utility uplift**：成功率、工具重試數、完成時間、錯誤率相對 baseline 的改變。
- **learning curve**：同類任務隨 review／使用次數改善的速度；避免把單次運氣算成學習。
- **staleness / refutation rate**：被環境變更或驗證推翻的 active 記憶比例。
- **false-memory rate**：記憶宣稱的結論與外部 ground truth 不一致的比例。
- **calibration**：confidence 與 correctness 的 reliability diagram、Brier score／ECE；信心高但錯的條目要降級。
- **consolidation quality**：摘要相對原事件的事實保真度、泛化範圍、反例遺失率。

### 成本與安全

- 每 run 的注入 token、搜尋 latency、磁碟成長與 consolidation CPU；設硬上限。
- cross-member leak rate、secret／PII leak rate、prompt-injection acceptance rate、刪除合規率。
- adversarial tests：惡意工具輸出「請永久記住」、相似但不同專案、peer 私訊、過期依賴與錯誤的高信心摘要。
- 以 blinded evaluator 檢查：member 是否引用 evidence、是否在未知時表示 unknown、是否把記憶當指令執行。

## 8. 建議的最小可行落地順序

1. 先做每 member 的 L1 append-only event ledger、scope／provenance／secret redaction 與 manual search；不做自動 promotion。
2. 加 candidate/active/superseded/expired lifecycle、validator、衝突檢查與 bounded L2/L3 materialization。
3. 加 run 開始的 top-k retrieval、retrieval-practice prompt、結果回饋與 calibration 指標。
4. 最後才加入 idle consolidation、spacing scheduler、向量索引和跨任務的明確共享；任何「全域記憶」都必須經 user／trusted evaluator approval。

## 9. 完整來源清單

以下優先選原始研究、學術期刊論文或學術機構／標準文件；綜述與 meta-analysis 用來界定研究共識時明確標示。

1. Baddeley, A. D. (2000). “The episodic buffer: a new component of working memory?” _Trends in Cognitive Sciences_, 4(11), 417–423. DOI: https://doi.org/10.1016/S1364-6613(00)01538-2
2. Tulving, E. (1989). “Memory: Performance, knowledge, and experience.” _European Journal of Cognitive Psychology_, 1(1), 3–26. DOI: https://doi.org/10.1080/09541448908403069
3. Squire, L. R., & Zola, S. M. (1996). “Structure and function of declarative and nondeclarative memory systems.” _Proceedings of the National Academy of Sciences_, 93(24), 13515–13522. DOI: https://doi.org/10.1073/pnas.93.24.13515
4. Cohen, N. J., & Squire, L. R. (1980). “Preserved learning and retention of pattern-analyzing skill in amnesia: dissociation of knowing how and knowing that.” _Journal of Experimental Psychology: Human Learning and Memory_, 6(6), 558–570. DOI: https://doi.org/10.1037/0278-7393.6.6.558
5. Squire, L. R., Stark, C. E. L., & Clark, R. E. (2004). “The medial temporal lobe.” _Annual Review of Neuroscience_, 27, 279–306. DOI: https://doi.org/10.1146/annurev.neuro.27.070203.144130
6. McGaugh, J. L. (2000). “Memory—a century of consolidation.” _Science_, 287(5451), 248–251. DOI: https://doi.org/10.1126/science.287.5451.248
7. Rasch, B., & Born, J. (2013). “About sleep’s role in memory.” _Physiological Reviews_, 93(2), 681–766. DOI: https://doi.org/10.1152/physrev.00032.2012
8. Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). “Distributed practice in verbal recall tasks: a review and quantitative synthesis.” _Psychological Bulletin_, 132(3), 354–380. DOI: https://doi.org/10.1037/0033-2909.132.3.354
9. Roediger, H. L., III, & Karpicke, J. D. (2006). “Test-enhanced learning: taking memory tests improves long-term retention.” _Psychological Science_, 17(3), 249–255. DOI: https://doi.org/10.1111/j.1467-9280.2006.01693.x
10. Butler, A. C., & Roediger, H. L., III (2008). “Feedback enhances the positive effects and reduces the negative effects of multiple-choice testing.” _Journal of Experimental Psychology: Learning, Memory, and Cognition_, 34(4), 774–787. DOI: https://doi.org/10.1037/0278-7393.34.4.774
11. Wixted, J. T. (2004). “The psychology and neuroscience of forgetting.” _Annual Review of Psychology_, 55, 235–269. DOI: https://doi.org/10.1146/annurev.psych.55.090902.141555
12. Loftus, E. F., & Palmer, J. C. (1974). “Reconstruction of automobile destruction: an example of the interaction between language and memory.” _Journal of Verbal Learning and Verbal Behavior_, 13(5), 585–589. DOI: https://doi.org/10.1016/S0022-5371(74)80011-3
13. Roediger, H. L., III, & McDermott, K. B. (1995). “Creating false memories: remembering words not presented in lists.” _Journal of Experimental Psychology: Learning, Memory, and Cognition_, 21(4), 803–814. DOI: https://doi.org/10.1037/0278-7393.21.4.803
14. Nelson, T. O., & Narens, L. (1990). “Metamemory: a theoretical framework and new findings.” _The Psychology of Learning and Motivation_, 26, 125–173. DOI: https://doi.org/10.1016/S0079-7421(08)60053-5
15. Di Stefano, G., Gino, F., Pisano, G. P., & Staats, B. R. (2015). “Learning by thinking: how reflection aids performance.” _Academy of Management Journal_, 58(4), 1059–1083. DOI: https://doi.org/10.5465/amj.2013.0161
16. Anderson, J. R., & Schooler, L. J. (1991). “Reflections of the environment in memory.” _Psychological Science_, 2(6), 396–408. DOI: https://doi.org/10.1111/j.1467-9280.1991.tb00174.x
17. National Institute of Standards and Technology (NIST). (2020). _NIST Privacy Framework: A Tool for Improving Privacy through Enterprise Risk Management, Version 1.0_. 官方文件：https://www.nist.gov/privacy-framework
18. National Institute of Standards and Technology (NIST). (2023). _Artificial Intelligence Risk Management Framework (AI RMF 1.0)_. NIST AI 100-1. DOI: https://doi.org/10.6028/NIST.AI.100-1

## 10. Repo 相關參考

- `packages/pi-agent-team/README.md`：member session 持久化、team settlement、shared cwd 與非 sandbox 限制。
- `packages/pi-agent-team/CONTEXT.md`：Principal、Channel、Envelope、Claim 等協作語彙與隱私規則。
- `packages/pi-agent-team/src/domain.ts`、`src/runtime.ts`：現有 member、message、audit event、session 與 runtime 結果模型。
- `packages/pi-memory/README.md`：另一 package 已採 candidate → active、provenance、expiry、append-only JSONL、untrusted project 不注入等可借鑑的工程模式；本研究沒有修改該 package。
