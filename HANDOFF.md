# CodeVia Project Handoff
> آخرین بروزرسانی: 2026-09-09 (۱۴۰۸/۰۶/۱۹ — نسخه ۵)
> این فایل برای جلوگیری از خواندن کل کد در هر جلسه است. همیشه قبل از شروع کار این فایل را بخوانید.

## معماری کلی پروژه

CodeVia یک پلتفرم AI Engineering با معماری زیر است:
- **Backend**: Fastify (Node.js/TypeScript) در `src/`
- **Frontend**: SPA وانیلی JS در `public/app.js` + `public/app.css` + `public/index.html` (بدون فریم‌ورک)
- **دیتابیس**: SQLite (در مموری / ذخیره در فایل)
- **وظیفه اصلی**: مدیریت چندین پروژه گیتهاب، چندین ایجنت AI، چندین مدل/پراوایدر، اجرای خودکار تسک‌ها، یکپارچگی تلگرام، ذخیره حافظه، تایید مراحل حساس، و **مسیریابی هوشمند مدل بر اساس بنچمارک واقعی ریاضی**.

---

## ویژگی جدید: Smart Model Routing با Math Benchmark (v3)

سیستم جدید به جای انتخاب دستی یا ترتیب استاتیک priority، از **داده‌های عملکرد واقعی** هر مدل استفاده می‌کنه:

### طرز کار:
1. **MathBenchmarkService** بصورت تصادفی ۵ نوع سوال ریاضی می‌سازه (جمع/ضرب/منها، ترتیب عملیات، جبر، کسر، مسئله کلمه‌ای) و با temperature=0 از همه مدل‌های فعال می‌پرسه.
2. جواب‌ها parse میشن، با پاسخ صحیح مقایسه میشن (همراه tolerance برای اعشار)، و نتیجه ذخیره میشه:
   - آیا جواب عددی بود (answered)?
   - درست بود (correct)?
   - چقدر طول کشید (latencyMs)?
   - چقدر هزینه داشت (costUsd)?
   - چند توکن مصرف کرد (totalTokens)?
   - اگه خطا داد (error)?
3. **ModelPerformanceStats** از همه این داده‌ها aggregate میشه:
   - `accuracy` = correct / successful
   - `errorRate` = errors / attempts
   - `avgLatencyMs`, `p95LatencyMs`
   - `score` ترکیبی: **60% accuracy + 20% reliability (1 - errorRate) + 20% speed**
4. **ModelRouter** هنگام انتخاب مدل:
   - ابتدا `allowedModels` آن ایجنت رو اعمال می‌کنه (allow-list)
   - بعد capability/budget filtering
   - بعد ترتیب primary/secondary/fallbacks کاربر حفظ میشه
   - **fallback های باقی‌مانده بر اساس score مرتب میشن — بهترین مدل اول**
   - مدل‌هایی که نرخ خطای بالایی دارن 0.3 امتیاز جریمه می‌خورن
5. اگر پراوایدر واقعی در حال کار باشه، Mock ها دقت ۰٪ می‌گیرن و در رتبه پایین میفتن (تا کاربر روی مدل واقعی بنچمارک نکنه نمیاد بالا).

### فایل‌های جدید:
| فایل | کار |
|---|---|
| `src/observability/model-bench-repo.ts` | ModelBenchmarkRepository (ذخیره/خواندن نتایج + computeStats) |
| `src/ai/math-benchmark.ts` | MathBenchmarkService (تولید سوال تصادفی + quiz از مدل‌ها + امتیازدهی) |
| `src/http/routes/model-bench.ts` | API endpoints: POST `/models/benchmark/run`, GET `/models/benchmark/stats`, GET `/models/benchmark/results` |

### فایل‌های تغییر یافته:
- `src/domain/entities.ts`: اضافه شدن `ModelBenchmarkResult`, `ModelPerformanceStats`, `MathBenchmarkProblem`, فیلد `allowedModels?: ID[]` به `AgentModelConfig`
- `src/ai/model-router.ts`: بازنویسی route() برای استفاده از perfScore و اعمال allowedModels؛ fallback ها بر اساس score مرتب میشن
- `src/ai/text-service.ts`: benchRepo به deps اضافه شد تا stats رو از repo بخونه و به router پاس بده
- `src/agents/llm.ts`: از singleton getModelBenchmarkRepo() استفاده می‌کنه تا perfStats رو به router پاس بده
- `src/app/container.ts`: ساخت mathBench, benchRepo و پاس دادن به aiText
- `src/http/routes/agents.ts`: Zod schema برای allowedModels آپدیت شد
- `src/http/app.ts`: registerModelBenchRoutes اضافه شد
- `public/app.js`: بخش "🧪 Smart routing benchmark" در صفحه Models با دکمه Run و جدول رتبه‌بندی امتیاز/دقت/تاخیر/هزینه؛ چک‌باکس allowedModels در Agent Builder

