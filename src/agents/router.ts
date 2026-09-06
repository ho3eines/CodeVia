import type { AgentType } from "../domain/entities.js";

/**
 * Agent Router — decides which agent should handle a given (task|error) based on
 * the problem domain. This is the backbone of Autonomous Error Routing and task
 * routing within a project.
 */
export class AgentRouter {
  /** Map a task/error description to the most appropriate agent type. */
  route(problem: string, mode: "error" | "task" = "task"): AgentType {
    const text = problem.toLowerCase();
    const map: Array<[RegExp, AgentType]> = [
      [/ui|ux|frontend|front-end|component|style|css|responsive|accessib|page|layout|mobile|رابط|ظاهر|فرانت|صفحه|کامپوننت|استایل|ریسپانسیو|موبایل/, "uiux"],
      [/debug|fix|bug|error|exception|crash|throw|broken|failing|خطا|ارور|باگ|خراب|رفع|دیباگ|کرش|مشکل/, "debugging"],
      [/database|sql|migration|schema|query|db\b|دیتابیس|پایگاه\s*داده|اسکیما|مایگریشن|کوئری|جدول/, "database"],
      [/test|fail|regression|coverage|spec|unit test|e2e|تست|آزمون|کیو\s*ای|رگرسیون|کاورج|ناموفق/, "qa-test"],
      [/security|vulnerab|injection|csrf|xss|secret|oauth|authn|authz|امنیت|آسیب|توکن|سکرت|احراز|مجوز|نفوذ/, "security"],
      [/performance|slow|latency|bottleneck|optimiz|memory leak|کارایی|پرفورمنس|کند|سرعت|بهینه|حافظه/, "performance"],
      [/deploy|docker|ci|cd|pipeline|railway|release|build fail|دیپلوی|داکر|رایلوِی|ریلیز|بیلد|پایپ\s*لاین/, "devops"],
      [/architecture|boundaries|layering|ddd|bounded context|high-level design|معماری|ساختار|لایه|طراحی\s*سیستم/, "system-architect"],
      [/api|controller|service|backend|back-end|handler|endpoint|login|auth|بک\s*اند|بکند|سرور|سرویس|کنترلر|ای\s*پی\s*آی|لاگین|ورود/, "backend-developer"],
      [/document|readme|docs|changelog|مستند|داکیومنت|راهنما|تغییرات/, "documentation"],
      [/review|pr |pull request|code quality|بازبینی|کد\s*ریویو|پول\s*ریکوئست|کیفیت/, "code-reviewer"],
      [/refactor|clean|dead code|duplication|ریفکتور|تمیز|تکرار|بازسازی/, "refactoring"],
      [/research|feasib|best practice|compare|landscape|options|تحقیق|بررسی|مقایسه|بهترین\s*روش|امکان\s*سنجی/, "research"],
      [/require|business|acceptance|story|scope|نیازمندی|بیزینس|کسب\s*و\s*کار|سناریو|اسکوپ/, "business-analyst"],
    ];
    for (const [re, type] of map) {
      if (re.test(text)) return type;
    }
    return mode === "error" ? "debugging" : "backend-developer";
  }
}

export const agentRouter = new AgentRouter();
