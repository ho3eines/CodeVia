# قرارداد اجرای ایجنت‌های کدنویس

این راهنما مسیر اجرای فعلی Backend / Frontend و ارتباطشان با GitHub، مدل‌ها و QA را توضیح می‌دهد. بخشی از تعریف پروژه و نتایج در GitHub ذخیره می‌شود؛ دیتابیس وضعیت اجرا، صف، هزینه، کاتالوگ و دیگر داده‌های محلی را نگه می‌دارد. **Pull فعلی جایگزین backup کامل دیتابیس نیست.**

> **وضعیت ممیزی:** [ممیزی عمیق ۲۰۲۶-۰۹-۰۷](PIPELINE_AUDIT.md) یک گزارش تاریخی است؛ هر ۱۸ سناریوی آن (A01–A18) بسته شده و `scripts/audit-pipeline.mjs` با خروجی `0` تمام می‌شود. از جملهٔ رفع‌ها: تحویل قرارداد producer→consumer (A14) و رأی ساخت‌یافتهٔ مدل QA برای هر معیار پذیرش (A15). این راهنما مسیر موجود را توصیف می‌کند، نه آمادگی production را.

## جریان کار

1. پیش از اجرا، تعریف کامل ایجنت‌ها، مهارت‌ها، قوانین و حافظه از `CodeVia/` خوانده می‌شود؛ این قاعده شامل Autonomous، تک‌ایجنت و Workflow است. فقط اطلاعات مفقود initialize می‌شود و تسک‌های زنده با سابقهٔ قدیمی بازنویسی نمی‌شوند. [قرارداد ذخیره و بازیابی](REPOSITORY_STATE.md) را ببینید.
2. Research با مدل و پرامپت خودش درخواست را به brief حرفه‌ای تبدیل می‌کند: هدف، نیازمندی‌ها، محدوده، قرارداد API/داده، معیار پذیرش، ریسک‌ها و فرض‌ها. تعریف کامل پروژه، محیط، قوانین و اسکیل‌ها به درخواست واقعی مدل می‌رسند؛ تنظیمات فعلی بر متن قدیمی پرامپت تولیدشده اولویت دارند. سپس یک پاسخ JSON برای تسک‌بندی گرفته می‌شود.
3. همهٔ تسک‌های برنامه پیش از اولین تغییر کد ساخته می‌شوند: ایجنت مسئول، فایل‌ها، معیار پذیرش، پیش‌نیازها و اسکیل‌های همان تسک مشخص‌اند. ترتیب اجرا از `dependsOn` می‌آید؛ برای کارهای آمادهٔ مستقل، ترتیب Database → Backend → Frontend → UI/UX → Refactoring → Performance → Documentation معیار کمکی است. انتقال قرارداد producer→consumer: خروجی هر زیرتسکِ قبلی (repo، branch، SHA و فایل‌ها) به‌عنوان handoff به زیرتسک وابسته داده می‌شود و محتوای واقعی همان فایل‌ها—حتی وقتی نام فایل‌ها در یک مخزن متفاوت باشد—در پرامپت ایجنت بعدی قرار می‌گیرد (A14 بسته شده). `dependsOn` ترتیب اجرا را تعیین می‌کند، نه پوشش کامل معیارهای پذیرش.
4. برای هر مخزن در هر تسک Autonomous یک شاخهٔ مشترک `agent-task-<task id>` وجود دارد. تمام زیرتسک‌ها و تلاش‌های اصلاح روی همان شاخه ادامه می‌یابند. پروژه‌های چندمخزنی برای هر مخزن یک شاخه و PR دارند.
5. مخزن هدف از نقش لینک‌شده در تعریف پروژه انتخاب می‌شود: `backend` برای بک‌اند/دیتابیس، `frontend` یا `mobile` برای فرانت‌اند؛ در نبود لینک تخصصی، مخزن اصلی استفاده می‌شود. خروجی مخزن بک‌اند نیز به context فرانت‌اند داده می‌شود.
6. ایجنت قبل از نوشتن، snapshot کد را بر اساس SHA می‌خواند. تمام فایل‌های یک زیرتسک ابتدا تولید می‌شوند و سپس با **یک commit اتمیک** نوشته می‌شوند؛ فایل چهارم و پنجم حذف نمی‌شوند.
7. یک **Draft PR** برای هر مخزن باز می‌شود تا CI مبتنی بر `pull_request` هم امکان اجرا داشته باشد. PR آمادهٔ مرج تلقی نمی‌شود.
8. QA فایل‌های شاخهٔ کاری، نتیجهٔ Docker sandbox (یا CI همان commit) و معیارهای پذیرش را می‌خواند و مدل QA **مستقلاً برای هر معیار** رأی `pass` / `fail` / `not-covered` همراه با شاهد مشخص می‌دهد (A15 بسته شده). شکست واقعی به واحد مسئول برمی‌گردد؛ اصلاح روی همان شاخه/PR انجام می‌شود و تعداد چرخه‌های اصلاح با `settings.maxFixLoops` (پیش‌فرض ۲؛ در UI بازهٔ ۰–۶) کنترل می‌شود. موفقیت یک چک را نباید اثبات پوشش همهٔ نیازمندی‌ها دانست.
9. نتیجهٔ اجرا، وضعیت اعتبارسنجی، شاخه، SHA و لینک PR روی تسک ثبت می‌شود. شواهد QA در حافظه و یک کامنت PR ثبت می‌شوند. انتشار Draft و Merge همچنان تصمیم انسان است.

اجرای مستقیم یک ایجنت و نود کدنویس Workflow نیز از همان پیاده‌ساز استفاده می‌کنند؛ دیگر یک فایل `src/<agent>.md` را مستقیم روی شاخهٔ اصلی نمی‌نویسند. ایجنت‌های یک Workflow روی شاخهٔ مشترک تسک کار می‌کنند و نود QA باید بعد از تمام نودهای کدنویس قرار بگیرد. برای حلقهٔ خودکار Research → Implement → Fix، حالت **Autonomous task loop** را انتخاب کنید.