### API endpoints:
| Method | Route | کار |
|---|---|---|
| POST | `/models/benchmark/run` | اجرای بنچمارک (problemsPerModel پیش‌فرض ۸، همه مدل‌های فعال) |
| GET | `/models/benchmark/stats` | گرفتن stats مرتب شده بر اساس score (برای router و UI) |
| GET | `/models/benchmark/results` | گرفتن نتایج خام آخرین runها |

### UI:
- **صفحه Models**: دکمه `🧪 Benchmark all models` + کارت نتایج با جدول rank/model/score/accuracy/latency/p95/error rate/cost/attempts/last tested. حین اجرا toast میده و بعد از اتمام جدول live آپدیت میشه.
- **Agent Builder (صفحه /agents/:id)**: فیلد جدید "Allowed models" به صورت چک‌باکس‌هایی از همه مدل‌های فعال. اگر چند مدل انتخاب کنید، آن ایجنت فقط از اونها استفاده می‌کنه و سیستم خودش بهترینش رو انتخاب می‌کنه. راهنمای "Run benchmark first" هم داخلش هست.

### نکته مهم در مورد Mock:
در حالت development، پراوایدر mock جواب‌های `[Mock ...]` تولید می‌کنه که شامل عدد نیست — پس دقت ۰٪ می‌گیره و score همه مدل‌ها 0.200 میشه. این طبیعی و هدفمند است:
- در این حالت fallback ordering بر اساس priority استاتیک کار می‌کنه
- وقتی یک پراوایدر واقعی (OpenAI/Anthropic/Gemini) با کلید معتبر اضافه کنید و بنچمارک را اجرا کنید، مدل‌های واقعی جواب عددی صحیح میدن، دقت بالا می‌گیرن و بطور خودکار به صدر لیست میرن.
- مدل‌هایی که در حین کار خطا میدن (rate limit / timeout / HTTP error) نیز به مرور error rate بالایی می‌گیرن و از مسیر حذف میشن.

---

## ساختار پوشه‌های اصلی

| پوشه | محتوا |
|---|---|
| `src/http/` | سرور HTTP + تمام روت‌های REST API در `src/http/routes/` |
| `src/http/routes/` | روت‌های اصلی API: projects, agents, conversations, tasks-runs, models-providers, **model-bench**, telegram, ... |
| `src/agents/` | منطق ایجنت‌ها: manager, orchestrator, router, generator, implementation, runner, plan, **llm (از perf stats برای routing استفاده می‌کنه)** |
| `src/ai/` | لایه AI: provider-registry, text-service (همراه با بنچمارک)، model-stream, **model-router (با smart routing)**, **math-benchmark**, anthropic/gemini/http providers |
| `src/integrations/` | تلگرام |
| `src/github/` | سرویس گیتهاب (real/mock) |
| `src/domain/` | موجودیت‌ها: Project, Task, Run, Agent, Conversation, Memory, **ModelBenchmarkResult, ModelPerformanceStats** |
| `src/workers/` | ورکر پس‌زمینه |
| `src/workflow/` | موتور گردش‌کار |
| `src/skills/` | سیستم اسکیل‌ها |
| `src/tools/` | ابزارهای در دسترس ایجنت‌ها |
| `src/approvals/` | سرویس تایید انسانی |
| `src/memory/` | سیستم حافظه چندسطحی |
| `src/observability/` | repos (RunRepo, CostRepo, AuditRepo, NotificationRepo, **ModelBenchmarkRepository**) |
| `public/` | SPA فرانت‌اند |

---

## جریان درخواست AI به پروژه

### از وب UI (Ask AI):
1. کاربر درخواست را در مودال Ask AI وارد می‌کند
2. POST `/projects/:id/ask` با `executionMode: "autonomous"|"agent"|"workflow"|"simulation"`
3. در autonomous mode: `agentType: undefined` تا اورکستراتور کار کنه
4. اورکستراتور کل pipeline را مدیریت می‌کند: research → specialist implementer → QA → PR
5. **در هر مرحله از modelRouter.route() استفاده میشه که الان با smart routing بهترین مدل رو برای آن دسته کار (coding/research/fast) انتخاب می‌کنه**

### گفتگوها (Conversations):
- صفحه full-page چت در `#/conversations/:id` با حباب‌های RTL/LTR خودکار
- POST `/conversations/:id/messages` → aiText.complete با system prompt پروژه + آخرین ۵۰ پیام + summary
- aiText از modelRouter با perf stats استفاده می‌کنه
- پاسخ AI به عنوان assistant ذخیره میشه، بعد از ۲۰ پیام auto-summarize

### از تلگرام:
- `handleNaturalLanguage` تسک autonomous می‌سازد با agentType: undefined

### انتخاب مدل (مسیریابی):
1. اگر ایجنت `allowedModels` غیرخالی داشته باشد → فقط آن مدل‌ها کاندیدا هستند
2. capability filtering (tools/vision/reasoning/code)، context size و budget
3. primary/secondary/fallbacks کاربر به ترتیب قرار می‌گیرند
4. بقیه مدل‌های واجد شرایط بر اساس composite score (accuracy/speed/reliability) مرتب میشن
5. در صورت خطا به fallback بعدی سوئیچ میشه
6. **تاریخچه خطاها و پاسخ‌های نادرست روی امتیاز مدل تاثیر داره تا دفعه بعد به مدل unreliable کمتر درخواست داده بشه**

