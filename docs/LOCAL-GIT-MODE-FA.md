# راهنمای فارسی — اجرای ۱۰۰٪ لوکال CodeVia با Git سیستم (LocalGitService)

این سند خلاصه‌ی فارسی‌ی `docs/LOCAL-GIT-MODE.md` است.

## چی شد؟

هر سه لایه‌ی قبلی (سرویس، قرارداد خطا، تست‌ها) پیاده‌سازی و **واقعاً اجرا** شدند — نه فقط نوشته شدند:

- **۱۰۱۵ تست** کل پروژه پاس شد (فقط ۱ خطای از‌قبل‌موجود در `app-assembly` که روی نسخه‌ی دست‌نخورده‌ی ریپوی گیت‌هاب هم دقیقاً همین خطاست).
- **۹۵ تست جدید** مخصوص LocalGit — همه پاس.
- **Typecheck و ESLint** پاک.
- **تست انتها-به-انتهای کامل** با سرور واقعی (بوت در حالت لوکال → ساخت پروژه → ثبت memory → کامیت واقعی `[CodeVia] update memory [skip ci]` در ریپوی لوکال → `repo-status: healthy`).

## نکته‌ی مهم برای اولین اتصال یک ریپو (bootstrap)

- ریپویی که **از قبل state معتبر دارد** (پوشه‌ی `CodeVia/` کامل): ساخت پروژه بدون هیچ مدلی انجام می‌شود؛ خواندن و نوشتن state مستقیم با گیت لوکال کار می‌کند (در e2e تأیید شد).
- ریپوی **بدون** `CodeVia/`: پلتفرم برای تولید اولیه‌ی state به یک **مدل واقعی** نیاز دارد (Ollama لوکال، OpenRouter، OpenAI، ...). این محافظت عمدی است: روی ریپوی واقعی (لوکال یا GitHub) هرگز state‌ی شبیه‌سازی‌شده نوشته نمی‌شود.
- راه میان‌بر بدون مدل (قدیمی): یک‌بار پلتفرم را با `MOCK_GITHUB_PATH` و بدون `LOCAL_GIT_MODE` بالا بیاورید، یک پروژه‌ی demo بسازید تا state معتبر تولید شود، سپس پوشه‌ی `CodeVia/` آن را در ریپوی لوکال‌تان کپی کنید (فقط مقدار `repo` در frontmatter را اصلاح کنید).

## بسازوقتی خودکار: پروژه‌ی جدید، ریپوی خالی و شاخه‌ی اشتباه (جدید)

از این نسخه، سه حالت که قبلاً با خطای «branch main is unavailable» شکست می‌خوردند، خودکار مدیریت می‌شوند:

1. **پروژه‌ی جدید روی پوشه‌ای که هنوز وجود ندارد یا `git init` نشده:** اولین نوشتنِ CodeVia خودش پوشه را در مسیر استاندارد `LOCAL_REPOS_DIR/<owner>/<name>` می‌سازد و `git init` می‌کند (خواندن‌ها هرگز ریپو نمی‌سازند — فقط نوشتن).
2. **ریپوی تازه‌ی `git init` شده (بدون هیچ commit):** یک commit ریشه (root commit) با `README.md` ساخته می‌شود تا bootstrap state روی آن ادامه پیدا کند؛ nothing-to-lose است و چیزی بازنویسی نمی‌شود.
3. **شاخه‌ی master یا هر شاخه‌ی پیش‌فرضِ دیگر:** اگر پروژه روی `main` تنظیم شده ولی ریپو مثلاً `master` است، پروژه یک‌بار شاخه‌ی پیش‌فرضِ واقعی ریپو را **اختیار می‌کند** (adoption) و کار ادامه پیدا می‌کند — دیگر ساخت پروژه روی ریپوی لوکالِ سالم شکست نمی‌خورد. این adoption فقط وقتی شاخه‌ی تنظیم‌شده وجود نداشته باشد رخ می‌دهد.

## ایمپورت state از فایل زیپ (بدون مدل) — `POST /projects/:id/state-import`

اگر مدل واقعی تنظیم نکرده‌اید و state ندارید، به‌جای کپی دستی پوشه، فایل زیپ را به API بدهید:

```bash
# archive = base64 یک zip که پوشه‌ی CodeVia/ داخل آن است (ریشه‌ی زیپ یا داخل یک پوشه — خروجی Download ZIP گیت‌هاب هم قبول است)
curl -X POST http://localhost:3000/projects/<ID>/state-import \
  -H 'content-type: application/json' \
  --data "{"archive": "$(base64 -w0 codevia-state.zip)"}"
```