## مدل اجرا: GitHub فضای کاری است، Docker sandbox محیط اجراست

سؤال پرتکرار: «قرار نبود اول پروژه را کلون کنی، ایجنت‌ها روی کلون تغییر بدهند، بعد تست اجرا شود و بعد push/pull؟»
حلقهٔ کار **همین است**؛ نوشتن روی API گیت‌هاب انجام می‌شود و اجرای تست/build در یک کانتینر یک‌بارمصرف:

| مرحلهٔ مورد انتظار | آنچه CodeVia واقعاً انجام می‌دهد |
|---|---|
| خواندن پروژه | یک **آینهٔ محلی فقط‌خواندنی** (bare clone) + `ls-tree` / `cat-file` / `grep`؛ در صورت نبود آینه، REST گیت‌هاب (Git Trees API). هیچ checkout و هیچ working copy قابل نوشتنی وجود ندارد |
| تغییرات ایجنت‌ها | تولید patch/فایل و **یک commit اتمیک** روی شاخهٔ مشترک تسک `agent-task-<task id>` (Git Data API) |
| اجرای تست/build | **مسیر بر اساس منبع پروژه:** پروژه‌های متصل به GitHub همیشه شواهد **CI همان commit** را می‌خوانند (Docker اجرا نمی‌شود)؛ مخزن Mock نتیجهٔ `simulated` می‌دهد؛ فقط پروژه‌های واردشده/پوشه‌ای (`sourceType: "local"`) دستورهای lifecycle را داخل **Docker sandbox** اجرا می‌کنند |
| push / PR | باز کردن **Draft PR** برای هر مخزن؛ انتشار از draft و merge تصمیم انسان است (گیت ادغام CI را شرط می‌کند) |
| pull بازگشتی | `POST /projects/:id/pull` تعریف‌ها (`CodeVia/`) را از گیت به دیتابیس برمی‌گرداند |

### اجرای ایزوله در Docker sandbox (فقط پروژه‌های local)

کد مخزن **هرگز روی میزبان CodeVia اجرا نمی‌شود**. برای پروژه‌های متصل به GitHub، `run_tests`/`run_build` فقط CI را می‌خوانند؛ تنها پروژه‌های `sourceType: "local"` (فولدر سرور یا ZIP/RAR) درخواست را به `SandboxRunner` (`src/projects/sandbox-runner.ts`) می‌دهند که:

1. درخت فایل را از یک **SHA تغییرناپذیر** بیرون می‌کشد (مخزن محلی: `git ls-tree`/`cat-file`؛ گیت‌هاب: Git Trees API + blobها). پروژهٔ پوشه‌ای که با `gitInit: false` ساخته شده **هیچ مخزنی ندارد**؛ برای همین سندباکس به‌جای GitHub/LocalGit مستقیماً `project.localPath` را با همان `collectSafeFolderFiles` می‌خواند (همان سقف فایل/حجم/تعداد، همان رد کردن symlink و فایل ویژه). چون commitی وجود ندارد، `sha` گزارش‌شده یک **digest محتوایی SHA-256** از همان درختی است که به کانتینر داده شد. فایل‌های حساس (`.env*`، `*.pem`، `id_rsa*`، `.npmrc`، …) کنار گذاشته می‌شوند و symlink/فایل ویژه باعث توقف با `unverified` می‌شود. خروجی صریح می‌گوید: «این پروژه گیت ندارد؛ از localPath اجرا شد».
2. فایل‌ها را در یک workspace موقت می‌نویسد (پاک‌سازی در `finally`).
3. `docker run --rm` با این محدودیت‌ها اجرا می‌کند: `--network=none` (مگر opt-in پروژه)، `--read-only`، `--cap-drop=ALL`، `--security-opt=no-new-privileges`، `--user=1000:1000`، `--pids-limit`، `--cpus`، `--memory`/`--memory-swap`، `--tmpfs /tmp` و `--pull=never`.
4. خروجی را به `passed` / `failed` / `unverified` نگاشت می‌کند؛ `exit 127` یعنی ابزار/Docker در دسترس نیست و **قابل اصلاح با کد نیست** (`fixable: false`).

**دستورها per-project هستند** و در `Project → Edit → Operations` (یا `PATCH /projects/:id` با `commands`) ویرایش می‌شوند: `install`, `build`, `test`, `lint`, `start`. اگر خالی باشند از تحلیل پروژه (`package.json` scripts، lockfile، `pyproject.toml`، `go.mod`، `Cargo.toml`، `composer.json`) پر می‌شوند. مرحلهٔ `test` دستورهای `install` → `test` → `lint` و مرحلهٔ `build` دستورهای `install` → `build` → `test` → `lint` را به‌ترتیب اجرا می‌کند. نبودِ دستور همان مرحله یعنی `unverified` — به‌جای اجرای حدسی.

**شبکه** به‌صورت پیش‌فرض بسته است. `settings.sandboxNetworkAccess = true` آن را باز می‌کند و در این حالت حتی پروژهٔ trusted هم برای هر اجرا تأیید انسانی می‌خواهد. `settings.trustedForExecution = true` فقط وقتی شبکه بسته است تأییدِ هر اجرا را رد می‌کند؛ sandbox هرگز خاموش نمی‌شود. Approval فقط جایی اجباری است که کد واقعاً اجرا می‌شود: پروژهٔ local با runner فعال و شبکهٔ باز، یا پروژهٔ trusted‌نشده. وقتی هیچ کدی اجرا نمی‌شود (پروژهٔ متصل به GitHub، مخزن Mock، یا `PROJECT_SANDBOX_ENABLED=false`) ابزار Approval نمی‌خواهد، چون فقط شواهد CI خوانده می‌شود.

