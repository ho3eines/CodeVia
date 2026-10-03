# برنامهٔ عملیاتی CodeVia — گام ۰: ممیزی پایه

> **تاریخ:** 2026-09-29 · **شاخه:** `fix/step-0` · **دامنه:** فقط ممیزی و گزارش؛ **هیچ کدی تغییر نکرده است.**
> این سند مبنای گام‌های ۱ تا ۷ است: هر ردیف به گام پیشنهادی اشاره می‌کند و بعد از اجرای هر گام باید به‌روز شود.

---

## ۱. نتایج واقعی build و test

| فرمان | نتیجه | جزئیات | مدت |
|---|---|---|---|
| `npm ci` | ✅ موفق | نصب کامل وابستگی‌ها (Node v22.22.3، npm 10.9.8) | ~6s |
| `npm run check` | ✅ سبز | `typecheck` (0 خطا) + `lint` (eslint) + `check:app` (باندل `public/app.js` تازه است) | ~17s |
| `npm test` | ✅ سبز | **869 تست در 70 فایل — همه پاس** | 249s |
| `npm run smoke` | ✅ سبز | **33/33 چک** (چرخهٔ کامل autonomous، merge، restart، git history) | ~8s |

**اختلاف مستندات با واقعیت:** `README.md:72` می‌گوید **۷۴۴**، `HANDOFF.md:11` می‌گوید **۸۱۶**، واقعیت امروز **۸۱۹** است (گام ۷ باید هر دو را همگام کند).

---

## ۲. مسیر کامل «درخواست کاربر ← برنامه ← patch ← commit ← Draft PR ← CI ← merge-gate» در کد

### ۲.۱ درخواست کاربر
- `POST /projects/:id/ask` → `dispatchProjectAsk` در `src/http/routes/project-ask-shared.ts:104` (اعتبارسنجی، انتخاب حالت، ساخت تسک)؛ مسیر چت هم از همین در وارد می‌شود (`src/http/routes/conversations.ts`).
- **پیش‌بررسی دسترسی push** پیش از صف: `src/github/write-access.ts:48-125` (`checkProjectWriteAccess`) — بدون push → `403 {writeAccess}` یا `github_authorization_required`؛ کش ۶۰ ثانیه‌ای (`:41`) با `clearWriteAccessCache` (`:44`).
- صف: `queue.enqueue("agent.run", …)` در `project-ask-shared.ts:190-191` → تحویل اتمیک `UPDATE … RETURNING` → `Worker.process` در `src/workers/worker.ts:44`.

### ۲.۲ برنامه
- `src/agents/orchestrator.ts`: Research اول (`:395` `requireSuccess(researchRun, …)`) → تولید brief و breakdown → `parseBreakdown` (`src/agents/implementation.ts:118-157`) → `orderBreakdown` (`:160-192`) → ساخت زیرتسک‌ها با `acceptanceCriteria` (`orchestrator.ts:450-481`).
- سقف برنامه: `MAX_SUBTASKS = 12` و هر تسک ۱–۵ فایل (`implementation.ts:26,137`).

### ۲.۳ patch (ویرایش فایل موجود)
- `prepareImplementation` (`src/agents/implementation.ts:203-321`): فایل موجود با فراخوانی مدل خوانده می‌شود؛ پرامپت `:277` صریحاً `{"edits":[{"oldText",…}]}` می‌خواهد؛ اعمال با `applyFileEdits` در `:289` → تابع در `:82-98`.
- **نکتهٔ شکستنی:** `:92-94` فقط تطابق بایتیِ دقیقاً‑یک‌بار را می‌پذیرد؛ هیچ نرمال‌سازی EOL/BOM/whitespace، هیچ fallback نزدیک‌ترین ناحیه، هیچ unified diff و هیچ بازنویسی کامل فایل کوچک وجود ندارد. سقف فایل `MAX_FILE_CHARS = 200_000` (`:29`).

### ۲.۴ commit
- همهٔ فایل‌های یک زیرتسک در **یک commit اتمیک** با `expectedHead` (Snap-shot SHA شاخه) نوشته می‌شوند: پلن `write_file` در `implementation.ts:303-313`؛ پیاده‌سازی Git Data API در `src/github/real-service.ts`. تغییر SHA بعد از بازرسی commit را رد می‌کند.
- ابزارها: `read_file/write_file/create_branch/create_pull_request` با `assertWriter` (`implementation.ts:103-114`) — بدون مجوز، نه fallback به شاخهٔ اصلی.

