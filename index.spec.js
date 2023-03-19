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

const assert = require('assert');
const { createInterpreter, build, Abstract, QueryBuilder, Tuple } = require('.');

describe('initialize a query builder and test existing clauses', () => {
  const q = new QueryBuilder();

  it('must throw an error if unexpected/unsupported code is given', () => {
    assert.throws(
      () => q.scan("{x = something}").next(),
      new Error('unexpected "x = something"'));
  });

  it('must register a clause for a new header and perform match', () => {
    q.register({
      header: "x", clauses: {
        "=": c => a => true,
      }
    });

    const { value } = q.scan("{x = something}").next();
    assert.strictEqual(value.sign, '~');
    assert.strictEqual(value.text, '~{x = something}');
    assert.strictEqual(value.test[0](), true);
  });

  it('must perform one match and throw an error next', () => {
    const expr = q.scan("{x = something} + {x > 0}");

    const { value } = expr.next();
    assert.strictEqual(value.sign, '~');
    assert.strictEqual(value.text, '~{x = something}');
    assert.strictEqual(value.test[0](), true);

    assert.throws(() => expr.next(), new Error('unexpected "x > 0"'));
  });

  it('must register new clause and repeat previous', () => {
    q.register({
      header: "x", clauses: {
        ">": c => a => false,
      }
    });

    const expr = q.scan("{x = something} + {x > 0}");

    { // x = something
      const { value } = expr.next();
      assert.strictEqual(value.sign, '~');
      assert.strictEqual(value.text, '~{x = something}');
      assert.strictEqual(value.test[0](), true);
    }

    { // x > 0
      const { value } = expr.next();
      assert.strictEqual(value.sign, '+');
      assert.strictEqual(value.text, '+ {x > 0}');
      assert.strictEqual(value.test[0](), false);
    }
  });

});

describe('start a dummy interpreter to run against given inputs', () => {

  it('must successfully build a runtime and allocate a memory space', () => {
    const [runtime, memory] = build([
      ['a', null],
      ['b', null],
      ['c', null],
      ['d', null],
      ['s', null],
    ]);

    runtime(createInterpreter((_, acc) => acc));

    assert.strictEqual(memory.size, 5);
  });

  it('must retrieve computed value from memory and find some errors', () => {
    const interpreter = createInterpreter((_token, acc) => {
      if (acc === undefined) return [[new Tuple(0, 0)], 'tuple', NaN];

      throw new Error('must show 2 errors');
    });

    const program = [
      ['{#1}', null],
      ['x: {#2}', 'ref. bb s0'],
      ['x: x: {#3}', 'ref. cc s0'],
    ];

    const [runtime, memory] = build(program);

    runtime(interpreter);

    assert.strictEqual(memory.size, program.length);
    assert.strictEqual(interpreter.errors.length, 3);

    const [data, type, value] = memory.get('{#1}');

    assert.strictEqual(data.length, 1);
    assert.strictEqual(type, 'tuple');
    assert.strictEqual(value, NaN);
  });

  it('must iterate through lines and tokens', () => {
    const iter = {};

    const program = [
      ['{}', null],
      ['x: {}', null],
      ['x: y: z: ???', null],
    ];

    const [runtime, memory] = build(program);

    const interpreter = createInterpreter((token, acc) => {
      iter[token] = (iter[token] || 0) + 1;

      return acc;
    });

    runtime(interpreter);

    assert.strictEqual(memory.size, program.length);
    assert.strictEqual(iter['???'], 1);
    assert.strictEqual(iter['{}'], 2);
    assert.strictEqual(iter['x'], 2);
    assert.strictEqual(iter['y'], 1);
    assert.strictEqual(iter['z'], 1);
  });

});