**تصویر:** به‌صورت پیش‌فرض از زبان پروژه انتخاب می‌شود (`node:22-alpine`، `python:3.12-slim`، `golang:1.24-alpine`، `rust:1.88-slim`، `php:8.3-cli-alpine`) و با `PROJECT_SANDBOX_IMAGE` قابل تغییر است. خودِ اجرا همیشه `--pull=never` دارد. مرحلهٔ تصویر صریح و قابل‌تنظیم است (`PROJECT_SANDBOX_IMAGE_PULL`): `never` (پیش‌فرض) هیچ فرمان اضافه‌ای نمی‌زند و اگر تصویر نباشد خطای دقیق «ایمیج موجود نیست؛ `docker pull <image>`» با `sandbox: "image-missing"` و `fixable: false` برمی‌گردد؛ `missing` اول `docker image inspect` می‌زند و فقط در صورت نبودن `docker pull` می‌کند؛ `always` قبل از هر اجرا pull می‌کند. pull از شبکهٔ میزبان/daemon استفاده می‌کند و ربطی به `--network` کانتینر ندارد.

**پیکربندی** (`.env.example` / `docs/ENVIRONMENT.md`): `PROJECT_SANDBOX_ENABLED` (خاموش = هیچ کانتینری اجرا نمی‌شود؛ پروژه‌های متصل به GitHub از CI و پروژه‌های local با `unverified`/`sandbox: unavailable` پاسخ می‌گیرند، بدون نیاز به Docker و بدون Approval)، `PROJECT_SANDBOX_DOCKER_BIN`، `PROJECT_SANDBOX_IMAGE`، `PROJECT_SANDBOX_TIMEOUT_MS` (پیش‌فرض ۸ دقیقه)، `PROJECT_SANDBOX_MEMORY_MB`، `PROJECT_SANDBOX_CPUS`، `PROJECT_SANDBOX_PIDS_LIMIT`، `PROJECT_SANDBOX_LOG_TAIL_BYTES`، `PROJECT_SANDBOX_DIR`، `PROJECT_SANDBOX_IMAGE_PULL`. همه در قرارداد اعتبارسنجی env هستند و در بکاپ کامل هم ذخیره می‌شوند.

> **استقرار:** فقط برای پروژه‌های local به Docker نیاز است. پروژه‌های متصل به GitHub همیشه از CI استفاده می‌کنند و بدون Docker هم کار می‌کنند. اگر خودِ CodeVia داخل کانتینر اجرا می‌شود و پروژهٔ local هم دارید:
>
> - ایمیج را با `docker build --build-arg INSTALL_DOCKER_CLI=true .` بسازید (فقط CLI نصب می‌شود، نه daemon) و یک daemon در دسترس بدهید: سوکت میزبان (`/var/run/docker.sock` — معادل دسترسی root روی میزبان؛ گزینهٔ کامنت‌شده و هشدار امنیتی در `docker-compose.yml`)، یا سایدکار با `DOCKER_HOST=tcp://docker:2375`، یا daemon روی شبکه.
> - ایمیج‌ها را از قبل pull کنید، یا `PROJECT_SANDBOX_IMAGE_PULL=missing` را روشن کنید تا `inspect`/`pull` صریح انجام شود.
> - بدون این‌ها `run_tests` برای همان پروژه‌های local با `unverified`/`sandbox: unavailable` یا `image-missing` برمی‌گردد و هرگز روی میزبان اجرا نمی‌شود.

### چه چیزی بدون Docker، بدون مدل واقعی و بدون گیت کار می‌کند؟

«بدون گیت» یعنی نه GitHub و نه Local Git لازم نیست؛ «بدون مدل واقعی» یعنی فقط Mock AI فعال است؛ «بدون Docker» یعنی هیچ کانتینری اجرا نمی‌شود. همهٔ ادعاهای این جدول با تست‌های همین مخزن پوشش داده شده‌اند.

| قابلیت | بدون Docker | بدون مدل واقعی (Mock) | بدون گیت / GitHub |
|---|---|---|---|
| اجرای UI، ورود، scan پوشه (`POST /projects/scan`) | ✅ | ✅ | ✅ |
| ساخت پروژه از پوشه با `gitInit: false` (`POST /projects/from-local`) | ✅ | ✅ | ✅ — `sourceType: "local"` بدون `configRepo` |
| ساخت پروژه از پوشه با `gitInit: true` | ✅ (فقط git سیستم) | ✅ | ✅ — Local Git؛ GitHub لازم نیست |
| `POST /projects/new-local` و `POST /projects/import` (ZIP) | ✅ (فقط git سیستم) | ✅ | ✅ — مخزن `local/<slug>` |
| `POST /projects/import` برای `.rar` | ✅ | ✅ | ✅ — به `7z` نیاز دارد (در ایمیج نصب است) |
| تحلیل، فهرست فایل، جست‌وجو و `analysis` پروژهٔ پوشه‌ای | ✅ | ✅ | ✅ |
| **اجرای `install/test/lint/build` پروژهٔ پوشه‌ای بدون گیت** | ❌ → `unverified` / `sandbox: "unavailable"` | ✅ (Mock مدل دخالتی ندارد) | ✅ — منبع مستقیم `project.localPath` |
| اجرای دستورها برای پروژهٔ local دارای مخزن | ❌ → `unverified` | ✅ | ✅ — Local Git، بدون GitHub |
| تأیید پروژهٔ متصل به GitHub از طریق CI | ✅ | ❌ → `simulated` | ❌ — GitHub لازم است |
| Simulation (`executionMode: "simulation"`) | ✅ | ✅ | ✅ (فقط پلن، بدون نوشتن) |
| تسک Autonomous/Agent/Workflow با **تغییر واقعی کد** | بستگی به مسیر دارد | ❌ → scaffold/TODO یا `simulated`؛ کد واقعی تغییر نمی‌کند | ❌ — نیاز به مخزن برای commit/PR |
| Draft PR، merge و چرخهٔ QA روی مخزن | — | ❌ | GitHub یا Local Git لازم است |
| بکاپ کامل و بازیابی | ✅ | ✅ | ✅ |

