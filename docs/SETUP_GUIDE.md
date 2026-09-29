# راهنمای کامل راه‌اندازی CodeVia

این سند، راه‌اندازی عملی CodeVia از محیط توسعه تا اجرای اولین کار خودکار روی یک مخزن واقعی را توضیح می‌دهد.

> **نسخه و دقت:** این راهنما بر اساس فایل‌های پیکربندی و مستندات همین مخزن نوشته شده است.

## نقشه راه سریع

1. [پیش‌نیازها](#۱-پیشنیازها)
2. [راه‌اندازی محلی](#۲-راهاندازی-محلی)
3. [اتصال Provider واقعی (OpenAI)](#۳-اتصال-provider-واقعی)
4. [راه‌اندازی GitHub OAuth](#۴-راهاندازی-github-oauth)
5. [راه‌اندازی ربات Telegram](#۵-راهاندازی-ربات-telegram)
6. [استقرار روی Railway](#۶-استقرار-روی-railway)
7. [استقرار با Docker](#۷-استقرار-با-docker)
8. [اولین پروژه و Task خودکار](#۸-اولین-پروژه-و-task-خودکار)
9. [عیب‌یابی](#۹-عیبیابی)

---

## ۱. پیش‌نیازها

| ابزار | نسخه |
|---|---|
| Node.js | **۲۲+** (الزامی برای `node:sqlite`) |
| npm | همراه Node |
| Git | برای clone و آینه read-only |
| Docker | فقط برای روش Docker |

```bash
node --version   # باید v22.x یا بالاتر باشد
npm --version
git --version
```

برای حالت محلی هیچ کلید API لازم نیست: CodeVia با **Mock AI + Mock GitHub + Mock Telegram** بالا می‌آید.

---

## ۲. راه‌اندازی محلی

```bash
git clone https://github.com/ho3eines/CodeVia.git
cd CodeVia
npm install
cp .env.example .env
```

حداقل `.env` برای شروع:

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=8080
DATABASE_PATH=./data/codevia.db
WEB_BASE_URL=http://localhost:8080
ENABLE_SIMULATION_MODE=true
MOCK_AI_DEFAULT=true
GITHUB_ENABLED=false
TELEGRAM_MODE=off
```

```bash
npm run dev
# http://localhost:8080
```

برای بررسی سلامت:
```bash
curl -i http://localhost:8080/health
```

---

## ۳. اتصال Provider واقعی

**بدون Provider واقعی، ایجنت‌ها فقط Mock تولید می‌کنن و هیچ کد واقعی نمی‌نویسن.**

### ۳.۱ گرفتن کلید OpenAI

1. وارد [platform.openai.com](https://platform.openai.com) شوید
2. API Keys → Create new secret key
3. کلید را ذخیره کنید (فقط یک‌بار نشان داده می‌شود)
4. مطمئن شوید billing/اعتبار فعال است

### ۳.۲ تنظیم در `.env`

```dotenv
OPENAI_API_KEY=sk-REPLACE_WITH_YOUR_KEY
ENABLE_SIMULATION_MODE=false
MOCK_AI_DEFAULT=false
```

سرویس را restart کنید.

### ۳.۳ ثبت Provider در CodeVia

1. **Settings → Providers → Add Provider**
2. Type: `openai`
3. Base URL: `https://api.openai.com/v1`
4. Secret Ref: `OPENAI_API_KEY` (نام متغیر، نه خود کلید)
5. **Test connection** → باید OK بدهد
6. Save و Activate

### ۳.۴ ثبت Model

1. **Settings → Models → Add Model**
2. Provider: OpenAI
3. Model ID: `gpt-4o` (یا مدل دلخواه)
4. **Test model** → باید پاسخ واقعی بدهد
5. Active کنید و به agent ها assign کنید

### ۳.۵ بنچمارک (توصیه)

از صفحه Models، دکمه **🧪 Benchmark all models** را بزنید تا سیستم بهترین مدل را بر اساس دقت/سرعت/هزینه انتخاب کند.

---

## ۴. راه‌اندازی GitHub OAuth

### ۴.۱ ساخت OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New
2. برای محلی:
   - Homepage: `http://localhost:8080`
   - Callback: `http://localhost:8080/auth/github/callback`
3. Client ID و Client Secret را کپی کنید

### ۴.۲ تنظیم `.env`

```dotenv
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_OAUTH_CALLBACK_URL=http://localhost:8080/auth/github/callback
AUTH_SECRET=یک-رشته-تصادفی-۳۲-کاراکتری
GITHUB_OAUTH_SCOPE=repo read:user user:email
REQUIRE_AUTH=false
```

### ۴.۳ ورود

1. Restart سرویس
2. در UI → `#/github` → Login with GitHub
3. مجوزها را تأیید کنید
4. حالا می‌تونید ریپوهای خودتان را ببینید و پروژه بسازید

> **نکته:** `repo` scope برای private repo لازمه. `GITHUB_CLIENT_SECRET` برای OAuth login هست، `GITHUB_TOKEN` برای API server-wide.

---

## ۵. راه‌اندازی ربات Telegram

### ۵.۱ ساخت Bot

1. به `@BotFather` پیام دهید → `/newbot`
2. Token را کپی کنید

### ۵.۲ تنظیم

```dotenv
TELEGRAM_BOT_TOKEN=123456789:YOUR_TOKEN
TELEGRAM_MODE=polling
```

بعد از restart، در Telegram `/start` و `/ping` بفرستید.

---

## ۶. استقرار روی Railway

1. **New Project → Deploy from GitHub** → ریپو CodeVia
2. Variables را تنظیم کنید:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
DATABASE_PATH=/app/data/codevia.db
OPENAI_API_KEY=sk-...
MOCK_AI_DEFAULT=false
ENABLE_SIMULATION_MODE=false
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_OAUTH_CALLBACK_URL=https://YOUR-APP.up.railway.app/auth/github/callback
AUTH_SECRET=...
REQUIRE_AUTH=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_MODE=auto
PUBLIC_WEB_BASE_URL=https://YOUR-APP.up.railway.app
```

3. **Volume اضافه کنید** → Mount: `/app/data` (بدون volume، DB بعد از deploy پاک میشه)
4. Domain بسازید و callback OAuth را اصلاح کنید
5. **Start command را تغییر ندهید** (`docker-entrypoint.sh` لازمه)

---

## ۷. استقرار با Docker

```bash
cp .env.example .env
# .env را ویرایش کنید

docker compose up --build -d
docker compose logs -f codevia-web
```

یا مستقیم:
```bash
docker build -t codevia-platform .
docker volume create codevia-data
docker run -d --name codevia-web --env-file .env \
  -e DATABASE_PATH=/app/data/codevia.db \
  -p 8080:8080 -v codevia-data:/app/data \
  codevia-platform
```

---

## ۸. اولین پروژه و Task خودکار

### پیش‌نیاز: CI در ریپوی هدف

CodeVia خودش `npm test` اجرا نمی‌کنه. فقط **GitHub Actions checks** رو می‌خونه. پس ریپوی هدف باید CI داشته باشه:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run build
```

### ساخت پروژه

1. Login با GitHub
2. Projects → Create → ریپو و branch انتخاب کنید
3. بنر **Repository context: available** باید دیده بشه

### اجرای Task

1. Project → Chat/Ask AI
2. درخواست بنویسید، مثلاً:

```text
endpoint health موجود را بررسی کن. اگر تست برای پاسخ 200 وجود ندارد،
یک تست اضافه کن و Draft PR بساز. روی main مستقیم commit نکن.
```

3. حالت Autonomous انتخاب کنید
4. در Run Console پیشرفت رو ببینید
5. CodeVia شاخه `agent-task-<id>` می‌سازه، commit اتمیک می‌زنه و Draft PR باز می‌کنه
6. **Merge تصمیم انسانیه** — CodeVia خودکار merge نمی‌کنه

### معنی verification

| وضعیت | معنی |
|---|---|
| `passed` | CI checks موفق |
| `failed` | CI واقعاً شکست خورده |
| `unverified` | CI نداره یا pending |
| `simulated` | Mock بوده، تست واقعی نشده |

---

## ۹. عیب‌یابی

| مشکل | راه‌حل |
|---|---|
| `node:sqlite` خطا | Node 22+ نصب کنید |
| Provider inactive | کلید در `.env` + restart + Test connection |
| GitHub 404 | scope `repo` برای private لازمه |
| `redirect_uri_mismatch` | callback URL باید **دقیقاً** یکسان باشه |
| DB بعد deploy پاک میشه | Volume روی `/app/data` اضافه کنید |
| Chat میگه ریپو رو نمیبینه | branch اشتباه یا token scope |
| QA همیشه unverified | ریپوی هدف GitHub Actions نداره |
| Mock output (هزینه ۰) | `MOCK_AI_DEFAULT=false` + model واقعی active |

برای جزئیات بیشتر: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## ۱۰. چک‌لیست نهایی

- [ ] Node 22+ نصب شده
- [ ] Provider واقعی (OpenAI/Anthropic) فعال و Test موفق
- [ ] حداقل یک Model فعال و assign شده
- [ ] GitHub OAuth ستاپ و login موفق
- [ ] ریپوی هدف GitHub Actions دارد
- [ ] `ENABLE_SIMULATION_MODE=false`
- [ ] Volume پایدار برای DB (Railway/Docker)
- [ ] Approval policy برای production فعال
