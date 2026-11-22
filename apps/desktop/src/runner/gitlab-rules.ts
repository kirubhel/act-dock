/**
 * The subset of GitLab `rules:if` expressions Act Dock can evaluate locally:
 * `$VARIABLE`, "string" / 'string' / null, `==`, `!=`, `=~`, `!~` with a /regex/, `&&`, `||` and parentheses,
 * plus a bare `$VARIABLE` (true when set and not empty). `&&` binds tighter than `||`, as in GitLab.
 * Anything else is rejected with a reason when the file is read, never guessed at.
 */

type Operand = { kind: "var"; name: string } | { kind: "str"; value: string } | { kind: "null" };
type Compare = "==" | "!=" | "=~" | "!~";
export type Expr =
  | { op: "or" | "and"; left: Expr; right: Expr }
  | { op: "cmp"; cmp: "==" | "!="; left: Operand; right: Operand }
  | { op: "cmp"; cmp: "=~" | "!~"; left: Operand; regex: RegExp }
  | { op: "truthy"; operand: Operand };

type Token =
  | { t: "var"; name: string } | { t: "str"; value: string } | { t: "null" }
  | { t: "regex"; source: string; flags: string } | { t: "op"; value: Compare | "&&" | "||" | "(" | ")" };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    const rest = text.slice(i);
    const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (variable) { tokens.push({ t: "var", name: variable[1] }); i += variable[0].length; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, value = "";
      while (j < text.length && text[j] !== c) { if (text[j] === "\\" && j + 1 < text.length) j++; value += text[j++]; }
      if (j >= text.length) throw new Error(`unterminated string near ${rest.slice(0, 20)}`);
      tokens.push({ t: "str", value }); i = j + 1; continue;
    }
    const op = /^(==|!=|=~|!~|&&|\|\||\(|\))/.exec(rest);
    if (op) {
      tokens.push({ t: "op", value: op[1] as Compare }); i += op[1].length;
      // A regex literal only appears after =~ or !~, which keeps "/" unambiguous.
      if (op[1] === "=~" || op[1] === "!~") {
        const start = text.slice(i).search(/\S/);
        if (start < 0 || text[i + start] !== "/") throw new Error(`${op[1]} needs a /regex/ on its right side`);
        let j = i + start + 1, source = "";
        while (j < text.length && text[j] !== "/") { if (text[j] === "\\" && j + 1 < text.length) source += text[j++]; source += text[j++]; }
        if (j >= text.length) throw new Error("unterminated /regex/");
        const flags = /^[a-z]*/.exec(text.slice(j + 1))![0];
        tokens.push({ t: "regex", source, flags }); i = j + 1 + flags.length;
      }
      continue;
    }
    if (/^null\b/.test(rest)) { tokens.push({ t: "null" }); i += 4; continue; }
    throw new Error(`unsupported syntax near "${rest.slice(0, 20)}"`);
  }
  return tokens;
}

export function parseCondition(text: string): Expr {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.t === "op" && (peek() as { value: string }).value === value;
  const operand = (): Operand => {
    const token = tokens[pos++];
    if (token?.t === "var") return { kind: "var", name: token.name };
    if (token?.t === "str") return { kind: "str", value: token.value };
    if (token?.t === "null") return { kind: "null" };
    throw new Error("expected a $VARIABLE, a string or null");
  };
  function primary(): Expr {
    if (isOp("(")) {
      pos++;
      const inner = or();
      if (!isOp(")")) throw new Error("missing )");
      pos++;
      return inner;
    }
    const left = operand();
    const next = peek();
    if (next?.t === "op" && (next.value === "==" || next.value === "!=")) {
      pos++;
      return { op: "cmp", cmp: next.value, left, right: operand() };
    }
    if (next?.t === "op" && (next.value === "=~" || next.value === "!~")) {
      pos++;
      const rx = tokens[pos++];
      if (rx?.t !== "regex") throw new Error(`${next.value} needs a /regex/ on its right side`);
      try { return { op: "cmp", cmp: next.value, left, regex: new RegExp(rx.source, rx.flags.replace(/[^imsu]/g, "")) }; }
      catch { throw new Error(`invalid regular expression /${rx.source}/`); }
    }
    return { op: "truthy", operand: left };
  }
  function and(): Expr {
    let left = primary();
    while (isOp("&&")) { pos++; left = { op: "and", left, right: primary() }; }
    return left;
  }
  function or(): Expr {
    let left = and();
    while (isOp("||")) { pos++; left = { op: "or", left, right: and() }; }
    return left;
  }
  const expr = or();
  if (pos < tokens.length) throw new Error("unexpected text after the expression");
  return expr;
}

/** Every $VARIABLE an expression reads. */
export function conditionVariables(expr: Expr): string[] {
  const out: string[] = [];
  const add = (operand: Operand) => { if (operand.kind === "var") out.push(operand.name); };
  const walk = (e: Expr): void => {
    switch (e.op) {
      case "or":
      case "and": walk(e.left); walk(e.right); break;
      case "truthy": add(e.operand); break;
      case "cmp": add(e.left); if ("right" in e) add(e.right); break;
    }
  };
  walk(expr);
  return out;
}

export type Variables = Record<string, string | null>;

export function evaluateCondition(expr: Expr, vars: Variables): boolean {
  const value = (operand: Operand): string | null =>
    operand.kind === "var" ? vars[operand.name] ?? null : operand.kind === "str" ? operand.value : null;
  switch (expr.op) {
    case "or": return evaluateCondition(expr.left, vars) || evaluateCondition(expr.right, vars);
    case "and": return evaluateCondition(expr.left, vars) && evaluateCondition(expr.right, vars);
    case "truthy": { const v = value(expr.operand); return v !== null && v !== ""; }
    case "cmp": {
      const left = value(expr.left);
      if ("regex" in expr) {
        const matched = left !== null && expr.regex.test(left);
        return expr.cmp === "=~" ? matched : !matched;
      }
      // GitLab treats an empty variable like an unset one when it is compared with null.
      const nullish = (operand: Operand, v: string | null) => (operand.kind === "null" && v === "" ? null : v);
      const same = nullish(expr.right, left) === nullish(expr.left, value(expr.right));
      return expr.cmp === "==" ? same : !same;
    }
  }
}