**نکتهٔ دقیق دربارهٔ پروژهٔ پوشه‌ای بدون گیت:** اجرای تست/build در سندباکس مجاز است (منبع، `localPath` است)، اما درخواست پیاده‌سازی/تغییر کد برای آن همچنان با `409` و `repositoryRequired: true` رد می‌شود، چون commit/PR جایی برای نوشتن ندارد. برای اجرای کامل زنجیره، پروژه را با `gitInit: true` بسازید یا یک ZIP/RAR را import کنید.

### نمونهٔ curl

```bash
BASE=http://localhost:8080
# اگر REQUIRE_AUTH=true است، کوکی نشست را اضافه کنید: -b "codevia_session=…"

# 1) scan یک پوشهٔ سرور (بدون ساخت پروژه)
curl -s $BASE/projects/scan -H 'content-type: application/json' \
  -d '{"path":"/srv/repos/shop3"}' | jq .analysis.suggestions

# 2) ساخت پروژه از پوشه، بدون گیت (analysis-only؛ تست/build از localPath اجرا می‌شود)
curl -s $BASE/projects/from-local -H 'content-type: application/json' \
  -d '{"path":"/srv/repos/shop3","overrides":{"name":"Shop 3"}}'

# 3) همان پوشه به‌صورت مخزن Local Git (برای commit/PR ایجنت‌ها)
curl -s $BASE/projects/from-local -H 'content-type: application/json' \
  -d '{"path":"/srv/repos/shop3","gitInit":true,"overrides":{"name":"Shop 3"}}'

# 4) ساخت پروژهٔ خالی جدید (README + یک commit اولیه)
curl -s $BASE/projects/new-local -H 'content-type: application/json' \
  -d '{"name":"Shop 3"}'

# 5) آپلود ZIP (یا RAR) و ساخت مخزن local/<slug>
curl -s $BASE/projects/import \
  -F name='Shop 3' -F file=@shop3.zip

# 6) ساخت تسک روی پروژه (projectId از خروجی مراحل قبل)
curl -s $BASE/tasks -H 'content-type: application/json' \
  -d '{"projectId":"proj-1a2b3c4d","title":"افزودن صفحهٔ ورود","description":"ورود با ایمیل و رمز"}' | jq .

# 7) اجرای دستی همان تسک (خروجی: run id؛ اجرای واقعی به مدل/مخزن نیاز دارد)
TASK_ID=task-1234abcd
curl -s -X POST "$BASE/tasks/$TASK_ID/run" | jq .
```

### آینهٔ محلی فقط‌خواندنی (Read-only mirror)

**هست:** یک bare clone از مخزن متصل، زیر `REPO_MIRROR_DIR` (پیش‌فرض `<dirname(DATABASE_PATH)>/mirrors`)، که **به تفکیک حساب کاربریِ فعال** ذخیره می‌شود (`<acct-…>/<owner>/<name>.git`). خواندن فقط با دستورهای plumbing انجام می‌شود: `git ls-tree`، `git cat-file`، `git rev-parse` و `git grep`. توکن فقط به‌صورت هدر `AUTHORIZATION: bearer …` در محیط اجرایی همان فرمان پاس داده می‌شود: نه در آرگومان‌ها، نه در کانفیگ ماندگار مخزن، نه در لاگ. سقف‌های ایمنی: `REPO_MIRROR_MAX_MB`، `REPO_MIRROR_MAX_FILES`، `REPO_MIRROR_MAX_READ_BYTES`، تایم‌اوت جدا برای clone/fetch و برای هر خواندن، و `GIT_TERMINAL_PROMPT=0`.

**نیست:** فضای کاری قابل نوشتن. آینه هیچ‌وقت checkout نمی‌شود و اسکریپتی از آن اجرا نمی‌شود. نوشتن از راه Git Data API انجام می‌شود و اجرا فقط در Docker sandbox بالا (یا CI خود مخزن) است.

آینه یک **بهینه‌سازی** است نه وابستگی جدید: اگر `git` نصب نباشد، clone ناموفق بماند، مخزن از سقف بزرگ‌تر باشد یا fetch شکست بخورد، همان خواندن از REST گیت‌هاب انجام می‌شود و وضعیت آینه در بنر چت و در `repo-status` صادقانه گزارش می‌شود (`POST /projects/:id/repo-mirror/refresh` برای همگام‌سازی دستی، `DELETE /projects/:id/repo-mirror` برای حذف نسخهٔ محلی). با `REPO_MIRROR_ENABLED=false` کل این مسیر خاموش می‌شود.

## درخواست → برنامهٔ اجرایی → اسکیل اختصاصی

در **Ask AI وب، `POST /projects/:id/ask` بدون تعیین mode، و پیام عادی تلگرام**، مسیر پیش‌فرض همین حلقهٔ Autonomous است. انتخاب صریح `executionMode: "agent"`، `"workflow"` یا `"simulation"` همچنان ممکن است؛ `workflowId` صریح هم Workflow را انتخاب می‌کند. برای اجرای فقط Research/QA/Security و دیگر نقش‌های خواندنی، حالت تک‌ایجنت را انتخاب کنید؛ hint خواندنی در حالت Autonomous به‌طور پنهانی به تغییر کد تبدیل نمی‌شود.

برنامهٔ مدل می‌تواند **۱ تا ۱۲ تسک، هرکدام با ۱ تا ۵ فایل** داشته باشد؛ بودجهٔ واقعی پروژه همچنان سقف اجراست. واحدهای اجرایی این حلقه Backend، Frontend، Database، UI/UX، Documentation، Refactoring و Performance هستند؛ فقط واحد فعال و دارای ابزار/مجوز لازم می‌تواند تغییر بنویسد. Research و QA مراحل جداگانه‌اند. نقش‌های دیگر از حالت تک‌ایجنت یا Workflow قابل اجرا هستند.

نمونهٔ آیتم پاسخ برنامه‌ریز:

