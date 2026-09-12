/** Small data-only expression language. Never evaluate workflow input as JavaScript. */
export interface WorkflowScope {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const lex =
  /\s*(===|!==|==|!=|>=|<=|&&|\|\||[!><()[\].]|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*)/y;

function own(value: unknown, key: string): unknown {
  if (forbidden.has(key)) throw new Error(`Forbidden workflow property: ${key}`);
  if (value === null || typeof value !== "object") return undefined;
  // Read data properties only; custom tool objects must not run getters here.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function evaluateExpression(expression: string, scope: WorkflowScope): unknown {
  const source = expression.trim();
  if (source.length > 2048) throw new Error("Workflow expression exceeds 2048 characters");
  const tokens: string[] = [];
  let position = 0;
  while (position < source.length) {
    lex.lastIndex = position;
    const match = lex.exec(source);
    if (!match) throw new Error(`Invalid workflow expression near ${source.slice(position, position + 30)}`);
    tokens.push(match[1]);
    position = lex.lastIndex;
  }
  if (!tokens.length || tokens.length > 512) throw new Error("Invalid workflow expression length");
  let cursor = 0;
  let depth = 0;
  const take = (token: string): boolean => (tokens[cursor] === token ? (++cursor, true) : false);
  const expect = (token: string): void => {
    if (!take(token)) throw new Error(`Expected ${token} in workflow expression`);
  };
  const string = (token: string): string =>
    token[0] === '"'
      ? (JSON.parse(token) as string)
      : (JSON.parse(
          `"${token
            .slice(1, -1)
            .replace(/\\'/g, "'")
            .replace(/(?<!\\)"/g, '\\"')}"`,
        ) as string);
  const primary = (): unknown => {
    if (++depth > 32) throw new Error("Workflow expression is too deeply nested");
    try {
      if (take("(")) {
        const result = or();
        expect(")");
        return result;
      }
      const token = tokens[cursor++];
      if (token === "true") return true;
      if (token === "false") return false;
      if (token === "null") return null;
      if (token && /^-?\d/.test(token)) return Number(token);
      if (token?.startsWith('"') || token?.startsWith("'")) return string(token);
      if (token !== "inputs" && token !== "outputs")
        throw new Error(`Expected inputs/outputs reference or literal, got ${token ?? "end"}`);
      let value: unknown = scope[token];
      for (;;) {
        let key: string;
        if (take(".")) {
          key = tokens[cursor++];
          if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) throw new Error("Expected workflow property name");
        } else if (take("[")) {
          const part = tokens[cursor++];
          if (part?.startsWith('"') || part?.startsWith("'")) key = string(part);
          else if (part && /^\d+$/.test(part)) key = part;
          else throw new Error("Workflow brackets require a string key or array index");
          expect("]");
        } else break;
        value = own(value, key);
      }
      return value;
    } finally {
      depth -= 1;
    }
  };
  const unary = (): unknown => {
    let count = 0;
    while (take("!")) count += 1;
    const value = primary();
    return count ? (count % 2 ? !value : Boolean(value)) : value;
  };
  const compare = (): unknown => {
    let value = unary();
    while ([">", "<", ">=", "<=", "==", "!=", "===", "!=="].includes(tokens[cursor])) {
      const op = tokens[cursor++];
      const right = unary();
      if (op === "==" || op === "===") value = value === right;
      else if (op === "!=" || op === "!==") value = value !== right;
      else if (
        (typeof value === "number" && typeof right === "number") ||
        (typeof value === "string" && typeof right === "string")
      ) {
        value = op === ">" ? value > right : op === "<" ? value < right : op === ">=" ? value >= right : value <= right;
      } else value = false;
    }
    return value;
  };
  const and = (): unknown => {
    let value = compare();
    while (take("&&")) {
      const right = compare();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  };
  const or = (): unknown => {
    let value = and();
    while (take("||")) {
      const right = and();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  };
  const result = or();
  if (cursor !== tokens.length) throw new Error(`Unexpected workflow token: ${tokens[cursor]}`);
  return result;
}

/** {{ inputs.foo }} / {{ outputs["node-id"].value }} in tool or agent config. */
export function resolveWorkflowInput(value: unknown, scope: WorkflowScope, depth = 0): unknown {
  if (depth > 32) throw new Error("Workflow input is too deeply nested");
  const resolve = (expression: string): unknown => {
    const result = evaluateExpression(expression, scope);
    if (result === undefined) throw new Error(`Missing workflow input: ${expression}`);
    return result;
  };
  if (typeof value === "string") {
    const exact = /^\s*{{\s*([\s\S]*?)\s*}}\s*$/.exec(value);
    if (exact && !exact[1].includes("{{")) return resolve(exact[1]);
    return value.replace(/{{\s*([\s\S]*?)\s*}}/g, (_match, expression: string) => {
      const result = resolve(expression);
      return typeof result === "object" ? JSON.stringify(result) : String(result);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolveWorkflowInput(entry, scope, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (forbidden.has(key)) throw new Error(`Forbidden workflow input key: ${key}`);
        return [key, resolveWorkflowInput(entry, scope, depth + 1)];
      }),
    );
  }
  return value;
}
