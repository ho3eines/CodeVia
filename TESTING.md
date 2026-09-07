# راهنمای تست CodeVia

سوئیت تست و سناریوی Mock بدون کلید API کار می‌کنند. موفقیت این سناریو به معنی اجرای build/test واقعی پروژهٔ مقصد نیست؛ خروجی آن `verification: simulated` است. برای منطق اجرای واقعی و تنظیم CI، [راهنمای ایجنت‌ها](docs/AGENT_EXECUTION.md) را ببینید.

## ۱) تست تک‌دستوری (پیشنهاد اول)

```bash
npm install
npm run smoke
```

این اسکریپت سرور را روی پورت ایزوله با دیتابیس موقت بالا می‌آورد و **۳۳ چک** را اجرا می‌کند:

- بوت سرور + سلامت (`/health`) + سرو UI
- ساخت پروژه با انتخاب‌های تعریف (پلتفرم، زبان، فریم‌ورک، دیتابیس، دیپلوی، فیچر، اینتگریشن)
- ساخته شدن پرامپت ریسرچ از روی انتخاب‌ها
- ساخته شدن پوشه `CodeVia/` در گیت (`project.md`، `agents/`، `skills.md`، `memory.md`)
- حلقه خودگردان: ریسرچ → بک‌اند + فرانت‌اند → QA (همه موفق)
- ذخیره research brief روی تسک والد + وظیفه صریح هر واحد
- کامیت + PR + حافظه در گیت
- سینک فایل‌های تسک + Pull از گیت
- **ری‌استارت سرور بدون re-onboard**: فایل‌ها و تاریخچه سر جاشان می‌مانند
- **تداوم:** مرج PR، بعد تسک دوم روی همان موجودیت → فایل قبلی extend می‌شود (بازنویسی نه) + `CodeVia/context.md`

خروجی موفق:

```
🎉 SMOKE PASSED — 33/33 checks
```

## ۲) تست واحد و یکپارچه

```bash
npm test          # کل سوئیت vitest (۴۶۲ تست)
npm run typecheck # تایپ‌چک TypeScript
```

## ۳) تست دستی با UI (مرورگر)

```bash
npm run dev
# باز کن: http://localhost:8080
```

قدم‌به‌قدم:

1. **ساخت پروژه:** Projects → New Project → اسم + ریپو (مثلاً `demo/shop`) → انتخاب‌ها را پر کن (Web، C#، .NET، SQL Server، Docker، auth، telegram) → Create.
2. **پرامپت از روی انتخاب‌ها:** وارد پروژه شو → Agents → روی Research کلیک کن → ببین همه انتخاب‌ها توی System Prompt هست.
3. **پوشه پروژه در گیت:** تب Commits را ببین (کامیت‌های `[CodeVia]`) — یا با API:
   ```bash
   curl 'http://localhost:8080/projects/<id>/files?path=CodeVia'
   curl 'http://localhost:8080/projects/<id>/file?path=CodeVia/project.md'
   ```
4. **حلقه خودگردان:** Ask AI → حالت `Autonomous task loop` (پیش‌فرض) → بنویس «Add login page and API» → Start. فلو گیت‌ـمحور است: اول از گیت سینک می‌کند (ایجنت‌ها/حافظه/تعریف — نه تسک‌های زنده)، بعد روی همان فایل‌ها تغییر می‌زند (فقط بخش‌های ناموجود ساخته می‌شوند)، کامیت می‌کند و آخر دوباره به گیت سینک می‌کند.
5. **تسک‌بندی:** تب Tasks → زیر تسک والد ساب‌تسک‌ها را با بج `↳ sub` ببین (Research، Implement backend/frontend، Verify).
6. **جزئیات تسک:** View روی تسک والد → research brief + جدول ساب‌تسک‌ها + وضعیت هر واحد.
7. **گیت:** تب‌های Commits و Pull Requests — مجری‌ها در هر مخزن روی شاخهٔ مشترک تسک (`agent-task-<id>`) کار می‌کنند و یک Draft PR تحویل می‌دهند. در Mock، خروجی scaffold/TODO است؛ با مدل واقعی، فایل جدید یا patch فایل موجود ساخته می‌شود. در حالت واقعی، ابتدا CI و review انسانی را بررسی کنید و Draft را آماده کنید؛ سپس Merge کنید.
8. **حافظه:** تب Memory — یافته‌های ریسرچ و QA اینجاست (و در `CodeVia/memory.md`).
9. **زمینه پروژه (context):** بعد از هر تسک خودگردان، فایل `CodeVia/context.md` معماری + رجیستری موجودیت‌ها را دارد:
   ```bash
   curl 'http://localhost:8080/projects/<id>/file?path=CodeVia/context.md'
   ```
10. **تداوم (عدم فراموشی):** PR بک‌اند را Merge کن، بعد یه تسک دوم روی همان موضوع بزن (مثلاً «Add login rate limiting») → فایل قبلی در Mock با TODOهای جدید **extend** می‌شود؛ مدل واقعی patch دقیق روی همان فایل می‌دهد و سایر بخش‌ها را نگه می‌دارد.
11. **Pull:** دکمه `⬇ Pull from GitHub` در هدر پروژه → بازیابی ایجنت‌ها/تسک‌ها/حافظه از گیت.
10. **ویرایش تعریف:** Edit → Capabilities → یه فیچر اضافه کن → Save → پرامپت ایجنت‌ها خودکار تازه می‌شود.

## ۴) تست با AI واقعی (اختیاری)

1. صفحه Providers → فعال‌سازی OpenAI/Anthropic/Gemini + کلید + فعال کردن یک مدل.
2. دوباره Ask AI بزن — این بار شکستن کار (breakdown)، تحلیل ریسرچ و محتوای فایل‌ها را خود مدل تولید می‌کند.
3. بدون کلید، مسیر شبیه‌سازی روی Mock GitHub فعال است؛ روی GitHub واقعی بدون مدل واقعی تولید کد انجام نمی‌شود.

## ۵) سناریوهای آماده برای تست دستی

| سناریو | ورودی Ask | انتظار |
|---|---|---|
| UI | Add login page and API | بک‌اند + فرانت‌اند + QA |
| فقط بک‌اند | Add session expiry to the auth API | فقط بک‌اند + QA |
| دیتابیس | Add user sessions table migration | بک‌اند + دیتابیس + QA |
| فارسی | راست‌چین کردن صفحه ورود | بک‌اند + فرانت‌اند + QA |

## عیب‌یابی

| مشکل | راه‌حل |
|---|---|
| پورت اشغال است | `PORT=8081 npm run dev` (یا برای smoke: `SMOKE_PORT=18081 npm run smoke`) |
| `tsx: not found` | `npm install` |
| دیتابیس قفل/خراب | `rm -rf data/` (دوباره ساخته می‌شود؛ mock گیت‌هاب هم از اول seed می‌شود) |
| تست‌ها کندند | طبیعی است (~۶۰ ثانیه)؛ برای یک فایل: `npx vitest run src/tests/<file>` |