---

## انواع ایجنت‌ها و IMPLEMENTERS

IMPLEMENTERS (کسانی که می‌توانند کد بنویسند) در `src/agents/implementation.ts`:
```typescript
["backend-developer", "frontend-developer", "database", "uiux", "documentation", "refactoring", "performance"]
```
ایجنت‌های غیرپیاده‌ساز (فقط executionMode="agent"):
`orchestrator, project-manager, research, business-analyst, system-architect, qa-test, security, code-reviewer, debugging, release`

**قانون طلایی**: وقتی executionMode === "autonomous"، `task.agentType` باید `undefined` باشد.

---

## اجرای پروژه

```bash
npm install
npm run dev       # توسعه روی پورت 8080
npm run build     # بیلد production
npm start         # اجرای production از dist/
npm test          # اجرای تست‌ها
npm run typecheck # بررسی تایپ‌ها
```

### محیط:
- پیش‌فرض MockGitHubService, MockTelegramService, provider-mock
- پراوایدر mock پاسخ‌های `[Mock ...]` میده — برای دیدن دقت واقعی مدل‌ها، یک پراوایدر واقعی اضافه کنید (OpenAI/Anthropic/Gemini) و از صفحه Models روی 🧪 Benchmark all models کلیک کنید
- بعد از بنچمارک، مسیریاب خودش بهترین مدل رو بر اساس داده‌های واقعی انتخاب می‌کنه

---

## مهم‌ترین مسیرهای API

| Method | Route | کار |
|---|---|---|
| POST | `/projects/:id/ask` | درخواست اصلی از AI |
| POST | `/projects/:id/dry-run` | پیش‌نمایش بدون تغییر |
| POST | `/conversations/:id/messages` | ارسال پیام + پاسخ خودکار AI |
| **POST** | **`/models/benchmark/run`** | **اجرای بنچمارک ریاضی از همه مدل‌ها** |
| **GET** | **`/models/benchmark/stats`** | **آمار عملکرد هر مدل (score/accuracy/latency/errors)** |
| GET | `/models/benchmark/results` | نتایج خام بنچمارک |
| PATCH | `/agents/:id` | آپدیت ایجنت (شامل allowedModels) |

---

## نکات مهم برای تغییرات بعدی:

1. **Autonomous mode**: هرگز `agentType` ثابت ندهید.
2. **اضافه کردن قابلیت جدید به router**: اگر metric جدیدی برای مدل‌ها می‌خواهید (مثلاً کیفیت کد، مصرف توکن)، در ModelBenchmarkRepository.computeStats اضافه کنید و score weighting رو تنظیم کنید.
3. **گسترش سوالات بنچمارک**: می‌تونید مدل‌های جدید سوال (مانند logic puzzle، unicode/RTL تست، JSON output) به MathBenchmarkService.addProblemCategory اضافه کنید — framework مشابه هست.
4. **همیشه route مربوطه رو در app.js اضافه کنید** وقتی لینک جدیدی در HTML می‌سازید.
5. **برای فارسی/RTL**: از `dirForText(text)` و `dir="auto"` استفاده کنید.
6. **HANDOFF.md**: بعد از هر تغییر مهم آپدیت کنید.

---

## وضعیت فعلی

✅ تایپ‌چک: 0 error
✅ Dev server: پورت 8080 (mock mode)
✅ Ask AI autonomous با smart routing: research → backend → QA → PR
✅ Conversations: صفحه full-page چت با حباب RTL/LTR
✅ Math Benchmark: تولید سوال تصادفی، quiz از همه مدل‌ها، محاسبه score، ذخیره در DB
✅ Smart router: بهترین مدل را بر اساس accuracy/speed/reliability انتخاب می‌کند
✅ allowedModels per agent: می‌توانید هر ایجنت را محدود به چند مدل خاص کنید
✅ UI: جدول امتیاز مدل‌ها + دکمه Run benchmark + چک‌باکس allowed models در Agent Builder
✅ API endpoints برای بنچمارک فعال هستند

---

## تاریخچه تغییرات

### ۱۴۰۸/۰۶/۱۹ (2026-09-09) نسخه ۳ — Smart Model Routing
- **اضافه شد**: `ModelBenchmarkRepository` و `MathBenchmarkService`
- **اضافه شد**: API endpoints `/models/benchmark/run|stats|results`
- **اضافه شد**: composite score (60% accuracy · 20% reliability · 20% speed) و p95 latency
- **بازنویسی شد**: `ModelRouter.route()` برای استفاده از perfScore و allowedModels
- **اضافه شد**: فیلد `allowedModels` به AgentModelConfig با UI در Agent Builder
- **اضافه شد**: پنل بنچمارک در صفحه Models با دکمه اجرا و جدول رتبه‌بندی
- **پاس‌دهی شد**: benchRepo به text-service و llm

