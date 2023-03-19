// Copyright (c) 2023 Alexandru Catrina <alex@codeissues.net>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

enum Tokens {
  FUN_COMPOSITION = ':',
  CLAUSE_DELIMITER = `,`,
  // cluster delimiters
  CLUSTER_BEGIN = `{`,
  CLUSTER_CLOSE = `}`,
  // cluster operators
  CLUSTER_OP_INNER = `~`,
  CLUSTER_OP_UNION = `+`,
  CLUSTER_OP_DIFFS = `-`,
  // supported operators
  OP_EQUAL = `=`,
  OP_EQUAL_NOT = `≠`,
  OP_LESS_THAN = `<`,
  OP_GREATER_THAN = `>`,
  OP_LESS_OR_EQUAL = `≤`,
  OP_GREATER_OR_EQUAL = `≥`,
}

function isInBetweenBraces(text: string, keyword: string) {
  const index = text.indexOf(keyword);
  const start = text.indexOf(Tokens.CLUSTER_BEGIN);
  const close = text.indexOf(Tokens.CLUSTER_CLOSE);

  return start < index && index < close;
}

function isFunctionArgument(text: string, keyword: string) {
  const pos = text.indexOf(Tokens.FUN_COMPOSITION);

  return pos === -1 || text.indexOf(keyword) > pos;
}

interface AbstractMachine<T> {
  readonly fold: (p: T, v: string, i: number, r: string[]) => T;
  readonly read: (k: string) => T | undefined;
  readonly save: (k: string, v: T) => T;
  readonly swap: (k: string, v: string, s: T) => string;
}

class Tree {
  public readonly ref?: string;
  public readonly input: string; // a copy of the input
  public readonly dependencies: Record<string, Tree>;
  public currentValue: string; // can change over time

  public constructor(value: string, input: string, ref?: string) {
    this.currentValue = value;
    this.dependencies = {};
    this.input = input;
    this.ref = ref;
  }

  public expand(deps: Record<string, Tree>) {
    Object.keys(deps).forEach(a => {
      if (this.currentValue.indexOf(a) > -1) {
        const depTree = deps[a];
        this.dependencies[a] = depTree;

        if (Object.keys(depTree.dependencies).length > 0)
          depTree.expand(deps);
      }
    });

    return this;
  }

  public update(newValue: string) {
    this.currentValue = newValue;
  }
}

function parseTree<T>(t: Tree, m: AbstractMachine<T>): T {
  for (const k in t.dependencies) {
    if (isFunctionArgument(t.currentValue, k) || isInBetweenBraces(t.currentValue, k)) {
      const output = m.read(k) || parseTree(t.dependencies[k], m);
      const value0 = m.swap(k, t.currentValue, output);
      t.update(value0 ? value0 : t.currentValue.replace(k, t.dependencies[k].currentValue));
    }
  }

  const tVal = t.currentValue.split(Tokens.FUN_COMPOSITION).reduceRight(m.fold, undefined as T);

  return t.ref ? m.save(t.ref, tVal) : tVal;
}

type Source = [string, string, string | undefined];

class Abstract<T> {
  public readonly cache: Map<string, T> = new Map();
  // caller can get/set directly on these two
  public macro: Record<string, string> = {};
  public program: Source[] = [];

  public compile(m: AbstractMachine<T>) {
    this.cache.clear();
    this.expandMacro();

    this.scanDependencyTree().forEach(t => {
      this.cache.set(t.input, parseTree<T>(t, m));
    });
  }

  protected expandMacro() {
    const kwords = Object.entries(this.macro);

    for (let i = 0; i < this.program.length; i++) {
      for (const [k, v] of kwords) {
        if (this.program[i][0].indexOf(k) > -1)
          this.program[i][0] = this.program[i][0].replace(k, v);
      }
    }

    return this;
  }

  protected scanDependencyTree(): Tree[] {
    const trees: Tree[] = [];
    const mem: Record<string, Tree> = {};

    for (const [value, input, ref] of this.program) {
      const tree = new Tree(value, input, ref);
      trees.push(tree);
      if (ref) mem[ref] = tree;
    }

    return trees.map(t => t.expand(mem));
  }
}

export { Abstract, AbstractMachine, Source, Tokens };