- فقط مسیرهای `CodeVia/**` وارد می‌شوند؛ بقیه‌ی فایل‌های زیپ نادیده گرفته می‌شوند.
- سقف‌ها مثل commit های state است: هر فایل ≤ ۸MB، مجموع ≤ ۳۲MB، حداکثر ۲۰۰ فایل؛ ورودی رمزگذاری‌شده و مسیرهای `../` (zip-slip) رد می‌شوند.
- فایل‌های موجودِ ریپو حذف نمی‌شوند؛ فقط همان مسیرها بازنویسی می‌شوند و بعد از commit، تعریف‌ها بلافاصله load می‌شوند.
- جریان کاملِ «مدل ندارم»: ساخت پروژه خطای ۴۲۲ می‌دهد ولی پروژه و ریپو (با seed اولیه) ساخته شده‌اند → همین endpoint را صدا بزنید.

## فایل‌های جدید/تغییر یافته

| فایل | توضیح |
| --- | --- |
| `src/github/local-git-error.ts` | **جدید** — قرارداد خطا: `LocalGitError` با ۱۱ کد پایدار، statusCode، retryable، committed |
| `src/github/local-git-service.ts` | **جدید** — سرویس کامل لوکال با plumbing گیت (بدون worktree، با CAS) |
| `src/github/registry.ts` | ویرایش — فعال‌سازی حالت لوکال؛ `source: "user-oauth"` تا گاردهای no-token فعال نشوند |
| `src/github/repo-mirror.ts` | ویرایش — در حالت لوکال، mirror خودکار خاموش است (ریپوها همین‌جا روی دیسکند) |
| `src/http/routes/projects.ts` | ویرایش — در حالت لوکال، `requiredChecks` از `codevia-ci.yml` پر نمی‌شود (Actions وجود ندارد) |
| `src/tests/local-git-*.test.ts` | **۴ فایل جدید** — قرارداد خطا (۱۳)، سازگاری (۳۱)، property-based (۴۰)، خرابی/بازیابی (۹) |
| `.env.example` | بخش `LOCAL_GIT_*` اضافه شد |
| `docs/LOCAL-GIT-MODE.md` | سند انگلیسی |
| `src/github/state-archive.ts` | **جدید** — خواننده‌ی zip بدون وابستگی جدید (store/deflate، رد zip-slip/رمز، سقف‌های سایز) |
| `src/tests/state-archive.test.ts` | **جدید** — ۱۲ تستِ خواننده/فیلتر زیپ |
| `src/tests/local-git-bootstrap.test.ts` | **جدید** — ۱۰ تست: init خودکار، root commit، adoption شاخه، e2e کاملِ ساخت پروژه و ایمپورت زیپ |

## راه‌اندازی روی سیستم خودت (ویندوز)

۱. این فایل‌ها را در ریپوی لوکال CodeVia کپی کن (ساختار پوشه‌ها یکی است).

۲. فایل `.env` در ریشه:

```env
LOCAL_GIT_MODE=true
LOCAL_REPOS_DIR=D:/Hermes/repos     # پوشه‌ای که پروژه‌های گیت لوکالت داخلش است
LOCAL_GIT_AUTO_PUSH=true            # اگر ریموت داری؛ کاملاً آفلاین می‌خواهی → false
LOCAL_GIT_OWNER=local
# LOCAL_GIT_VERIFY_CMD=dotnet test  # اختیاری: تست واقعی به‌جای GitHub Actions
```

۳. اجرا:

```bash
npm install
npm run build
npm start          # یا: npm run dev
```

۴. در UI، ریپازیتوری‌های داخل `D:/Hermes/repos` (با ساختار `owner/repo` یا تخت) دیده می‌شوند. **هیچ توکن/OAuth لازم نیست.**

## چرا این نسخه کم‌مشکل‌ترین است؟ (رفع موارد P0/P1 قبلی)