### ۲.۵ Draft PR
- `pullRequestStep` (`implementation.ts:353-377`): **`draft: true`** در `:372`، با پیام «Do not merge until the task's GitHub CI gate passes».

### ۲.۶ CI (خواندن، نه اجرا)
- ابزار `run_tests` → `verifyGithubChecks` در `src/tools/github-checks.ts:5-101`: حلقهٔ polling هر ≤۲s روی `getChecks(repo, sha)`.
- **سقف انتظار:** `:39-41` — `waitMs = clamp(0..90_000)` از `input.waitMs ?? metadata.ciWaitMs ?? 60_000`؛ پس از deadline → `unverified` (`:88-93`).
- تغییر HEAD در حین انتظار → `unverified` صریح (`:70-73`) — رفتار درستی که باید حفظ شود.
- اجرای `npm test` روی میزبان CodeVia عمداً غیرممکن است (`:15-19`) — قانون «هیچ کدی از ریپوی هدف اجرا نشود».

### ۲.۷ merge-gate
- `verifyPullRequestBeforeMerge` در `src/github/merge-gate.ts:54-168` در **سه** مسیر ادغام:
  1. دکمهٔ Merge UI: `src/http/routes/projects.ts:741-795` (با `expectedSha`)،
  2. ابزار `merge_pull_request` در `src/tools/core-tools.ts:331`،
  3. جاب `merge_pr` در `src/workers/worker.ts:221-246` (گیت در `:230-237`؛ به‌همراه `requireApprovedMergeApproval` `:269-354`).
- شرط‌ها: دست‌کم یک check موفق، هیچ failing/pending، همهٔ `requiredChecks`/`requiredChecksByRepo` موفق، ردِ head جابه‌جا شده (`:93-100`) و حالت‌های `failed/pending/no-ci/passed` (`:115-168`)؛ ادغام به همان SHA پین می‌شود (`worker.ts:230-243`).
- **ریپوی بدون CI:** `:147-158` فقط با `settings.metadata.allowMergeWithoutCi === true` (`:49-51`)؛ وگرنه پیام «Add a GitHub Actions build/test workflow…».

---

## ۳. جدول مشکلات مسیر «تغییر کد ← merge»

شدت: 🔴 بحرانی (ایجنت نمی‌تواند کد عوض کند یا پروژه به merge نمی‌رسد) · 🟠 بالا · 🟡 متوسط · 🔵 پایین/آگاهانه عقب‌افتاده

