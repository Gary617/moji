import { cellAddress, cellPosition, rangeAddresses, type CellValue, type SpreadsheetSheet } from "./model";

type RefToken = { kind: "reference"; text: string; sheet?: string; range: string };
type Token = RefToken | { kind: "number" | "string" | "name" | "operator"; text: string };
type Value = { values: CellValue[]; reference: boolean; rows: number; columns: number };
const scalar = (value: CellValue): Value => ({ values: [value], reference: false, rows: 1, columns: 1 });
const FUNCTIONS = new Set(["SUM", "AVERAGE", "COUNT", "COUNTA", "MIN", "MAX", "SUMIF", "COUNTIF", "AVERAGEIF"]);

function tokensFor(formula: string): Token[] {
  const source = formula.trim().replace(/^=/, "");
  if (!source || source.length > 8192) throw new Error("公式为空或超过 8192 字符");
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    const space = /^\s+/.exec(rest);
    if (space) { offset += space[0].length; continue; }
    const quoted = /^"((?:[^"]|"")*)"/.exec(rest);
    if (quoted) { tokens.push({ kind: "string", text: quoted[1].replace(/""/g, '"') }); offset += quoted[0].length; continue; }
    const ref = /^(?:('(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?)(?![\p{L}\p{N}_])/iu.exec(rest);
    if (ref) {
      tokens.push({ kind: "reference", text: ref[0], sheet: ref[1]?.replace(/^'|'$/g, "").replace(/''/g, "'"), range: ref[2] });
      offset += ref[0].length; continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (number) { tokens.push({ kind: "number", text: number[0] }); offset += number[0].length; continue; }
    const name = /^[A-Z_][A-Z_0-9.]*/i.exec(rest);
    if (name) { tokens.push({ kind: "name", text: name[0] }); offset += name[0].length; continue; }
    if (/^[()+*,/\-]$/.test(rest[0])) { tokens.push({ kind: "operator", text: rest[0] }); offset++; continue; }
    throw new Error("公式包含不支持的内容或无效地址");
  }
  return tokens;
}

function numberOf(value: Value): number {
  if (value.values.length !== 1 || value.rows !== 1 || value.columns !== 1) throw new Error("四则运算需要单个数值，不能直接使用区域");
  const item = value.values[0];
  if (item === null) return 0;
  if (typeof item === "boolean") return item ? 1 : 0;
  if (typeof item !== "number" || !Number.isFinite(item)) throw new Error("四则运算遇到文本或无效数值");
  return item;
}

function criterionMatches(value: CellValue, criterion: CellValue): boolean {
  if (criterion === null) criterion = 0;
  if (typeof criterion !== "string") return value === criterion || (value === null && criterion === 0);
  const match = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(criterion)!;
  const operator = match[1] ?? "=";
  const operand = match[2];
  const isNumber = operand.trim() !== "" && Number.isFinite(Number(operand));
  let compare: number | null;
  if (isNumber) {
    compare = typeof value === "number" ? value - Number(operand) : value === null ? -Number(operand) : null;
  } else {
    const left = String(value ?? "").toLowerCase();
    const right = operand.toLowerCase();
    if (operator === "=" || operator === "<>") {
      let expression = "^";
      for (let i = 0; i < right.length; i++) {
        let char = right[i];
        if (char === "~" && i + 1 < right.length) char = right[++i];
        else if (char === "*") { expression += ".*"; continue; }
        else if (char === "?") { expression += "."; continue; }
        expression += char.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
      }
      const equal = new RegExp(expression + "$", "su").test(left);
      return operator === "=" ? equal : !equal;
    }
    compare = left === right ? 0 : left < right ? -1 : 1;
  }
  if (compare === null) return operator === "<>";
  return operator === "=" ? compare === 0 : operator === "<>" ? compare !== 0
    : operator === ">" ? compare > 0 : operator === "<" ? compare < 0
    : operator === ">=" ? compare >= 0 : compare <= 0;
}

function aggregate(fn: string, args: Value[]): number {
  if (!args.length) throw new Error("函数缺少参数");
  if (fn.endsWith("IF")) {
    if (args.length < 2 || args.length > (fn === "COUNTIF" ? 2 : 3) || !args[0].reference || args[1].values.length !== 1) throw new Error("条件统计参数不正确");
    const source = args[0];
    const results = args[2] ?? source;
    if (!results.reference || source.rows !== results.rows || source.columns !== results.columns) throw new Error("条件区域与结果区域大小不一致");
    const selected = source.values.map((v, i) => criterionMatches(v, args[1].values[0]) ? i : -1).filter((i) => i >= 0);
    if (fn === "COUNTIF") return selected.length;
    args = [{ ...results, values: selected.map((i) => results.values[i]) }];
    fn = fn === "SUMIF" ? "SUM" : "AVERAGE";
  }
  if (fn === "COUNTA") return args.reduce((n, a) => n + a.values.filter((v) => v !== null).length, 0);
  const numbers: number[] = [];
  for (const arg of args) for (const value of arg.values) {
    if (typeof value === "number") numbers.push(value);
    else if (!arg.reference && typeof value === "boolean") numbers.push(value ? 1 : 0);
    else if (!arg.reference && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) numbers.push(Number(value));
    else if (!arg.reference && typeof value === "string" && fn !== "COUNT") throw new Error("函数参数不是数字");
  }
  if (fn === "COUNT") return numbers.length;
  if (fn === "AVERAGE" && !numbers.length) throw new Error("平均值区域没有数字");
  if (fn === "SUM" || fn === "AVERAGE") {
    const total = numbers.reduce((a, b) => a + b, 0);
    return fn === "SUM" ? total : total / numbers.length;
  }
  return numbers.reduce((n, value) => fn === "MIN" ? Math.min(n, value) : Math.max(n, value), numbers[0] ?? 0);
}

/** Bounded interpreter: no eval, JavaScript execution, network access or file writes. */
export function calculateFormula(sheet: SpreadsheetSheet, formula: string, sheets: SpreadsheetSheet[] = [sheet]): number {
  let reads = 0;
  const memo = new Map<string, CellValue>();
  const read = (current: SpreadsheetSheet, address: string, stack: Set<string>): CellValue => {
    if (++reads > 200_000 || stack.size > 100) throw new Error("计算量超过限制，请缩小区域");
    const key = JSON.stringify([current.name, address]);
    if (stack.has(key)) throw new Error(`检测到循环引用：${current.name}!${address}`);
    if (memo.has(key)) return memo.get(key)!;
    const cell = current.cells[address];
    if (!cell) return null;
    if (cell.kind === "error" || cell.unsupportedFormula) throw new Error(`单元格包含错误或不支持的公式：${address}`);
    const value = cell.formula ? evaluate(current, cell.formula, new Set(stack).add(key)) : cell.value;
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("非有限数值");
    memo.set(key, value); return value;
  };
  const evaluate = (current: SpreadsheetSheet, source: string, stack: Set<string>): number => {
    const tokens = tokensFor(source);
    let pos = 0;
    let depth = 0;
    const is = (text: string) => tokens[pos]?.kind === "operator" && tokens[pos]?.text === text;
    const take = (text: string) => { if (!is(text)) throw new Error(`公式缺少 ${text}`); pos++; };
    const expr = (): Value => {
      let value = product();
      while (is("+") || is("-")) { const op = tokens[pos++].text; const rhs = numberOf(product()); value = scalar(op === "+" ? numberOf(value) + rhs : numberOf(value) - rhs); }
      return value;
    };
    const product = (): Value => {
      let value = atom();
      while (is("*") || is("/")) {
        const op = tokens[pos++].text; const rhs = numberOf(atom());
        if (op === "/" && rhs === 0) throw new Error("除数不能为零");
        value = scalar(op === "*" ? numberOf(value) * rhs : numberOf(value) / rhs);
      }
      return value;
    };
    const atom = (): Value => {
      if (++depth > 100) throw new Error("公式嵌套过深");
      try {
        const token = tokens[pos++];
        if (!token) throw new Error("公式不完整");
        if (token.kind === "operator") {
          if (token.text === "+" || token.text === "-") return scalar((token.text === "-" ? -1 : 1) * numberOf(atom()));
          if (token.text === "(") { const value = expr(); take(")"); return value; }
          throw new Error("公式包含意外运算符");
        }
        if (token.kind === "number") return scalar(Number(token.text));
        if (token.kind === "string") return scalar(token.text);
        if (token.kind === "name") {
          const fn = token.text.toUpperCase();
          if (fn === "TRUE" || fn === "FALSE") return scalar(fn === "TRUE");
          if (!FUNCTIONS.has(fn)) throw new Error(`暂不支持函数或名称：${fn}`);
          take("("); const args: Value[] = [];
          if (!is(")")) { args.push(expr()); while (is(",")) { pos++; args.push(expr()); } }
          take(")"); return scalar(aggregate(fn, args));
        }
        if (token.kind !== "reference") throw new Error("无效公式标记");
        const target = token.sheet === undefined ? current : sheets.find((s) => s.name.toLowerCase() === token.sheet!.toLowerCase());
        if (!target) throw new Error(`工作表不存在：${token.sheet}`);
        const addresses = rangeAddresses(token.range);
        const begin = cellPosition(addresses[0]); const end = cellPosition(addresses[addresses.length - 1]);
        return { values: addresses.map((a) => read(target, a, stack)), reference: true, rows: end.row - begin.row + 1, columns: end.column - begin.column + 1 };
      } finally { depth--; }
    };
    const result = numberOf(expr());
    if (pos !== tokens.length) throw new Error("公式存在多余内容");
    if (!Number.isFinite(result)) throw new Error("公式结果不是有限数字");
    return result;
  };
  return evaluate(sheet, formula, new Set());
}

/** Excel-style copy: shift relative references; keep $ absolute components. */
export function translateFormula(formula: string, from: string, to: string): string {
  tokensFor(formula); // Reject unsupported grammar rather than shifting arbitrary strings.
  const start = cellPosition(from); const end = cellPosition(to);
  return formula.replace(/"(?:[^"]|"")*"|'(?:[^']|'')+'!|([\p{L}_][\p{L}\p{N}_.]*!)|(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![\p{L}\p{N}_])/giu, (full, sheetName, columnFixed, column, rowFixed, row) => {
    if (full.startsWith('"') || full.endsWith("!") || sheetName) return full;
    const point = cellPosition(column + row);
    const address = cellAddress(point.row + (rowFixed ? 0 : end.row - start.row), point.column + (columnFixed ? 0 : end.column - start.column));
    const shifted = /^([A-Z]+)(\d+)$/.exec(address)!;
    return `${columnFixed}${shifted[1]}${rowFixed}${shifted[2]}`;
  });
}

export type CalculationResult = { value: number; formula: string; addresses: string[] };
export function calculateOperation(sheet: SpreadsheetSheet, formula: string, addresses: string[], sheets?: SpreadsheetSheet[]): CalculationResult {
  addresses.forEach(cellPosition);
  return { value: calculateFormula(sheet, formula, sheets), formula: formula.startsWith("=") ? formula : `=${formula}`, addresses };
}