### نسخه ۲
- صفحه full-page چت برای گفتگوها
- حباب‌های پیام با RTL/LTR خودکار
- ستون Actions در لیست گفتگوها

### نسخه ۱
- رفع باگ اصلی `/projects/:id/ask`
- رفع باگ گفتگوها (aiText.complete)
- رفع باگ تلگرام
- ایجاد HANDOFF.md

---

## v4 — Project page redesign (Chat / Project / Settings)

**Date:** 2026-09-09
**Status:** Delivered + smoke-tested

### Goal (from user, Persian)
صفحه اول پروژه فقط سه تب داشته باشد:
- **💬 Chat** — چت عادی با انتخاب مدل، آپلود فایل (تصویر برای مدل‌های vision)، تنظیمات دما، و انتخاب نوع/حالت اجرا (Chat/Autonomous/Agent/Simulation).
- **📁 Project** — خلاصه پروژه، آمار، درخواست سریع از AI، فید فعالیت‌ها، اجراها/تسک‌های اخیر، خطاها.
- **⚙️ Settings** — همه بخش‌های مدیریتی (Agents, Skills, Memory, Repos, Workflows, Tasks, Runs, Tests, Issues, PRs, Commits, Conversations, Rules, Telegram, Pull, Re-onboard, Export, Danger zone).

Deep link ها به URL های قدیمی (مثل `#/projects/:id/tasks`) باید کار کنند و Settings رو به عنوان تب فعال نشون بدن.

### Backend changes

1. **`src/domain/entities.ts`**
   - `ConversationAttachment` interface: `{name, contentType, size, dataUrl?, preview?}`.
   - `ConversationMessage.metadata` now typed with optional `attachments`, `modelId`, `executionMode`, `dispatchedTaskId`, `temperature`, `agentType`, `simulationPlan`.

2. **`src/domain/repos.ts`** — Added `ConversationRepository.updateModel(convId, modelId)` (updates document and projectId/userId indexes).

3. **`src/http/routes/project-ask-shared.ts`** *(new)*
   - Single shared dispatch entry point `dispatchProjectAsk(container, projectId, {title, description, executionMode, agentType, workflowId, correlationId})`.
   - Returns `AskResult | AskError`; guarded with `isAskError()`.
   - Encapsulates: validation, agent-router scoring for mode=autonomous, workflowId regex selection, simulation plan build via `defaultPlanFor()`, task creation + `queue.enqueue("agent.run", …)`.
   - Contains the **autonomous → IMPLEMENTERS only** guard so the bug class can't resurface between the REST endpoint and in-chat dispatch.

4. **`src/http/routes/projects.ts`** — `POST /projects/:id/ask` now delegates to `dispatchProjectAsk` (removed ~40 lines of duplicated routing/queue logic).

5. **`src/http/routes/conversations.ts`** — `POST /conversations/:id/messages` accepts new fields:
   - `modelId`, `executionMode` ("chat"|"autonomous"|"agent"|"simulation"), `agentType`, `temperature`, `attachments[]`.
   - `mode === "chat"`: builds a prompt that includes attachment previews and data URLs, calls the AI with the overridden model/temperature, stores response with metadata.
   - `mode !== "chat"`: dispatches via `dispatchProjectAsk`. For "simulation" returns a numbered step plan with 🛑 markers on approval steps. For "autonomous"/"agent" returns a status message with short task id hash + runs link.
   - Typechecks clean: `npx tsc -p tsconfig.json --noEmit` → 0 errors.

### Frontend changes (`public/app.js`)

- `PROJECT_SECTIONS` collapsed to 3 entries: chat/project/settings.
- `projectSectionNav(id, active)` now normalises legacy keys (agents/tasks/runs/...) to "settings" and "overview" to "chat" so deep links keep working.
- New helpers:
  - `getProjectChatConv(projectId)` — GETs or POSTs a per-project "Project Chat" conversation.
  - `readFileAsAttachment(file)` — FileReader→dataURL; files >1MB get metadata-only preview (no inline data) to avoid blowing up context.
  - `projectChatTabHtml(conv)` — full-page chat UI with message area, attachment chips, textarea, model selector (populated from `/models` with benchmark score + latency), mode segmented select (Chat/🚀 Autonomous/▶ Agent/🧪 Dry-run), agent select (shown only when mode=agent), temperature input.
  - `mountProjectChat(projectId, convId)` — wires up send/attach/remove/Enter-to-send, calls POST `/conversations/:id/messages` with the right payload, refreshes messages.
  - `projectInfoTabHtml(p, stats)` — 2-column grid: overview+quick actions; stats+recent activity; recent runs; recent errors.
  - `projectSettingsTabHtml(p)` — link grid to all admin pages (Agents/Skills/Memory/Repos/...) + action buttons (Rules/Telegram/Pull/Re-onboard/Export) + danger zone.
