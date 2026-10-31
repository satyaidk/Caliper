/**
 * A small, safe evaluator for the placeholder language in Bambu Studio's
 * machine G-code templates (inherited from Slic3r's PlaceholderParser).
 *
 * Why not `eval` or a general template engine: these templates drive a real
 * printer's homing, wiping and bed-levelling sequence. Every construct the
 * pinned P1S templates use is parsed into a tree and evaluated here, and
 * anything unexpected (an unknown variable, a type mismatch, an index out of
 * range, an unbalanced `{if}`) is an error rather than an empty string. A
 * template that renders at all renders exactly what Bambu Studio would.
 *
 * Supported syntax, which is everything the pinned templates contain:
 * - `[name]` substitutes a variable; a vector without an index uses the
 *   current extruder's value, as PlaceholderParser does.
 * - `{expression}` evaluates and substitutes an expression.
 * - `{if expr}`, `{elsif expr}`, `{else}`, `{endif}` for conditional text.
 * - Expressions: numbers, "strings", `name`, `name[expr]`, unary `+ - !`,
 *   `* / %`, `+ -`, `< > <= >=`, `== !=`, `&&`/`and`, `||`/`or`, `not`,
 *   and parentheses.
 */

export type TemplateScalar = number | string | boolean;
export type TemplateValue = TemplateScalar | readonly TemplateScalar[];
export type TemplateContext = Readonly<Record<string, TemplateValue>>;

export interface RenderOptions {
  /** Index used when a vector variable is referenced without `[index]`. */
  currentExtruder?: number;
}