| مشکل قبلی | وضعیت |
| --- | --- |
| متادیتای خراب → پاک‌شدن بی‌صدا PRها (سناریو E) | ✅ خطای `LOCAL_META_CORRUPT`، بدون overwrite، با نسخه‌ی `.bak` |
| خطای sync نادیده گرفته می‌شد (سناریو C) | ✅ خطای `committed: true` + sha؛ ترمیم خودکار در کامیت بعدی همان مسیر |
| باینری git پیدا نمی‌شد → خطای گمراه‌کننده (D) | ✅ بررسی هنگام اولین فراخوانی → `LOCAL_GIT_UNAVAILABLE` با پیام روشن |
| قفل stale مانع همه‌ی کامیت‌ها می‌شد (B) | ✅ قفل قدیمی‌تر از ۱۰ دقیقه حذف و عملیات retry می‌شود؛ قفل تازه → `LOCAL_LOCKED` |
| read-tree ایندکس کاربر را پاک می‌کرد (P0) | ✅ ایندکس واقعی هرگز دست نمی‌خورد؛ کامیت در temp index ساخته می‌شود؛ فقط مسیرهای تغییریافته sync می‌شوند و فایل dirty هرگز بازنویسی نمی‌شود (تست H) |
| Checks ساختگی همیشه success (P0) | ✅ فقط `local-git-integrity` (واقعی: وجود کامیت در object DB) + `local-verify` با اجرای واقعی `LOCAL_GIT_VERIFY_CMD` |
| worktreeهای مانده بعد از کرش (G) | ✅ اصلاً worktree ساخته نمی‌شود (merge-tree plumbing) |

## سه رفعِ اضافه در بازبینی نهایی (نکاتی که در پیام‌های قبلی فراموش شده بود)

- **Race condition متادیتا**: `createPullRequest` / `updatePullRequest` / `createIssue` / `commentOn*` و `mergePullRequest` حالا همه‌ی عملیات read-modify-write روی `codevia-local-meta.json` را زیر قفل repo انجام می‌دهند — قبلاً merge همزمان با ساخت PR می‌توانست نوشته‌ی یکی را بی‌صدا پاک کند (تست I این را قفل کرده است).
- **سرریز argv ویندوز**: کامیت‌های حجیم (صدها فایل) حالا batch می‌شوند (تست J: کامیت ۲۰۰ فایلی) — قبلاً در ویندوز ممکن بود با خطای E2BIG شکست بخورد.
- **پیام خطای 404 در project-state**: در حالت لوکال دیگر نمی‌گوید «حساب GitHub را دوباره وصل کن»، بلکه مسیر `LOCAL_REPOS_DIR` و وجود ریپو را راهنمایی می‌کند.

## نکته‌ها

- کامیت‌ها **بایت‌به‌بایت** (بدون فیلتر CRLF) ذخیره می‌شوند — دقیقاً مثل GitHub Contents API؛ نردبان EOL موتور patch خودش را اعمال می‌کند.
- چون سرویس `kind: "real"` است، برای کامیت واقعی کد باید یک مدل واقعی (Ollama/OpenRouter/...) فعال باشد — کدهای Simulation روی ریپوی واقعی لوکالت کامیت نمی‌شوند.
- PR و Issue در `<repo>/.git/codevia-local-meta.json` ذخیره می‌شوند (داخل `.git`، پس در working tree دیده نمی‌شوند و با clone ریموت منتقل نمی‌شوند).
- جستجوی **مسیر فایل‌ها** و حافظه در حالت لوکال کار می‌کند؛ جستجوی **محتوای** فایل‌ها (git grep) به mirror نیاز دارد که در حالت لوکال پیش‌فرض خاموش است (بدون خطا رد می‌شود). اگر می‌خواهید فعال باشد: `REPO_MIRROR_ENABLED=true` و `REPO_MIRROR_URL_TEMPLATE=file:///D:/Hermes/repos/{repo}` با چیدمان `owner/repo`.
- گیت **2.38+** لازم است (برای `merge-tree --write-tree`)؛ گیت قدیمی‌تر به fallback با worktree موقت (همیشه پاک‌شونده) می‌رود.

## اجرای تست‌ها

```bash
npx vitest run src/tests/local-git-error.test.ts src/tests/local-git-service.compat.test.ts src/tests/local-git-service.property.test.ts src/tests/local-git-service.failure.test.ts
```

نتیجه‌ی واقعی این اجرا (git 2.47.3، Node 22):

```
Test Files  4 passed (4)
     Tests  95 passed (95)
```

و کل مجموعه‌ی پروژه: **۱۰۱۵ تست پاس، ۱ خطای از‌قبل‌موجودِ خود ریپوی بالادستی** (`app-assembly` — روی کلون دست‌نخورده‌ی github.com/ho3eines/CodeVia هم دقیقاً همان خطا fail می‌شود؛ فایل `public/app.js` بایت‌به‌بایت با بالادستی یکسان است).