- Route `/projects/:id` now renders 3 tabs; default is Chat; legacy sub-paths auto-activate Settings tab.
- JS syntax verified (`node -e "new Function(...)"` → OK).

### Smoke test (live server, port 8080)

Using mock providers:
- `POST /projects` → created `proj-a964352c`.
- `POST /conversations {projectId, title:"Project Chat"}` → `19aa87ae-c6fb-4bda-8c5b-6ca09081ed08`.
- `POST /conversations/:id/messages {mode:"chat", modelId:"mock-fast"}` → mock assistant reply returned with `metadata.modelId` and `executionMode:"chat"`.
- `POST /conversations/:id/messages {mode:"simulation"}` → returned 9-step simulation plan (incl. 🛑 on PR creation) with full `simulationPlan` array in metadata.
- `POST /conversations/:id/messages {mode:"autonomous"}` → queued task `task-32927356`; status message with `[Open runs →]` link; metadata.dispatchedTaskId populated.
- All HTTP endpoints return 200: `/projects/:id`, `/projects/:id/agents`, `/conversations/:id`, `/models/benchmark/stats`.

### Live preview
Dev server running at http://0.0.0.0:8080 (process `codevia-2c4e7edd`). Visit `#/projects/proj-a964352c` to see the new 3-tab layout.

### Known limitations / future work
- Attachments are inlined as data URLs (<1MB) and appended as JSON metadata; no server-side multipart upload endpoint yet.
- Chat messages don't yet stream; they complete in one round trip (same as pre-existing conversation page).
- The "Project" tab is a curated compact view; the deeper sections (full Agents/Skills/...) are now under Settings and continue to use their existing renderers unchanged.

---

## v5 — Deep autonomous-loop hardening (Research→Implement→QA→Research→Fix)

**Date:** 2026-09-09
**Status:** Delivered + smoke-tested

### Goal (from user)
چرخه درخواست پروژه باید دقیقاً به این شکل باشد:
1. ایجنت **Research** اول پروژه را از گیت‌هاب اسکن کند و محتوای پروژه را در حافظه بیاورد.
2. Research تشخیص بدهد کدام بخش‌ها کامل هستند و کدام نیستند، کارها را به‌صورت تسک‌های تخصصی بشکند.
3. تسک‌ها به ایجنت‌های مربوطه (backend, frontend, uiux, database, …) سپرده شوند.
4. هر ایجنت تسک خود را انجام دهد و کد را کامل کند.
5. بعد از اتمام همه، به ایجنت **QA/Test** ارسال شود.
6. اگه QA خطا پیدا کرد، **دوباره به Research** برگرده (نه مستقیم به همان implementer) تا علت اصلی را تشخیص دهد و به ایجنت مناسب ارجاع دهد.
7. این حلقه تا پاس شدن کامل QA ادامه داشته باشد.
8. در نهایت QA کد را pull کند (PR به صورت draft ساخته شود؛ merge خودکار نیست).

### Changes made

#### 1. Backend: context pre-warm before research (`src/agents/orchestrator.ts`)
- Before building the context pack (which lists files + reads configs + registry), the orchestrator now calls `files.restore(project, …, { includeTasks: false })` so the persisted `CodeVia/` folder (agents, memory, skills, entity registry, rules) is synced from GitHub to local cache **before** research starts. On repeat runs this means research sees the warm registry from prior runs, not an empty slate.

#### 2. Backend: settings-driven loop (`src/domain/entities.ts` + UI)
Added three new project settings (all persisted to the project document and the GitHub `CodeVia/project.md` manifest):
- `maxFixLoops: number` — how many QA↔Fix cycles before giving up (default **2**, clamp 0–6).
- `researchBeforeFix: boolean` — when QA fails, route through a diagnostic Research pass before assigning a fix agent (default **true**, recommended).
- `cacheContextInMemory: boolean` — hydrate cached project state from Git before scanning (default **true**).

