# راهنمای تست CodeVia

همه‌چیز بدون کلید API و بدون اینترنت کار می‌کند (Mock AI + Mock GitHub). با یک دستور کل محصول end-to-end تست می‌شود.

## ۱) تست تک‌دستوری (پیشنهاد اول)

```bash
npm install
npm run smoke
```

این اسکریپت سرور را روی پورت ایزوله با دیتابیس موقت بالا می‌آورد و **۲۶ چک** را اجرا می‌کند:

- بوت سرور + سلامت (`/health`) + سرو UI
- ساخت پروژه با انتخاب‌های تعریف (پلتفرم، زبان، فریم‌ورک، دیتابیس، دیپلوی، فیچر، اینتگریشن)
- ساخته شدن پرامپت ریسرچ از روی انتخاب‌ها
- ساخته شدن پوشه `CodeVia/` در گیت (`project.md`، `agents/`، `skills.md`، `memory.md`)
- حلقه خودگردان: ریسرچ → بک‌اند + فرانت‌اند → QA (همه موفق)
- ذخیره research brief روی تسک والد + وظیفه صریح هر واحد
- کامیت + PR + حافظه در گیت
- سینک فایل‌های تسک + Pull از گیت
- **ری‌استارت سرور بدون re-onboard**: فایل‌ها و تاریخچه سر جاشان می‌مانند

خروجی موفق:

```
🎉 SMOKE PASSED — 26/26 checks
```

## ۲) تست واحد و یکپارچه

```bash
npm test          # کل سوئیت vitest (~۶۰ ثانیه، ۳۴۰ تست)
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
4. **حلقه خودگردان:** Ask AI → حالت `Autonomous task loop` (پیش‌فرض) → بنویس «Add login page and API» → Start.
5. **تسک‌بندی:** تب Tasks → زیر تسک والد ساب‌تسک‌ها را با بج `↳ sub` ببین (Research، Implement backend/frontend، Verify).
6. **جزئیات تسک:** View روی تسک والد → research brief + جدول ساب‌تسک‌ها + وضعیت هر واحد.
7. **گیت:** تب‌های Commits و Pull Requests — هر مجری روی برنچ خودش (`agent-<نقش>-<id>`) کد واقعی (اسکافلد معتبر در استک پروژه، مثلاً `LoginController.cs` یا `LoginPage.tsx`) + یادداشت تغییر کامیت می‌کند و PR باز می‌کند. با دکمه **Merge** کد را به main بیاور.
8. **حافظه:** تب Memory — یافته‌های ریسرچ و QA اینجاست (و در `CodeVia/memory.md`).
9. **Pull:** دکمه `⬇ Pull from GitHub` در هدر پروژه → بازیابی ایجنت‌ها/تسک‌ها/حافظه از گیت.
10. **ویرایش تعریف:** Edit → Capabilities → یه فیچر اضافه کن → Save → پرامپت ایجنت‌ها خودکار تازه می‌شود.

## ۴) تست با AI واقعی (اختیاری)

1. صفحه Providers → فعال‌سازی OpenAI/Anthropic/Gemini + کلید + فعال کردن یک مدل.
2. دوباره Ask AI بزن — این بار شکستن کار (breakdown)، تحلیل ریسرچ و محتوای فایل‌ها را خود مدل تولید می‌کند.
3. بدون کلید، همه‌چیز قطعی (deterministic) ولی کامل کار می‌کند — فقط «فکر کردنش» قالبی است.

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