describe('resolve dependency tree for unordonated source code', () => {
  const data = [
    new Tuple(2, 0),
    new Tuple(3, 1),
    new Tuple(4, 2),
  ];

  it('must scan tokens and resolve dependency tree as expected', () => {
    const source = [
      ['max: {...}', 'reference #1'],
      ['tuple: sum: {s < reference #1}', 'reference #2'],
      ['avg: reference #2', null],
    ];

    const expectedOrder = [
      ['{...}', [data, "tuple", NaN]],
      ['max', [data, "index", 2]],
      ['{s < 4}', [data.slice(0, 2), "tuple", NaN]], // variable must be inline replaced
      ['sum', [[new Tuple(2, 0), new Tuple(5, 1)], "index", 1]],
      ['tuple', [[new Tuple(2, 0), new Tuple(5, 1)], "tuple", NaN]], // must "tuplelize" to use as arg fora func
      ['{s < 4}', [data.slice(0, 2), "tuple", NaN]], // reuse from memory
      ['sum', [[new Tuple(2, 0), new Tuple(5, 1)], "index", 1]],
      ['tuple', [[new Tuple(2, 0), new Tuple(5, 1)], "tuple", NaN]],
      ['avg', [[new Tuple(2, 0), new Tuple(5, 1)], "value", 3.5]],
    ];

    let i = 0;
    const interpreter = createInterpreter(
      (token, acc, n, input) => {
        const [cToken, cAcc] = expectedOrder[i++];
        assert.strictEqual(token, cToken);
        return cAcc;
      });

    const [program, memory] = build(source);
    program(interpreter);

    assert.strictEqual(memory.get('max: {...}').toString(), '2,0,3,1,4,2,index,2')
    assert.strictEqual(memory.get('tuple: sum: {s < reference #1}').toString(), '2,0,5,1,tuple,NaN')
    assert.strictEqual(memory.get('avg: reference #2').toString(), '2,0,5,1,value,3.5')
    assert.strictEqual(interpreter.errors.length, 0);
  });

  it('must rescan tokens and resolve dependency tree as expected', () => {
    const source = [
      ['max: {...}', 'reference #1'],
      ['avg: reference #2', null],
      ['tuple: sum: {s < reference #1}', 'reference #2'],
    ];

    const expectedOrder = [
      ['{...}', [data, "tuple", NaN]],
      ['max', [data, "index", 2]],
      ['{s < 4}', [data.slice(0, 2), "tuple", NaN]], // variable must be inline replaced
      ['sum', [[new Tuple(2, 0), new Tuple(5, 1)], "index", 1]],
      ['tuple', [[new Tuple(2, 0), new Tuple(5, 1)], "tuple", NaN]], // must "tuplelize" to use as arg fora func
      ['{s < 4}', [data.slice(0, 2), "tuple", NaN]], // reuse from memory
      ['sum', [[new Tuple(2, 0), new Tuple(5, 1)], "index", 1]],
      ['tuple', [[new Tuple(2, 0), new Tuple(5, 1)], "tuple", NaN]],
      ['avg', [[new Tuple(2, 0), new Tuple(5, 1)], "value", 3.5]],
      ['{s < 4}', [data.slice(0, 2), "tuple", NaN]],
      ['sum', [[new Tuple(2, 0), new Tuple(5, 1)], "index", 1]],
      ['tuple', [[new Tuple(2, 0), new Tuple(5, 1)], "tuple", NaN]],
    ];

    let i = 0;
    const interpreter = createInterpreter(
      (token, acc, n, input) => {
        const [cToken, cAcc] = expectedOrder[i++];
        assert.strictEqual(token, cToken);
        return cAcc;
      });

    const [program, memory] = build(source);
    program(interpreter);

    assert.strictEqual(memory.get('max: {...}').toString(), '2,0,3,1,4,2,index,2')
    assert.strictEqual(memory.get('tuple: sum: {s < reference #1}').toString(), '2,0,5,1,tuple,NaN')
    assert.strictEqual(memory.get('avg: reference #2').toString(), '2,0,5,1,value,3.5')
    assert.strictEqual(interpreter.errors.length, 0);
  });

});

describe('bootstrap an implementation of both query and runtime', () => {
  const ds = [
    [42, 7, "2023-01-01"],
    [49, 8, "2023-01-01"],
  ];

  it('must run against a pseudo-sample source code', () => {
    const source = [
      ['{x < variable, y = today}', null],
      ['calc! 21 + 21', 'variable'],
    ];

    const macro = { today: "2023-01-01" };

    const q = new QueryBuilder();

    q.register({ header: "x", clauses: { "<": c => v => +c < v[0] } });
    q.register({ header: "y", clauses: { "=": c => v => c === v[2] } });

    const find = (token) => {
      const xs = [];

      for (const { sign, test, text } of q.scan(token)) {
        assert.strictEqual(sign, '~');
        assert.strictEqual(text, `~{x < 42, y = 2023-01-01}`);

        let t0, t1;

        t0 = test[0](ds[0]);
        assert.strictEqual(t0, false);
        t1 = test[1](ds[0]);
        assert.strictEqual(t1, true);

        if (t0 && t1) xs.push(new Tuple(ds[0][1], ds[0][0]));

        t0 = test[0](ds[1]);
        assert.strictEqual(t0, true);
        t1 = test[1](ds[1]);
        assert.strictEqual(t1, true);

        if (t0 && t1) xs.push(new Tuple(ds[1][1], ds[1][0] - ds[0][1]));
      }

      return xs;
    };

    const interpreter = createInterpreter((token, _acc) => {
      if (token.startsWith('calc!')) return [[], "value", 42];
      // expect dependency to run before the init of acc
      return [find(token), "tuple", NaN];
    });

    const abs = new Abstract();
    abs.program = source.map(a => [a[0], a[0], a[1]]);
    abs.macro = macro;
    abs.compile(interpreter);
    assert.strictEqual(interpreter.errors.length, 0);

    const [range, type, value] = abs.cache.get('{x < variable, y = today}');

    assert.strictEqual(range[0].index, 42);
    assert.strictEqual(range[0].value, 8);
    assert.strictEqual(type, "tuple");
    assert.strictEqual(value, NaN);
  });

});