export class TemplateError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at character ${offset})`);
    this.name = 'TemplateError';
    this.offset = offset;
  }
}

/* --------------------------------------------------------------- lexing ---- */

type Token =
  | { kind: 'number'; value: number; offset: number }
  | { kind: 'string'; value: string; offset: number }
  | { kind: 'name'; value: string; offset: number }
  | { kind: 'op'; value: string; offset: number }
  | { kind: 'end'; offset: number };

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', '[', ']'];

function tokenize(source: string, base: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const offset = base + i;
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]), offset });
      i += number[0].length;
      continue;
    }
    if (char === '"') {
      const close = source.indexOf('"', i + 1);
      if (close < 0) throw new TemplateError('Unterminated string', offset);
      tokens.push({ kind: 'string', value: source.slice(i + 1, close), offset });
      i = close + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) {
      const word = name[0];
      if (word === 'and') tokens.push({ kind: 'op', value: '&&', offset });
      else if (word === 'or') tokens.push({ kind: 'op', value: '||', offset });
      else if (word === 'not') tokens.push({ kind: 'op', value: '!', offset });
      else tokens.push({ kind: 'name', value: word, offset });
      i += word.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new TemplateError(`Unexpected character "${char}"`, offset);
    tokens.push({ kind: 'op', value: op, offset });
    i += op.length;
  }
  tokens.push({ kind: 'end', offset: base + source.length });
  return tokens;
}

/* -------------------------------------------------------------- parsing ---- */

type Expr =
  | { type: 'literal'; value: TemplateScalar }
  | { type: 'variable'; name: string; index: Expr | null; offset: number }
  | { type: 'unary'; op: string; operand: Expr; offset: number }
  | { type: 'binary'; op: string; left: Expr; right: Expr; offset: number };

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

function parseExpression(source: string, base: number): Expr {
  const tokens = tokenize(source, base);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expectOp = (value: string) => {
    const token = take();
    if (token.kind !== 'op' || token.value !== value) {
      throw new TemplateError(`Expected "${value}"`, token.offset);
    }
  };

  const primary = (): Expr => {
    const token = take();
    if (token.kind === 'number') return { type: 'literal', value: token.value };
    if (token.kind === 'string') return { type: 'literal', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { type: 'literal', value: true };
      if (token.value === 'false') return { type: 'literal', value: false };
      let index: Expr | null = null;
      const next = peek();
      if (next.kind === 'op' && next.value === '[') {
        take();
        index = binary(0);
        expectOp(']');
      }
      return { type: 'variable', name: token.value, index, offset: token.offset };
    }
    if (token.kind === 'op' && token.value === '(') {
      const inner = binary(0);
      expectOp(')');
      return inner;
    }
    if (token.kind === 'op' && (token.value === '-' || token.value === '+' || token.value === '!')) {
      return { type: 'unary', op: token.value, operand: primary(), offset: token.offset };
    }
    throw new TemplateError('Expected a value', token.offset);
  };

  const binary = (minimum: number): Expr => {
    let left = primary();
    for (;;) {
      const token = peek();
      if (token.kind !== 'op') break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minimum) break;
      take();
      const right = binary(precedence + 1);
      left = { type: 'binary', op: token.value, left, right, offset: token.offset };
    }
    return left;
  };

  const expression = binary(0);
  const rest = peek();
  if (rest.kind !== 'end') throw new TemplateError('Unexpected text after expression', rest.offset);
  return expression;
}

/* ----------------------------------------------------------- evaluation ---- */

function lookup(context: TemplateContext, name: string, offset: number): TemplateValue {
  if (!Object.prototype.hasOwnProperty.call(context, name)) {
    throw new TemplateError(`Unknown template variable "${name}"`, offset);
  }
  return context[name];
}

function evaluate(expr: Expr, context: TemplateContext, options: RenderOptions): TemplateScalar {
  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'variable': {
      const value = lookup(context, expr.name, expr.offset);
      if (Array.isArray(value)) {
        const indexValue = expr.index === null ? options.currentExtruder ?? 0 : evaluate(expr.index, context, options);
        if (typeof indexValue !== 'number' || !Number.isInteger(indexValue)) {
          throw new TemplateError(`Index of "${expr.name}" must be an integer`, expr.offset);
        }
        if (indexValue < 0 || indexValue >= value.length) {
          throw new TemplateError(`Index ${indexValue} is out of range for "${expr.name}"`, expr.offset);
        }
        return value[indexValue];
      }
      if (expr.index !== null) throw new TemplateError(`"${expr.name}" is not a vector`, expr.offset);
      return value as TemplateScalar;
    }
    case 'unary': {
      const operand = evaluate(expr.operand, context, options);
      if (expr.op === '!') {
        if (typeof operand !== 'boolean') throw new TemplateError('"!" needs a boolean', expr.offset);
        return !operand;
      }
      if (typeof operand !== 'number') throw new TemplateError(`Unary "${expr.op}" needs a number`, expr.offset);
      return expr.op === '-' ? -operand : operand;
    }
    case 'binary': {
      if (expr.op === '&&' || expr.op === '||') {
        const left = evaluate(expr.left, context, options);
        if (typeof left !== 'boolean') throw new TemplateError(`"${expr.op}" needs booleans`, expr.offset);
        if (expr.op === '&&' && !left) return false;
        if (expr.op === '||' && left) return true;
        const right = evaluate(expr.right, context, options);
        if (typeof right !== 'boolean') throw new TemplateError(`"${expr.op}" needs booleans`, expr.offset);
        return right;
      }
      const left = evaluate(expr.left, context, options);
      const right = evaluate(expr.right, context, options);
      if (expr.op === '==' || expr.op === '!=') {
        if (typeof left !== typeof right) {
          throw new TemplateError(`Cannot compare ${typeof left} with ${typeof right}`, expr.offset);
        }
        return expr.op === '==' ? left === right : left !== right;
      }
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw new TemplateError(`"${expr.op}" needs numbers`, expr.offset);
      }
      switch (expr.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          if (right === 0) throw new TemplateError('Division by zero', expr.offset);
          return left / right;
        case '%':
          if (right === 0) throw new TemplateError('Division by zero', expr.offset);
          return left % right;
        case '<':
          return left < right;
        case '>':
          return left > right;
        case '<=':
          return left <= right;
        case '>=':
          return left >= right;
      }
      throw new TemplateError(`Unknown operator "${expr.op}"`, expr.offset);
    }
  }
}

/**
 * Formats a value for G-code as Bambu Studio does: at most 3 decimals (a
 * Bambu-sliced P1S file renders the flush feed as "F299.339"), never exponent
 * notation, trailing zeros trimmed.
 */
export function formatTemplateValue(value: TemplateScalar): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isFinite(value)) throw new RangeError('Template produced a non-finite number.');
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/* ------------------------------------------------------------ rendering ---- */

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; expr: Expr }
  | { kind: 'if'; branches: { condition: Expr | null; body: Segment[] }[] };

interface Directive {
  word: 'if' | 'elsif' | 'else' | 'endif';
  condition: Expr | null;
  offset: number;
}

type Piece = { kind: 'text'; text: string } | { kind: 'expr'; expr: Expr } | { kind: 'directive'; directive: Directive };

const SQUARE_PLACEHOLDER = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/;

function scan(template: string): Piece[] {
  const pieces: Piece[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    if (text) pieces.push({ kind: 'text', text });
    text = '';
  };
  while (i < template.length) {
    const char = template[i];
    if (char === '{') {
      const close = template.indexOf('}', i + 1);
      if (close < 0) throw new TemplateError('Unclosed "{"', i);
      const inner = template.slice(i + 1, close).trim();
      const base = i + 1 + template.slice(i + 1, close).indexOf(inner);
      flush();
      const directive = /^(if|elsif|else|endif)\b\s*([\s\S]*)$/.exec(inner);
      if (directive) {
        const word = directive[1] as Directive['word'];
        const rest = directive[2];
        if ((word === 'if' || word === 'elsif') && !rest.trim()) {
          throw new TemplateError(`"${word}" needs a condition`, i);
        }
        if ((word === 'else' || word === 'endif') && rest.trim()) {
          throw new TemplateError(`"${word}" takes no condition`, i);
        }
        pieces.push({
          kind: 'directive',
          directive: {
            word,
            condition: rest.trim() ? parseExpression(rest, base + inner.indexOf(rest)) : null,
            offset: i,
          },
        });
      } else {
        if (!inner) throw new TemplateError('Empty "{}"', i);
        pieces.push({ kind: 'expr', expr: parseExpression(inner, base) });
      }
      i = close + 1;
      continue;
    }
    if (char === '}') throw new TemplateError('Unmatched "}"', i);
    if (char === '[') {
      const match = SQUARE_PLACEHOLDER.exec(template.slice(i));
      if (match) {
        flush();
        pieces.push({ kind: 'expr', expr: { type: 'variable', name: match[1], index: null, offset: i } });
        i += match[0].length;
        continue;
      }
    }
    text += char;
    i++;
  }
  flush();
  return pieces;
}

function build(pieces: Piece[]): Segment[] {
  let position = 0;
  const block = (terminators: Directive['word'][]): { body: Segment[]; end: Directive | null } => {
    const body: Segment[] = [];
    while (position < pieces.length) {
      const piece = pieces[position];
      if (piece.kind === 'directive') {
        if (terminators.includes(piece.directive.word)) {
          position++;
          return { body, end: piece.directive };
        }
        if (piece.directive.word !== 'if') {
          throw new TemplateError(`Unexpected "{${piece.directive.word}}"`, piece.directive.offset);
        }
        position++;
        const branches: { condition: Expr | null; body: Segment[] }[] = [];
        let condition: Expr | null = piece.directive.condition;
        let sawElse = false;
        for (;;) {
          const inner = block(['elsif', 'else', 'endif']);
          branches.push({ condition, body: inner.body });
          if (!inner.end) throw new TemplateError('Missing "{endif}"', piece.directive.offset);
          if (inner.end.word === 'endif') break;
          if (sawElse) throw new TemplateError(`"{${inner.end.word}}" after "{else}"`, inner.end.offset);
          if (inner.end.word === 'else') sawElse = true;
          condition = inner.end.condition;
        }
        body.push({ kind: 'if', branches });
        continue;
      }
      body.push(piece);
      position++;
    }
    return { body, end: null };
  };
  const { body, end } = block([]);
  if (end) throw new TemplateError(`Unexpected "{${end.word}}"`, end.offset);
  return body;
}

function emit(segments: Segment[], context: TemplateContext, options: RenderOptions): string {
  let out = '';
  for (const segment of segments) {
    if (segment.kind === 'text') out += segment.text;
    else if (segment.kind === 'expr') out += formatTemplateValue(evaluate(segment.expr, context, options));
    else {
      for (const branch of segment.branches) {
        if (branch.condition === null) {
          out += emit(branch.body, context, options);
          break;
        }
        const result = evaluate(branch.condition, context, options);
        if (typeof result !== 'boolean') throw new TemplateError('A condition must be true or false', 0);
        if (result) {
          out += emit(branch.body, context, options);
          break;
        }
      }
    }
  }
  return out;
}

/** Parses a template once; throws on any syntax error. */
export function compileTemplate(template: string): (context: TemplateContext, options?: RenderOptions) => string {
  const segments = build(scan(template));
  return (context, options = {}) => emit(segments, context, options);
}

/** Renders a template, throwing on any syntax error or unknown variable. */
export function renderTemplate(template: string, context: TemplateContext, options: RenderOptions = {}): string {
  return compileTemplate(template)(context, options);
}

/** Lists every variable a template references, in order of first use. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  const visit = (expr: Expr | null) => {
    if (!expr) return;
    if (expr.type === 'variable') {
      if (!names.includes(expr.name)) names.push(expr.name);
      visit(expr.index);
    } else if (expr.type === 'unary') visit(expr.operand);
    else if (expr.type === 'binary') {
      visit(expr.left);
      visit(expr.right);
    }
  };
  const walk = (segments: Segment[]) => {
    for (const segment of segments) {
      if (segment.kind === 'expr') visit(segment.expr);
      else if (segment.kind === 'if') {
        for (const branch of segment.branches) {
          visit(branch.condition);
          walk(branch.body);
        }
      }
    }
  };
  walk(build(scan(template)));
  return names;
}
