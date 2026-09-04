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
      [/ui|ux|frontend|component|style|css|responsive|accessib|page|layout|mobile/, "uiux"],
      [/debug|fix|bug|error|exception|crash|throw|broken|failing/, "debugging"],
      [/database|sql|migration|schema|query|db\b/, "database"],
      [/security|vulnerab|injection|csrf|xss|secret|oauth|authn|authz/, "security"],
      [/test|fail|regression|coverage|spec|unit test|e2e/, "qa-test"],
      [/performance|slow|latency|bottleneck|optimiz|memory leak/, "performance"],
      [/deploy|docker|ci|cd|pipeline|railway|release|build fail/, "devops"],
      [/architecture|boundaries|layering|ddd|bounded context|high-level design/, "system-architect"],
      [/api|controller|service|backend|handler|endpoint|login|auth/, "backend-developer"],
      [/document|readme|docs|changelog/, "documentation"],
      [/review|pr |pull request|code quality/, "code-reviewer"],
      [/refactor|clean|dead code|duplication/, "refactoring"],
      [/research|feasib|best practice|compare|landscape|options/, "research"],
      [/require|business|acceptance|story|scope/, "business-analyst"],
    ];
    for (const [re, type] of map) {
      if (re.test(text)) return type;
    }
    return mode === "error" ? "debugging" : "backend-developer";
  }
}

export const agentRouter = new AgentRouter();