```json
{
  "id": "login-api",
  "agentType": "backend-developer",
  "title": "Implement session login",
  "description": "Reuse the existing session service and error envelope.",
  "files": ["src/server/login.ts", "src/server/login.test.ts"],
  "dependsOn": [],
  "acceptanceCriteria": ["Invalid credentials return 401 without leaking details"],
  "skills": ["nodejs", "typescript", "restapi", "security"],
  "skillInstructions": {
    "security": "Validate login inputs, preserve session expiry and never log credentials."
  }
}
```

- `id` شناسهٔ درون برنامه است. `dependsOn` به همان شناسه‌ها اشاره می‌کند و روی تسک ساخته‌شده به شناسهٔ واقعی تسک‌ها تبدیل می‌شود. شناسهٔ تکراری، چرخه، پیش‌نیاز ناموجود، ایجنت نامعتبر و مسیر ناامن قبل از اجرای تغییرات رد می‌شوند. پاسخ‌های قدیمیِ بدون فیلدهای جدید، قرارداد پیش‌فرض صریح می‌گیرند.
- لیست اسکیل مجاز برای **هر صاحب تسک** به مدل داده می‌شود. مبنا، تنظیمات پروژه، انتخاب فناوری، اسکیل‌های ایجنت و سازگاری نقش است؛ اسکیل ناموجود/غیرفعال یا نامرتبط در خروجی مدل باعث توقف می‌شود، نه اجرای حدسی.
- اسکیل‌های خودکار از stack پیروی می‌کنند: مثلاً React به‌طور پیش‌فرض Blazor دریافت نمی‌کند، و TypeScript فرانت‌اندِ پروژهٔ .NET + React به معنی انتخاب Node برای بک‌اند نیست. انتخاب‌های دستی با سابقهٔ اسکیل‌های تولیدشده تفکیک می‌شوند تا بازتولید معمول آن‌ها را پاک نکند.
- پیش‌نیازهای اسکیل به‌ترتیب و فقط یک بار اضافه می‌شوند؛ مثلاً Blazor به دانش .NET و C# نیاز دارد. پیش‌نیاز ناموجود/غیرفعال یا چرخه، خطای مشخص دارد. فیلد `tools` اسکیل **مجوز اجرای ابزار جدید نمی‌دهد**.
- «تغییر اسکیل برای وظیفه» یعنی **دستور تکمیلی مخصوص همان تسک** (`skillInstructions`/`guidance`) در کنار متن پایهٔ اسکیل. کاتالوگ مشترک، نسخهٔ اصلی، مجوزها و تعریف ایجنت‌ها در اثر اجرای تسک بازنویسی نمی‌شوند. تلاش اصلاح QA، راهنمای جدید مبتنی بر همان خطا و در صورت سازگاری اسکیل Testing دریافت می‌کند.
- `input.researchBrief` و `input.breakdown` روی والد و `assignedAgentId`، `input.skills`، `input.skillAssignments`، `input.acceptanceCriteria` و `input.dependsOn` روی فرزندان ثبت می‌شوند. `run.skills` snapshot دقیق متن پایه، نسخه و دستور استفاده‌شده است. **Task details و Run Console** این اطلاعات را نشان می‌دهند.
- همین اطلاعات در `CodeVia/tasks/` ذخیره و با Pull بازیابی می‌شوند؛ حتی brief دارای تیترهای Markdown کامل باقی می‌ماند. انتخاب خالی اسکیل پروژه هم به‌عنوان حذف عمدی حفظ می‌شود. لغو/شکست مالک، تسک‌های هنوز اجرا‌نشده را لغو می‌کند.

اسکیل جدید را در Skills همان پروژه یا با `POST /skills` همراه `projectId` بسازید و از Skills پروژه یا Agent Builder متصل کنید. `/skills` بدون projectId، templateهای عمومی را نشان می‌دهد. برای اسکیل سفارشی، `compatibleAgentTypes: []` یعنی قابل استفاده توسط همهٔ نقش‌ها؛ برای محدود کردن، نقش‌ها را صریح فهرست کنید. تعریف پروژه مستقل از template عمومی است؛ غیرفعال کردن تعریف همان پروژه، آن را از انتخاب خودکار خارج می‌کند. جدا کردن از پروژه الزاماً دانش پیش‌فرض مستقل ایجنت یا پیش‌نیاز اسکیل دیگری را حذف نمی‌کند.

**Research فعلی از تنظیمات، حافظه و شواهد مخزن تحلیل می‌سازد؛ این به معنی جست‌وجوی وب یا تأیید منبع بیرونی نیست.** در نبود مدل واقعی، فقط روی Mock یک brief و برنامهٔ قطعی و scaffold/TODO تولید می‌شود. برای تولید واقعی محتوا، provider و مدل فعال لازم است؛ موفقیت تست‌های خود CodeVia به معنی آزموده شدن کد یک پروژهٔ واقعی نیست.

## قرارداد Workflow و انتقال خروجی

Workflow یک DAG واقعی است، نه پیمایش بازگشتیِ بدون کنترل:

- قبل از هر ابزار، کل گراف بررسی می‌شود: شناسهٔ تکراری، لینک به نود ناموجود، چرخه (حتی در بخش جدا از مسیر اصلی)، پروژهٔ نامنطبق یا Workflow غیرفعال رد می‌شود.
- همهٔ ریشه‌ها اجرا می‌شوند. نود مشترکِ چند شاخه فقط یک بار و بعد از تکمیل همهٔ پیش‌نیازهای انتخاب‌شده اجرا می‌شود.
- شکست یک نود، نودهای وابسته را `blocked` می‌کند. تشخیص‌های مستقل می‌توانند ادامه پیدا کنند؛ شکست قبلی با موفقیت یک شاخهٔ دیگر پنهان نمی‌شود.
- کارهای مستقل می‌توانند موازی باشند؛ عملیات تغییردهندهٔ همین Workflow سری می‌شوند تا دو نویسنده هم‌زمان یک شاخه را بازنویسی نکنند.
- خروجی پیش‌نیازها در `task.input.workflow.predecessors` و ارجاع فایل‌ها/مخزن‌ها در `task.input.workflow.artifacts` به ایجنت بعدی داده می‌شود. context بازبینی به snapshot تغییرات اشاره می‌کند، نه صرفاً کد شاخهٔ پایه.
- QA باید **بعد از آخرین نویسنده** باشد. اگر بعد از QA فایل دیگری commit شود، نتیجهٔ قبلی آن SHA جدید را تأیید نمی‌کند و Workflow با `unverified` متوقف می‌شود.