enum Solution {
  INDEX = "index",
  TUPLE = "tuple",
  VALUE = "value",
}

class Tuple extends Array<number> {
  public constructor(value: number, index: number) {
    super();
    this.push(value, index);
  }

  public get value() {
    return this[0];
  }

  public get index() {
    return this[1];
  }
}

type Accumulator = [Tuple[], Solution, number];

type Misinterpret = [Error, Accumulator, string, string[], number];

interface Interpreter extends AbstractMachine<Accumulator> {
  readonly errors: Misinterpret[];
}

type Resolver = (s: string, a: Accumulator, n: number, r: string[]) => Accumulator;

function createInterpreter(resolver: Resolver): Interpreter {
  const errors: Misinterpret[] = [];
  const cache = new Map<string, Accumulator>();

  function fold(acc: Accumulator, token: string, n: number, input: string[]): Accumulator {
    try {
      return resolver(token.trim(), acc, n, input);
    } catch (e) {
      errors.push([e as Error, acc, token, input, n]);
    }

    return acc;
  }

  function read(ref: string): Accumulator | undefined {
    return cache.get(ref);
  }

  function save(ref: string, val: Accumulator): Accumulator {
    cache.set(ref, val);

    return val;
  }

  function swap(ref: string, str: string, [xs, sol, val]: Accumulator): string {
    switch (sol) {
      case Solution.VALUE:
        return str.replace(ref, val.toString());
      case Solution.INDEX:
        return val > -1 ? str.replace(ref, xs[val].value.toString()) : "";
      default:
        return "";
    }
  }

  return { errors, fold, read, save, swap };
}

type Runtime = [(i: Interpreter) => void, Map<string, Accumulator>];

function build(p: Array<[string, string?]>, m?: Record<string, string>): Runtime {
  const abs = new Abstract<Accumulator>();

  abs.program = p.map(a => [a[0], a[0], a[1]] as Source);
  abs.macro = m || {};

  return [abs.compile.bind(abs), abs.cache];
}

export { build, createInterpreter, Solution, Tuple };

export type { Accumulator, Interpreter, Misinterpret, Resolver, Runtime };

type Predicate<T> = (p: T) => boolean;

interface Query<T> {
  readonly text: string;
  readonly sign: string;
  readonly test: Predicate<T>[];
}

type QueryableClause<T> = (c: string) => Predicate<T>;

interface Queryable<T> {
  readonly header: string;
  readonly clauses: Record<string, QueryableClause<T>>;
}

class QueryBuilder<T> {
  public readonly headers: Set<string>;
  public readonly support: Record<string, QueryableClause<T>>;

  public constructor() {
    this.headers = new Set<string>();
    this.support = {};
  }

  public register({ header, clauses }: Queryable<T>): void {
    for (const [op, fn] of Object.entries(clauses)) {
      this.support[header + op] = fn;
    }

    this.headers.add(header);
  }

  public parse(input: string): Predicate<T> {
    const expr = input.trim();
    const head = expr.trim().charAt(0);
    const func = expr.slice(1).trim().charAt(0);
    const tail = expr.slice(expr.indexOf(func) + 1).trim();
    const call = this.support[head + func];

    if (call !== undefined) return call(tail);

    throw new Error(`unexpected "${input}"`);
  }

  public *scan(input: string): Generator<Query<T>> {
    const lexic = this.grammar;

    if (input.charAt(0) === Tokens.CLUSTER_BEGIN) {
      input = Tokens.CLUSTER_OP_INNER + input;
    }

    let e: RegExpExecArray | null;
    while ((e = lexic.exec(input)) !== null) {
      const begin = e[0].indexOf(Tokens.CLUSTER_BEGIN);
      const close = e[0].indexOf(Tokens.CLUSTER_CLOSE);
      const value = e[0].trim();

      if (value.length > 0)
        yield {
          sign: value.charAt(0),
          text: value,
          test: value
            .slice(begin + 1, close)
            .split(Tokens.CLAUSE_DELIMITER)
            .map(this.parse.bind(this))
        };
    }
  }

  public get grammar() {
    return /([~\+\-]\s*\{.+?\})/g;
  }
}

export { Query, Queryable, QueryableClause, QueryBuilder };