Project Settings editor (Operations tab) exposes all three fields. PATCH `/projects/:id` persists them round-trip through the state codec (see fix #4).

#### 3. Backend: QA-failure → Research diagnosis loop (`src/agents/orchestrator.ts`)
The fix loop (after QA failure) was previously:
```
router.route(error) → same implementer → fix
```
Now when `researchBeforeFix` is ON **and** a real AI provider is configured:
1. A child task `Diagnose failure (attempt N): <title>` is spawned on the **research** agent, with:
   - The full QA failure text
   - The list of repos/branches/files under test
   - The original research brief
2. The research agent's `preparePlan` calls the LLM with a diagnosis prompt: *"identify which agent/unit must fix what, root cause, concrete recommendation."*
3. The diagnosis is appended to the brief (so implementers get more context) and persisted to project memory as a `bug` entry with key `qa-failure/<taskId>/attempt-N` (used by future runs as context).
4. Routing uses `failure + diagnosis` (not just `failure`) to pick the correct agent, with an implementer-filter so non-implementer suggestions (like `uiux`) get mapped to the actual writer (`frontend-developer`).
5. Only then is the fix task dispatched.
6. After the fix, control returns to QA; the loop repeats up to `maxFixLoops` times.

When no real AI is available (mock mode) or `researchBeforeFix` is OFF, the original deterministic routing is preserved so the mock path never deadlocks.

#### 4. Backend: state codec passthrough for new settings (`src/github/project-state.ts`)
`definitionSchema` (the Zod schema that parses `CodeVia/project.md` on every pull/restore) was a strict `z.object({…})` without `.passthrough()`, so **any unknown field added to settings got silently stripped on the next restore/sync** — which is why v4's `maxFixLoops` etc. weren't persisting across the write→restore cycle. Fixed by:
- Adding `maxFixLoops`, `researchBeforeFix`, `cacheContextInMemory` as optional typed fields to `definitionSchema.settings`.
- Adding `.passthrough()` on both `settings` and the top-level `definitionSchema`, so any future unknown fields round-trip instead of being dropped.

#### 5. Frontend: live progress in the Project Chat tab (`public/app.js`)
`mountProjectChat()` now:
- Tracks `dispatchedTaskId`s from sent messages.
- Every 3 s while any dispatched task is still `created|queued|running`, polls `/tasks/:id` and refreshes the message list (so new runs/steps/memory syncs that produce assistant messages appear live).
- Appends a centered chip when a task finishes: ✅ task XXXX completed · View runs → (or ⚠️ on failure/cancel).
- Hooks into the existing `socket.io` channel for immediate nudges (`task.updated`, `run.updated`), so polling starts instantly instead of waiting 3 s.
- Send button is now a circular `↑` (mobile friendly) instead of the text "Send ↵".
- Attachments render as inline images (vision content) or file chips inside `msgBubble`, plus model/mode/task-id meta chips under each bubble.

#### 6. UI/CSS: mobile (`public/app.css`)
- New `.p-chat-*` classes replace inline styles for the chat tab.
- Media query `@media (max-width: 640px)` reduces heights/paddings/font-sizes on phones, wraps control rows, shrinks bubbles to 88% width.
- `:hover` transform on list-rows disabled on touch devices (`@media (hover:none)`).

### End-to-end smoke test (server port 8080, mock providers)

1. **PATCH settings** round-trip verified:
   - `maxFixLoops=3, researchBeforeFix=false, cacheContextInMemory=true` → saved, re-fetched, persisted across the restore/sync cycle (no more silent stripping).
2. **Autonomous end-to-end** on `proj-a964352c` ("Add a login page with UI and backend auth endpoint"):
   - 9 tasks created total:
     - Parent task (user request) → **Research** → **Implement (backend)** → **Implement (frontend)** → **PR open** → **Verify (QA)** → **all succeeded**.
   - Backend wrote `src/routes/readme.routes.ts` + a task note, frontend was selected because the prompt contained "UI", PR #2 opened on mock GitHub, QA inspected files + ran tests + saved evidence → all green in <3 s.
   - Dispatch message in chat + conversation metadata correctly recorded `dispatchedTaskId`, `executionMode:"autonomous"`, `modelId`.
3. Type check: `tsc --noEmit` → 0 errors.
4. JS syntax: `new Function(app.js)` → OK.
5. All 15 project HTTP endpoints return 200.

### Live preview
Dev server running at http://0.0.0.0:8080 (process `codevia-9288abe8`). Visit `#/projects/proj-a964352c` — Chat tab shows live progress when a task is dispatched.

### Remaining notes
- When a **real** AI provider is connected (OpenAI/Anthropic/Gemini) and a real GitHub token is present, the research-diagnosis step actually calls the LLM with failure context and writes a proper root-cause analysis; with mock providers it falls back to deterministic routing so the platform stays runnable without credentials.
- PRs are opened as **drafts**; the platform never auto-merges. Human review is always required (matches the standing safety rule).
- Task progress chips in chat are best-effort (polling) — they don't stream token-by-token output yet; for that, the run console page (`#/runs/:id/console`) remains the detailed view.

### Post-deployment review (deep bug sweep)

After running full type check / JS parse / vitest, several issues were found and fixed:

1. **Incorrect pre-routing in `dispatchProjectAsk`** — when `executionMode="autonomous"` with no explicit `agentType`, the previous code called `agentRouter.route(...)` upfront and could land on non-implementers (`debugging`, `research`, `qa-test`), then passed that as `routedAgentType` to chat (while the orchestrator would override it later anyway, showing a misleading label). Fixed: autonomous mode now leaves `routedAgentType` undefined until the orchestrator's research phase decides the breakdown; single-agent mode still uses the router.
2. **Non-implementer fallback in fix loop** — the deterministic (no-real-AI) fix branch could pick `security`/`devops`/`release` from the router and try to spawn a child task on a non-implementer, which `assertWriter` would reject. Added the same `uiux→frontend` mapping + IMPLEMENTERS guard for that branch, defaulting to `backend-developer` when the router suggests a non-writer.
3. **Memory leak / stale listeners in Project Chat** — every time the Chat tab mounted, socket.io `on("task.updated")` listeners were added without being removed; navigating between projects/tabs would accumulate them and trigger refreshes against dead conversations. Added a cleanup registry (`_projectChatCleanup`) that `route()` calls on every navigation: clears `setTimeout` polling and detaches socket listeners.
4. **Settings-tab action buttons used arrow-function toString parsing** — `() => projectRules(p.id)` was rendered as `onclick="${fn.toString().split('(')[0]}(...)"`, which for arrow functions returns an empty string (the source is `() => projectRules(p.id)`, split on `(` gives `["", ") => projectRules..."]`, and `trim()` of the empty string is empty). Replaced with explicit handler-name strings.
5. **State codec silently dropped unknown settings fields** — `definitionSchema` in `project-state.ts` was a strict Zod schema; adding `maxFixLoops`/`researchBeforeFix`/`cacheContextInMemory` caused them to be stripped every time the project state was pulled from Git. Added the three fields to the schema and `.passthrough()` on both the settings object and the top-level definition so future fields round-trip safely.
6. **Deep link routing for new tab URLs** — the SPA router requires an exact segment count match. `/projects/:id` only matched 2-segment URLs, so `/projects/<id>/project` and `/projects/<id>/settings` fell through to the `/projects` list. Added an `onWithSub()` helper that registers both `/projects/:id` and `/projects/:id/:sub` to the same handler; the handler already reads `rest[1]` to pick the active tab, so this just makes the URLs reachable.
7. **Test expectation updated** — the "renders project detail tabs" test was written for 10 legacy tabs; updated to assert ≥3 (Chat/Project/Settings) and increased settle time so async chat mount finishes before assertions. Added an extra console.error dump in case a future route breaks again.

All checks now pass:
- `tsc --noEmit`: 0 errors.
- `new Function(app.js)`: JS parses clean.
- UI shell vitest suite: all 31 tests pass (previously 1 failed).
- Autonomous-loop, telegram, github-multi-user, provider-model, project-brief, approval, skill-assignment, repository-state test files: all pass when run individually (global 3-min timeout hits some heavy suites but per-file runs are green).
- Server live on port 8080, all project HTTP endpoints return 200 including the new `/project`, `/settings` sub-paths.

## 1405-06-19 — Hardening, Telegram scope-down, PWA
- Per-user isolation: conversations.ts now enforces conversation ownership via
  `loadAllowedConv()` and `userFor()` — a user can only list/read/append to
  conversations whose project they own (`canAccessProject`). Project-level
  isolation was already in place via `accessibleProjectIds` / `canAccessProject`
  in projects, agents, memory, and telegram handlers.
- Telegram scope reduction: telegram-bot.ts restricted to chat + project
  selection only. `/agents /models /skills /tasks /runs /status /tests /memory
  /review /dashboard /settings /run /task /approvals /logs /github` now reply
  with a "use the web UI" notice. Inline keyboard collapsed to Projects + Help +
  Self-check. Natural-language path no longer creates autonomous tasks; it
  returns an acknowledgement and points to the web UI for heavy workflows.
  Callback handlers for hidden sections now return a safe "not available on
  Telegram" view instead of hitting internal views.
- Telegram settings: removed the "chat ID" field from both the global bot
  connection modal and the project-level Telegram modal; only user ID + bot
  token (+ optional label) remain. Backend still accepts `chatId` (for pairing
  flows) but the UI never asks for it. Default destination when paired is the
  account owner's DM.
- PWA: added `public/manifest.json` (fa/rtl, standalone, dark background, SVG
  icon), `public/icon.svg`, `public/sw.js` (network-first navigation,
  cache-first static assets, offline shell fallback to /index.html).
  `public/index.html` now links manifest, apple-touch-icon, theme-color, and
  registers the service worker on load. Vazirmatn font added for Persian glyphs.
- TypeScript 0 errors, public/app.js parses, ui-shell 31/31 tests pass, dev
  server up on :8080 serving /manifest.json, /sw.js, /icon.svg (all 200).

## 1405-06-20 — Fix: chat send failed with "Cannot read properties of undefined (reading 'map')"
- **Symptom (user report, after updating):** the project Chat page loaded and
  showed the thread, but pressing send showed a red toast
  `Send failed · Cannot read properties of undefined (reading 'map')`.
- **Root cause:** `POST /conversations/:id/messages` read the project with
  `container.projectRepo.findById(...)` — the **raw** record — and built its
  system prompt with `project.repositories.map((r) => r.repo)`. Projects created
  before multi-repository support have `configRepo`/`branch` but **no
  `repositories` array**. Every list/detail endpoint (and the SPA) runs
  `hydrateProject()`, which rebuilds `repositories` from the connected repo, so
  the UI looked healthy while every send returned 500. Reproduced against a
  real-GitHub connection with a legacy project record.
- **Fix (`src/http/routes/conversations.ts`):** the route now hydrates the
  project exactly like `GET /projects` does (`hydrateProject`), so legacy
  records are normalised for the request; the prompt also guards with
  `(safeProject.repositories ?? [])`. `persist()` hydrates before the GitHub
  conversation sync for the same reason. Non-array `attachments` are now
  coerced (previously "…slice is not a function" → 500), and the
  summary helpers tolerate a missing `messages` array.
- **Same bug class hardened:**
  - `ProjectFilesService.seedMissingMockRepos` — `p.repositories.length` crashed
    Simulation/Mock installs with a 502 (`read/validation failed`); now falls
    back to the connected repository.
  - `projectDefinition()` (state-codec) never writes `repositories: undefined`
    into `CodeVia/project.md` — that produced a manifest that could never be
    parsed again.
  - `discoverProjectRules`, `ModelRouter.route`, `realChatFor` and
    `ProjectStateGenerator` tolerate partial legacy records (missing
    `models.fallbacks`, `models.specialized`, `capabilities`, `workflow.nodes`).
- **Observability:** Fastify runs with `logger: false`, so a 500 left no trace
  anywhere but the browser toast. `buildServer` now installs an `onError` hook
  that logs method, URL, status and the full stack for every 5xx (response
  shape is unchanged), so the next failure is diagnosable from the logs.
- **Tests:** new `src/tests/conversation-chat.test.ts` — legacy project without
  `repositories` sends successfully (was 500), non-array attachments do not 500,
  and the normal project + `executionMode: "agent"` dispatch still work.
  TypeScript 0 errors; the full suite's failing set is unchanged from the
  pre-change baseline (42 sandbox-only `database is not open` failures).

## 1405-06-20 — Fix: project Chat send used GITHUB_TOKEN instead of the owner's OAuth token
- **Symptom (user report):** after opening Chat from the home page (`#/chat`) as the
  GitHub user who owns the repo, sending a message failed (no in-page reply).
  The project/server token (`GITHUB_TOKEN` / OAuth-app credentials) was being
  used for GitHub; that token is login-only and 404s on the owner's private repos.
- **Root cause:** `POST /conversations/:id/messages` always `persist()` →
  `projectFiles.syncConversation` → `githubForProject(p)` **without**
  `requestUserId`. The project-state hook's `readProject` did the same. Project
  REST routes wrap with `bindProjectConnection` + `githubForProject(p, requestUserId)`;
  conversations did not. `adoptProjectConnection` also refused to replace a live
  `server-token` connection while `GITHUB_TOKEN` was set, so chat restore/persist
  kept the PAT. A GitHub 404 then 500'd the send *after* the AI reply was already
  in the DB (toast "Send failed", empty/error instead of the reply). Listing
  `/projects` restored every owned project the same way, so one 404 blanked Chat.
- **Fix:**
  - Request-scoped GitHub actor (`src/github/request-actor.ts` + `onRequest` in
    `app.ts`): a signed-in user with a stored OAuth token is the identity for
    every `githubForProject(project)` on that request, including chat persist.
  - `resolveGitHubForProject`: ALS `requestUserId`; a `server-token` project
    whose owner has an OAuth token uses that token, not `GITHUB_TOKEN`.
  - `adoptProjectConnection` / `adoptStrandedProjects`: rebind the owner's (or
    demo/shared) `server-token` projects onto their OAuth token; never steal
    another user's PAT project.
  - Conversation persist is best-effort (log, don't 500). Restore failures on
    conversation routes and GET listing no longer 500 the Chat page.
- **Tests:** conversation persist still returns the assistant reply when GitHub
  sync throws; logged-in owner + `server-token` project + live `GITHUB_TOKEN`
  sends with `tok-alice` (never the PAT) and rebinds the connection. Registry /
  adopt regressions updated.

## 1405-06-20 — Fix: Telegram project tap crashed with "Cannot read properties of undefined (reading 'map')"
- **Symptom (user report):** in the Telegram bot, tapping 📚 Projects then a
  project name replied:
  `⚠️ Something went wrong while handling that: Cannot read properties of undefined (reading 'map')`.
  `/start` still worked.
- **Root cause:** same legacy-document class as the chat-send bug above.
  `TelegramBot.ownedProject()` / `ownedProjects()` returned the **raw**
  `projectRepo` record. `projectHeader()` then did `p.repositories.map(...)`.
  Records written before multi-repository support have `configRepo`/`branch`
  but no `repositories` array. Web list/detail endpoints hydrate, so the SPA
  looked fine; the bot did not.
- **Fix (`src/integrations/telegram-bot.ts`):**
  - `ownedProjects()` / `ownedProject()` now run `hydrateProject()` (same as
    `GET /projects`).
  - `repoSummary()` / GitHub / issues / PRs views use `(p.repositories ?? [])`
    so a missed hydrate cannot throw.
  - Refreshing Git state before a view is best-effort: a single project's
    restore failure no longer takes down `/start` or project selection.
- **Test:** `opens a legacy project that has no repositories array` in
  `src/tests/telegram-bot.test.ts`. TypeScript 0 errors.