نمونهٔ شرط:

```text
inputs.needFrontend && outputs["backend-node"].status === "succeeded"
```

زبان شرط فقط داده می‌خواند: boolean/string/number/null، مسیرهای `inputs` و `outputs`، عملگرهای مقایسه، `!`، `&&`، `||` و پرانتز. `==` هم مقایسهٔ بدون تبدیل نوع است. `eval`، فراخوانی تابع، دسترسی prototype و اجرای JavaScript وجود ندارد. مقدار گمشده truthy فرض نمی‌شود. لبه‌های `pass` و `fail` خروجی boolean نود condition را انتخاب می‌کنند؛ شرط، مجوز نادیده گرفتن شکست پیش‌نیاز نیست.

برای انتقال خروجی به `config.input` ابزار یا ایجنت:

```json
{
  "contract": "{{ outputs['backend-node'].summary }}",
  "ref": "{{ outputs['commit-node'].data.branch }}"
}
```

ارجاع کامل، نوع مقدار را نگه می‌دارد؛ مثلاً آرایه یا عدد به string تبدیل نمی‌شود. ارجاع گمشده خطاست و به یک شاخه/مسیر پیش‌فرض تبدیل نمی‌شود.

**Workflowهای از قبل ذخیره‌شده خودکار بازنویسی نمی‌شوند.** اگر یک Workflow قدیمی QA را قبل از آخرین نویسنده قرار داده، در Builder جای آن را اصلاح کنید. الگوهای جدید همین ترتیب را رعایت می‌کنند. برای حلقهٔ اصلاح خودکار محدودشده، حالت Autonomous را انتخاب کنید؛ شکست Workflow به معنی اجرای کورکورانهٔ دوبارهٔ کل عملیات نیست.

## مدل، پرامپت و هزینه

- تولید کد داخل Run قابل مشاهده، بودجه‌بندی‌شده و قابل لغو انجام می‌شود؛ یک فراخوانی جداگانه و بی‌اثر برای مصرف توکن وجود ندارد.
- `systemPrompt`، `projectPrompt`، Skills فعال، قوانین پروژه و context مخزن وارد درخواست واقعی مدل می‌شوند.
- تولید کد از routing دستهٔ `coding` استفاده می‌کند؛ Research از `research`.
- تنظیمات Primary / Secondary / Specialized / Fallback همان ایجنت، `temperature`، `omitTemperature` و `maxTokens` رعایت می‌شوند.
- وقتی مدل‌های واقعی به ایجنت تخصیص داده شده باشند، خطا، غیرفعال‌شدن یا حذف تخصیص آن‌ها موجب ارسال کد به یک provider نامرتبط یا Mock نمی‌شود. وقتی تخصیص‌ها هنوز فقط Mock هستند، مدل‌های واقعی فعال رجیستری نامزد انتخاب‌اند.
- کلید رمزگذاری‌شدهٔ واردشده در صفحه Providers در adapter واقعی هم خوانده می‌شود؛ نه فقط در دکمهٔ Test Provider.
- هزینهٔ هر فراخوانی به پروژه، ایجنت و تسک مربوط ثبت می‌شود. محدودیت‌های کل تسک Autonomous شامل Research، تولید فایل‌ها و اصلاحات است؛ محدودیت هر Run نیز جداگانه اعمال می‌شود.
- خطای provider یا پاسخ بریده‌شده با `length`/`max_tokens` اجرای واقعی را متوقف می‌کند؛ به‌جایش scaffold روی مخزن واقعی commit نمی‌شود.

## ویرایش امن فایل موجود

مدل برای فایل موجود یکی از سه فرمت patch را می‌فرستد (به‌ترتیب تشخیص):