| ID | مشکل | شدت | فایل و خط | راه‌حل پیشنهادی | گام |
|---|---|---|---|---|---|
| OP-01 | ویرایش فایل فقط با تطابق بایتیِ دقیقاً‑یک‌بار؛ فایل‌های CRLF/BOM (ویندوز/.NET) تقریباً همیشه fail؛ بدون retry، بدون unified diff، بدون بازنویسی فایل کوچک؛ خطای برگشتی به مدل اطلاعات ناحیه/خط نمی‌دهد | ✅ بسته — PR #68 | `src/agents/implementation.ts:82-98` (به‌ویژه `:92-94`)، نقطهٔ فراخوانی `:289`، پرامپت `:277` — **گام ۱ نهایی: PR #68 (نردبان کامل)؛ PR #64 بسته شد** | ترتیب تطبیق exact ← EOL/BOM ← trailing-whitespace ← anchor چندخطی (هر سطح فقط با تک‌match)؛ بازگرداندن ناحیهٔ نزدیک با شمارهٔ خط + حداکثر ۲ patch اصلاحی؛ پشتیبانی unified diff؛ بازنویسی کامل زیر ۸KB (قابل تنظیم)؛ حفظ BOM/EOL/encoding و byte-identical بودن خطوط دست‌نخورده | **۱** |
| OP-02 | هیچ فضای کاری قابل‌نوشتن/اجرای تست وجود ندارد؛ تست فقط از CI خود ریپوی هدف خوانده می‌شود؛ ریپوی بدون CI همیشه `unverified` است | ✅ بسته — PR #69 (گام ۲) | `src/tools/github-checks.ts:5-101` (کل ابزار)، `src/github/merge-gate.ts:147-158`، مستند: `docs/AGENT_EXECUTION.md` بخش «مدل اجرا: بدون کلون محلی» | ساخت خودکار CI برای ریپوی هدف (گام ۲)؛ سپس requiredChecks با نام واقعی jobها پر شود | **۲** |
| OP-03 | هیچ سازوکاری برای ساخت workflow برای ریپوی هدف وجود ندارد (هیچ قالب `codevia-ci` در کد نیست؛ فقط گزارش `ciWorkflows` خالی) | ✅ بسته — PR #69 (گام ۲) | نبود فایل؛ گزارش: `src/http/routes/projects.ts:1040,1095-1098`؛ روت `repo-status` | تشخیص stack (package.json / *.csproj|*.sln / pyproject / go.mod / pom.xml) + قالب `.github/workflows/codevia-ci.yml` per stack؛ پیشنهاد روی شاخهٔ جدا با Draft PR و approval؛ بعد از merge پر کردن `requiredChecks`؛ دکمهٔ «[ساخت CI]» در repo-status و UI | **۲** |
| OP-04 | سقف انتظار CI فقط ۹۰ ثانیه است؛ CI طولانی‌تر ⇒ `unverified` ⇒ «QA could not verify» و شکست غیرقابل‌اصلاح؛ انتظار داخل حلقهٔ polling و نگه‌داشتن lease شغل است | 🔴 | `src/tools/github-checks.ts:39-41` (clamp)، `:41,88-93` (deadline)، حلقه `:56-97`؛ lease: `src/workers/worker.ts:94`؛ شکست: `src/agents/orchestrator.ts:714-716` | مدل پارک و ادامه: job با `waiting_for_ci` + SHA پارک شود، lease آزاد شود؛ ادامه از وبهوک (`check_suite/check_run/status` با HMAC+dedup) یا polling زمان‌بند (پشتیبان)؛ timeout کلی قابل تنظیم (پیش‌فرض ۳۰ دقیقه) ⇒ `unverified` با دلیل خوانا؛ تغییر HEAD ⇒ لغو امن | **۳** |
| OP-05 | وبهوک GitHub رویدادهای `check_suite`/`check_run` را مجزا نمی‌شناسد (همه به `github.workflow_completed` می‌روند) و هیچ مصرف‌کننده‌ای برای ادامهٔ job پارک‌شده وجود ندارد؛ dedup تحویل هم در مسیر checkها دیده نمی‌شود | 🟠 | `src/http/routes/github.ts:268-276` (`normalizeEvent`)، `:225-266` (روت webhook با HMAC در `:236-248`) | افزودن رویداد check + اعتبارسنجی HMAC (موجود) + dedup با `x-github-delivery` + هندلر resume؛ fallback پولینگ scheduler | **۳** |
| OP-06 | QA مستقل نیست (A15): فراخوانی verdict مدل داخل همان فاز QA است، فقط brief + معیارها + لیست فایل‌ها را می‌بیند (نه diff کامل، نه نتیجهٔ CI، نه لاگ)، خروجی Zod با شاهد ندارد و معیارها یک‌به‌یک pass/fail/unknown نمی‌شوند | 🟠 | `src/agents/orchestrator.ts:683-703` (به‌ویژه `:690-698`)، `QA_VERDICT_INSTRUCTION:155` | QA evaluator جدا: فراخوانی مدل مستقل با diff کامل PR + معیارهای پذیرش + نتیجهٔ CI؛ خروجی Zod `[{criterion, verdict: pass\|fail\|unknown, evidence}]`؛ هر fail به حلقهٔ اصلاح | **۴** |
| OP-07 | بازخورد شکست CI فقط نام/وضعیت checkهاست؛ annotations و آخرین N خط لاگ job ناموفق از GitHub API گرفته نمی‌شوند (و mask/sقف اندازه هم ندارد) | 🟠 | `src/github/types.ts:163` (`getChecks` فقط)، نبود متد log/annotations در `src/github/real-service.ts`؛ خروجی به fix: `src/tools/github-checks.ts:60-86` + `orchestrator.ts:723` | افزودن `getCheckAnnotations`/`getJobLogTail` به adapter (سقف اندازه + mask secret) و پاس دادن به ایجنت مسئول در حلقهٔ اصلاح | **۴** |
| OP-08 | تعداد چرخهٔ اصلاح پیش‌فرض ۲ است (clamp 0–10) و فقط به شکست `fixable` CI واکنش نشان می‌دهد؛ معیار ردشدهٔ evaluator جدید مسیر بازگشت ندارد | 🟡 | `src/agents/orchestrator.ts:338` (پیش‌فرض ۲)، `:710-723` (شرط fixable)، `src/domain/entities.ts:262` | پیش‌فرض ۳، قابل تنظیم و محدود به بودجه؛ اتصال failهای evaluator به همان حلقه | **۴** |
| OP-09 | انتقال قرارداد بک‌اند به فرانت‌اند (A14) فقط به فایل‌های صریحاً تولیدشده در همان اجرا وابسته است؛ استخراج صریح قرارداد API (مسیرها/تایپ‌ها/schema) وجود ندارد؛ `dependsOn` به‌تنهایی کافی نیست | 🟠 | `src/agents/orchestrator.ts:581-601` (handoff از `work`)، `src/agents/implementation.ts:419-445` (فقط artifactهای workflow)، مستند: `docs/AGENT_EXECUTION.md` بند ۳ (A14) | استخراج صریح خروجی قرارداد API بک‌اند (فهرست مسیرها، تایپ‌ها، schema) و قرار دادن آن در context فرانت‌اند | **۴** |
| OP-10 | تست E2E «ساخت پروژه روی GitHub واقعی» وجود ندارد؛ `cv-real-test.mjs` فقط سلامت/کاتالوگ/تست مدل است؛ شکاف «POST /projects روی GitHub واقعی» (PR #63) باز است | 🟠 | `scripts/cv-real-test.mjs:1-40` (دامنهٔ فعلی) | گسترش اسکریپت: POST /projects ← ساخت CI ← تسک ← commit ← Draft PR ← CI سبز ← QA ← merge-gate ← merge روی دو ریپوی تست (Node و .NET با CRLF) + بستن شکاف با تست یکپارچه روی `fake-github-rest` | **۵** |
| OP-11 | Auto-approve به‌طور پیش‌فرض روشن است (`DEFAULT_POLICY.autoApprove: true`)؛ در production خطرناک است | 🟠 | `src/approvals/service.ts:55` (و `:96` merge با stored) | در `NODE_ENV=production` پیش‌فرض خاموش؛ روشن کردنش هشدار ثبت کند؛ مستند در `docs/ENVIRONMENT.md` | **۶** |
| OP-12 | worker داخل همان پروسهٔ API اجرا می‌شود (مقیاس‌گیری/پایداری جدا ممکن نیست)؛ `/ready` و `/live` فقط برای پروسهٔ ترکیبی معنا دارند | 🟡 | `src/app/container.ts:237`، `src/index.ts:46-47`، `src/http/routes/health.ts:5,14,19` | استارت‌کند جدا با همان image در Railway (دو start command)؛ اتصال `/ready` و `/live` به هر دو؛ worker آمادگی‌اش را گزارش کند | **۶** |
| OP-13 | پایداری داده (S05): `DATABASE_PATH` روی دیسک موقت بدون volume اعلام‌شده در `railway.json`؛ SQLite تک‌پروسه؛ بک‌آپ زمان‌بندی‌شده در مسیر deploy دیده نمی‌شود | 🟠 | `railway.json:6-13` (بدون volume)، `Dockerfile:69-73` (`/app/data`)، `src/config/env.ts:73` (پیش‌فرض `./data/codevia.db`) | انتخاب صریح: Railway volume برای `DATABASE_PATH` + بک‌آپ زمان‌بندی‌شده **یا** adapter پستگرس پشت همان interface؛ ثبت تصمیم در `docs/decisions/` | **۶** |
| OP-14 | S03 (گزارش‌شده): فیدهای ادمین بین حساب‌ها مشترک. بررسی اولیه: `/dashboard` و بسیاری روت‌ها `accessibleProjectIds` دارند (`src/http/routes/dashboard.ts:3,13`)، ولی همهٔ فیدها/مسیرهای `admin.*` هنوز scope حساب ندارند و باید در گام ۶ تک‌تک راستی‌آزمایی شوند | 🟠 | `src/http/routes/admin.ts:15-51` (فقط نقش، بدون scope پروژه)، روت‌های بدون `accessibleProjectIds`: `admin.ts`، `projects.ts` (فیدهای سراسری) | محدودسازی فیدهای ادمین برای غیرادمین‌ها به پروژه‌های خودشان + تست مالکیت | **۶** |
| OP-15 | `scripts/export-plaintext.mjs` بدون فلگ صریح و بدون قید «فقط محلی» اجراپذیر بود | 🟢 بسته شد | `scripts/export-plaintext.mjs` دیگر پیاده‌سازی جدا نیست؛ فقط لانچر `src/backup/cli.ts` است (`dist/backup/cli.js` در image). خروجی‌اش یک snapshot استاندارد `codevia-runtime-backup` است — قالب قبلی (`…-plaintext`) توسط validator ریستور رد می‌شد و عملاً بن‌بست بود | export plaintext حالا یک قابلیت رسمی و مستند پلتفرم است با همان محافظ‌ها: فقط owner/admin از طریق API، `no-store` + audit، فایل‌های محلی `0600`، رمزنگاری با `BACKUP_PASSPHRASE`، و `BACKUP_INCLUDE_SECRETS=false` برای خاموش کردن کل مسیر. `docs/SYSTEM_BACKUP.md` و `SECURITY.md` را ببینید | — |
| OP-16 | مستندات ناهماهنگ: README می‌گوید ۷۴۴ تست، HANDOFF می‌گوید ۸۱۶، واقعیت ۸۱۹؛ مدل CI جدید و مسیر SPA هم باید همگام شوند؛ CHANGELOG/تگ/چک‌لیست Go-live نیست | 🟡 | `README.md:72`، `HANDOFF.md:11`، نبود `CHANGELOG.md`، نبود `docs/RELEASE_CHECKLIST.md` | همگام‌سازی README/HANDOFF/AGENT_EXECUTION/DEPLOYMENT، CHANGELOG + تگ `v0.2.0`، چک‌لیست Go-live | **۷** |
| OP-17 | S04 — مهاجرت SPA به React/Vite: باندل `client/app → public/app.js` با `build:app` هست (`check:app` سبز)، ولی مهاجرت فریم‌ورکی انجام نشده | 🔵 | `scripts/build-app.mjs`، `client/app/`، `public/app.js` | **عمداً کنار گذاشته شده** (جلوی اجرایی شدن پروژه را نمی‌گیرد) — فقط در این سند ثبت است | — |

---

## ۴. جمع‌بندی مسیرهای شکست

۱. **«ایجنت نمی‌تواند کد موجود را عوض کند»** ← OP-01 (تطابق بایتی بی‌انعطاف؛ شواهد: `implementation.ts:92-94`، PR #64 باز است).
۲. **«کار به merge نمی‌رسد»** ← ترکیب OP-02/OP-03 (ریپوی بدون CI ⇒ `unverified` و merge-gate بسته) + OP-04 (CI طولانی‌تر از ۹۰s ⇒ `unverified` ⇒ «QA could not verify» غیرقابل‌اصلاح در `orchestrator.ts:714-716`).
۳. **«کیفیت ادعاشده اثبات نمی‌شود»** ← OP-06/OP-07/OP-08/OP-09 (QA بدون evaluator مستقل، بدون لاگ CI، با ۲ چرخهٔ اصلاح و handoff ناقص).
۴. **«تضمین production نیست»** ← OP-11/OP-12/OP-13/OP-14/OP-15 (auto-approve روشن، worker درون‌پروسه‌ای، دیسک موقت، scope فیدها، export بدون محافظ).

**نکات درستی که باید حفظ شوند:** پیش‌بررسی write-access قبل از شروع (`write-access.ts`)، commit اتمیک با `expectedHead`، Draft PR با پیام CI-gate، سه‌مسیره بودن merge-gate با pin به SHA، رد «expectedSha جابه‌جا شد»، ممنوعیت shell روی میزبان، و HMAC وبهوک fail-closed.

---

## ۵. قواعد اجرای گام‌های بعدی (تکرار از پرامپت اصلی)

هر گام = یک شاخهٔ `fix/<step>` + یک PR؛ بدون push مستقیم روی main؛ قبل از اعلام پایان `npm run check && npm test && npm run smoke` سبز و تعداد تست کم نشود؛ برای هر رفتار جدید تست واحد + یکپارچه با `src/tests/fake-github-rest.ts`؛ هیچ کدی از ریپوی هدف روی میزبان CodeVia اجرا نشود؛ هیچ secret در commit/لاگ/پرامپت نرود؛ در پایان HANDOFF و docs به‌روز و بدنهٔ PR با Why/What/Tests/Risks/Breaking changes نوشته شود.