1. **JSON ساختاریافته** (فرمت اصلی):
```json
{
  "edits": [
    {
      "oldText": "exact unique existing text",
      "newText": "replacement text"
    }
  ]
}
```
2. **Unified diff** (`--- a/…`، `+++ b/…`، هنک‌های `@@ -l,s +l,s @@`)؛ خطوط context باید دقیقاً با فایل بخوانند و خط `\\ No newline at end of file` رعایت می‌شود.
3. **بازنویسی کامل فایل** — فقط برای فایل‌هایی که از آستانهٔ `PATCH_FULL_REWRITE_MAX_BYTES` (پیش‌فرض ۸KB) کوچک‌ترند: یا `{"content":"…"}` صریح، یا متن کامل فایل (با یک خط فنس ```` ``` ````). بازنویسی خامی که هیچ خطی با فایل مشترک نداشته باشد رد می‌شود؛ `{"content":"…"}` این گارد را دور می‌زند.

**نردبان تطبیق `oldText`:** exact ← نرمال‌سازی EOL/BOM ← نرمال‌سازی whitespace انتهای خط ← تطبیق anchor (اولین/آخرین خط معنادار با تحمل ±۲ خط روی فاصله). هر سطح فقط وقتی پذیرفته می‌شود که **دقیقاً یک** match داشته باشد. همهٔ تطبیق‌ها روی فضای نرمال‌شده با نگاشت اندیس به متن اصلی انجام می‌شوند؛ خطوط دست‌نخورده **byte-identical** می‌مانند و EOL غالب فایل + BOM اصلی همیشه حفظ می‌شوند (فایل‌های CRLF/BOM ویندوز/.NET و فایل‌های mixed-EOL پشتیبانی می‌شوند).

**بازخورد اصلاحی به‌جای fail فوری:** اگر هیچ سطحی match نداشته باشد (یا match تکراری باشد، یا context هنک diff نخواند)، خطا `PatchApplyError` با **شمارهٔ خطوط** و **نزدیک‌ترین ناحیهٔ فایل** به همراه شماره خط برمی‌گردد و درخواستِ اصلاحی دوباره به مدل فرستاده می‌شود — حداکثر **۲ بار patch اصلاحی** (`MAX_PATCH_CORRECTIONS`) برای هر فایل، و بعد از آن اجرا با همان خطای آخر متوقف می‌شود.

فایل جاری کامل در درخواست ویرایش قرار می‌گیرد؛ فایل‌های بزرگ به‌صورت پنهانی به ۲۴هزار کاراکتر بریده نمی‌شوند. اگر فایل از سقف ایمن ۲۰۰هزار کاراکتر یا context از ظرفیت مدل/بودجه بزرگ‌تر باشد، اجرا با توضیح متوقف می‌شود و باید تسک کوچک‌تر شود یا بودجه/مدل تنظیم شود.

مسیرهای absolute، traversal و فایل‌های مدیریت‌شدهٔ `.git/` و `CodeVia/` برای تولید کد پذیرفته نمی‌شوند. تغییر SHA شاخه بعد از بازرسی، commit قدیمی را رد می‌کند. نداشتن ابزار ساخت شاخه به معنی نوشتن مستقیم روی شاخهٔ اصلی نیست؛ اجرا متوقف می‌شود.

این محافظ‌ها جای review معنایی کد و تست مناسب را نمی‌گیرند.

## راه‌اندازی Build/Test واقعی

دو مسیر مستقل وجود دارد و هر دو «اجرای واقعی» هستند:

### ۱) Docker sandbox (پیش‌فرض وقتی Docker در دسترس است)

- دستورهای `install/build/test/lint` پروژه را در `Project → Edit → Operations` تنظیم کنید. خالی گذاشتن `test` یعنی QA راهی برای تأیید ندارد و `unverified` می‌ماند.
- تصویر مناسب را از قبل pull کنید (`docker pull node:22-alpine`) چون sandbox با `--pull=never` اجرا می‌شود.
- برای پروژه‌ای که نصب وابستگی نیاز به شبکه دارد، `settings.sandboxNetworkAccess=true` را آگاهانه روشن کنید؛ در این حالت هر اجرا تأیید انسانی می‌خواهد.
- نتیجهٔ هر اجرا (`stdout`/`stderr` tail، `exitCode`، `sha`، `timedOut`، `durationMs`) در Run Console و روی تسک ثبت می‌شود.

### ۲) GitHub CI (fallback و گیت ادغام)

اگر Docker در دسترس نباشد (یا `sandboxRunner` در محیط جاسازی‌شده وجود نداشته باشد)، `run_tests`/`run_build` برای پروژه‌های متصل به ریپو **Check Runs و Commit Statusهای GitHub** را برای همان SHA می‌خوانند. **گیت ادغام همیشه مستقل از sandbox از CI می‌خواند** و merge بدون چک سبز رد می‌شود.

برای هر مخزن:

1. یک GitHub Actions workflow یا CI خارجی بسازید که build و تست‌های همان مخزن را اجرا و status ثبت کند. برای شروع، trigger روی `push` شاخه‌های کاری ساده‌ترین انتخاب است. `pull_request` نیز پشتیبانی می‌شود؛ workflow نباید Draft PRها را بدون ثبت تست معتبر skip کند.
2. اتصال GitHub پروژه باید اجازهٔ خواندن Contents / Checks / Statuses و نوشتن Contents / Pull Requests داشته باشد. اتصال OAuth ذخیره‌شدهٔ مالک در اجرای پس‌زمینه هم استفاده می‌شود؛ نبود اتصال به Mock یا حساب دیگر fallback نمی‌کند.
3. در تنظیمات پروژه، نام checkهای الزامی را تعیین کنید. مثال برای پروژه‌ای که jobهای CI آن واقعاً `build` و `test` نام دارند:

```json
{
  "settings": {
    "metadata": {
      "requiredChecks": ["build", "test"],
      "ciWaitMs": 60000
    }
  }
}
```

این patch به `PATCH /projects/:id` فرستاده می‌شود؛ اگر metadata دیگری دارید، هنگام ذخیره آن را هم حفظ کنید. نام‌ها باید دقیقاً با نام Check/Status در GitHub یکسان باشند. در پروژهٔ چندمخزنی این فهرست پیش‌فرض همهٔ مخزن‌های تسک است. برای نام‌های متفاوتِ jobها می‌توانید در همان metadata از `requiredChecksByRepo` استفاده کنید؛ مثلاً:

```json
{
  "requiredChecksByRepo": {
    "acme/api": ["build-api", "unit-tests"],
    "acme/web": ["build-web", "browser-tests"]
  }
}
```

بدون `requiredChecks`، همهٔ checkهای گزارش‌شده بررسی می‌شوند و دست‌کم یک check موفق لازم است. بنابراین **پوشش build/test را خود workflow و فهرست requiredChecks تعیین می‌کنند**؛ موفق بودن صرفاً یک check مربوط به lint، جای تست کامل محصول نیست.

انتظار پیش‌فرض ۶۰ ثانیه و سقف قابل تنظیم ۹۰ ثانیه برای هر فراخوانی است. زمان کل Run/تسک هم همچنان محدود به بودجه است. اگر CI طولانی‌تر است، زمان بودجه را متناسب تنظیم کنید و بعد از آماده شدن شواهد دوباره اجرا کنید. نبود یا pending بودن CI، خطای شبکه/احراز هویت GitHub و جابه‌جا شدن HEAD در حین انتظار باعث تولید کد «اصلاحی» تصادفی نمی‌شود. فقط شکست واقعی checkها بازخوردِ قابل اصلاح است.

## معنی وضعیت‌ها

`status` نتیجهٔ اجرای مراحل را می‌گوید؛ `verification` شواهد اعتبارسنجی را:

| verification | معنی |
|---|---|
| `passed` | sandbox با کد خروج ۰ تمام شد، یا همهٔ checkهای گزارش‌شده/الزامی CI برای SHA موردنظر سبزند |
| `failed` | sandbox/CI شکست واقعی گزارش کرده؛ بازخورد برای اصلاح قابل استفاده است (`fixable: true`، به‌جز timeout/لغو) |
| `unverified` | دستور مرحله تنظیم نشده، Docker/ابزار در دسترس نیست، فایل حساس/symlink مانع export شد، یا CI ناقص/pending/skipped است |
| `simulated` | مخزن Mock است؛ هیچ build یا تست واقعی اجرا نشده است |

Run Console و فهرست اجراها این تفاوت را نمایش می‌دهند. `succeeded` همراه `simulated` یعنی **سناریوی شبیه‌سازی تمام شده**؛ نه اینکه قابلیت واقعی پیاده‌سازی یا تست شده است. حالت بدون مدل فقط روی Mock GitHub scaffold/TODO تولید می‌کند.

**Mock GitHub با Simulation یکی نیست.** اتصال Mock فقط لایهٔ ذخیره‌سازی است (مخزن درون‌حافظه‌ای/JSON محلی، بدون push به GitHub واقعی). اگر مدل واقعی به ایجنت تخصیص داده شده باشد، محتوای واقعی تولید و روی همان مخزن Mock با یک commit اتمیک و Draft PR ثبت می‌شود؛ فقط `verification` چون Docker/CI واقعی ندارد `simulated` می‌ماند. برعکس، **بدون مدل واقعی** محتوای فایل‌ها scaffold/TODO است و خلاصهٔ اجرا هم صریحاً «Simulation scaffold (not a completed feature)» را نشان می‌دهد. پس «Mock فقط scaffold» تنها برای حالت بدون مدل درست است.

## لغو، خطا و تأیید

- لغو تسک والد به زیرتسک‌ها منتقل می‌شود و بعد از پاسخ مدل، بعد از انتظار Approval و پیش از ابزار بعدی دوباره کنترل می‌شود. درخواست HTTP در حال پرواز ممکن است تا timeout adapter ادامه یابد، اما نتیجهٔ آن پس از لغو مجوز نوشتن کد ندارد.
- Run ناموفق به Task موفق تبدیل نمی‌شود. مراحل تکمیل‌شده و مصرف ثبت‌شده هنگام خطا حفظ می‌شوند.
- Retry یک زیرتسک Autonomous/Workflow، تسک مالک را دوباره صف‌بندی می‌کند؛ زیرتسک بدون context روی شاخهٔ مستقل رها نمی‌شود. پاسخ API شامل `taskId` واقعی و `requestedTaskId` اولیه است. این عمل تکرار کل اجرای مالک است، نه صرفاً تکرار تست.
- درخواست Run تکراری با خطای 409 پاسخ می‌گیرد؛ حتی اگر تسک لغو شده ولی اجرای قبلی هنوز در حال خاتمه باشد. این کنترل جلوی پاک شدن علامت لغو و ادامهٔ ناخواستهٔ اجرای قبلی را می‌گیرد.
- لغو/حذف والد، انتظار Approval فرزندان را فوراً خاتمه می‌دهد. waiter قبل از انتشار اعلان نصب می‌شود تا تصمیم سریع کاربر گم نشود. رد Approval شکست نهایی است، نه انتظار دائمی.
- تحویل job از SQLite با یک `UPDATE … RETURNING` اتمیک انجام می‌شود؛ دو worker نمی‌توانند یک ردیف را در شکاف SELECT/UPDATE هر دو claim کنند.
- اتمام بودجه، رد عملیات، QA تأییدنشده و پایان تعداد تلاش اصلاح، با retry کورکورانهٔ صف دور زده نمی‌شوند. بعد از اصلاح تنظیمات یا بررسی نتیجه، Retry دستی ممکن است.
- ابزار خارج از Toolbox، بدون permission ایجنت، یا با منع صریح در permission پروژه اجرا نمی‌شود. ابزار خطرناک بدون کانال Approval رد می‌شود. **برای استفادهٔ واقعی، Auto-approve را در Settings خاموش کنید**؛ سیاست پیش‌فرض توسعه همچنان برای دمو خودکار است.

## تست تغییرات

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

تست‌های `request-pipeline.test.ts`، `skill-assignment.test.ts`، `agent-implementation.test.ts`، `agent-github-contract.test.ts`، `workflow-engine.test.ts` و `task-execution-ownership.test.ts` شامل مدل‌های پاسخ‌ساختگی و adapterهای HTTP کنترل‌شده‌اند: routing، fallback، budget، حفظ فایل، commit اتمیک، انتقال بک‌اند→فرانت‌اند، multi-repo، اصلاح روی همان شاخه، لغو، خطای شبکه، SHA صحیح CI، اتصال OAuth، چرخه و join گراف، شرط‌ها، انتقال خروجی، لغو Approval و رقابت claim صف. اجرای تست‌ها هیچ کدی را به مخزن واقعی push نمی‌کند و به کلید پولی مدل نیاز ندارد.

مسیر sandbox/import هم تست اختصاصی دارد (بدون نیاز به Docker daemon یا باینری 7z — اجراکننده تزریق می‌شود):

```bash
npx vitest run src/tests/sandbox-runner.test.ts src/tests/project-archive.test.ts \
  src/tests/rar-archive.test.ts src/tests/project-import-routes.test.ts src/tests/env-contract-sandbox.test.ts
```

پوشش: دستورهای هر مرحله، پرچم‌های سخت‌سازی Docker، شبکهٔ بسته/باز، پاک‌سازی workspace، نگاشت `passed`/`failed`/`unverified`، استفاده از CI برای پروژه‌های GitHub و شکست سخت (بدون اجرای میزبان) برای پروژهٔ local بدون Docker، رد traversal/symlink/CRC/zip-bomb در ZIP، پروتکل listing/streaming در RAR، و زنجیرهٔ کامل `POST /projects/import` → مخزن محلی + commit اولیه + حذف فایل حساس.
