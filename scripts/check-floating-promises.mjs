/**
 * Fails on a promise that nobody waits for, or that is tested as a value.
 *
 * WHY THIS EXISTS. Every storage call is async, and the in-memory table
 * performs a write before its promise even returns. So a missing `await` on a
 * write passes every test, the demo and the build - and against DynamoDB it is
 * a lost write, or a read that races it and sees the old value. `tsc` is no
 * help: a discarded promise is legal TypeScript. So is `if (loadHealth(p))`,
 * which is always true, and `'…' + openIncidents(p)`, which prints
 * "[object Promise]".
 *
 * What it reports, for any expression whose type is a Promise:
 *   - used as a statement on its own          putIncident(p, i);
 *   - used as a condition                     if (commsPhones(p)) …, !x, a && b
 *   - concatenated into a string              '…' + x, `${x}`
 *   - put in an object nothing expects a       json(200, { items: openIncidents(p) })
 *     promise in                               -> JSON.stringify writes {} and a 200
 *   - passed where ANYTHING is accepted        JSON.stringify(mainTable.get(..)), assert.ok(x)
 *     (`unknown`/`any`)                        -> "{}", and a privacy test that checks
 *                                                 "{}" for an email passes forever
 *
 * What it allows: `await`, `return`, `void x` (deliberately fire-and-forget,
 * and visible as such), `.then/.catch/.finally`, an arrow body (the caller
 * gets it), and anything passed or assigned onward - `Promise.all([...])`,
 * `const p = f()` - where the type system follows it from there.
 *
 * It is a checker, not a linter, so there is nothing to configure: the
 * TypeScript compiler this repo already has, two tsconfigs, one rule.
 *
 *   node scripts/check-floating-promises.mjs
 */
import ts from 'typescript';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const CONFIGS = ['tsconfig.json', 'web/tsconfig.json'];

function programFor(configPath) {
  const abs = path.join(root, configPath);
  const read = ts.readConfigFile(abs, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(abs));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

const problems = new Map(); // "file:line:col" -> message, deduped across the two configs

for (const config of CONFIGS) {
  const program = programFor(config);
  const checker = program.getTypeChecker();

  /**
   * `always`: every member of a union is a promise. A condition on
   * `Promise | undefined` is a legitimate "is there one yet?"; a condition on
   * a bare Promise is always true.
   */
  const isPromise = (node, always = false) => {
    const type = checker.getTypeAtLocation(node);
    const isThenable = (t) => {
      const then = t.getProperty('then');
      return !!then && checker.getTypeOfSymbolAtLocation(then, node).getCallSignatures().length > 0;
    };
    if (!type.isUnion()) return isThenable(type);
    return always ? type.types.every(isThenable) : type.types.some(isThenable);
  };

  /**
   * A statement that is a promise but is dealt with: `void x` (the explicit
   * opt-out), any assignment (`x = f()`, `x ??= f()` hands it on), a chain
   * ending in `.then/.catch/.finally` (a handler is attached), and node:test's
   * `test()`/`describe()`, which the runner itself awaits.
   */
  const handedOn = (e) => {
    if (ts.isVoidExpression(e)) return true;
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
    }
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      if (ts.isPropertyAccessExpression(callee) && ['then', 'catch', 'finally'].includes(callee.name.text)) return true;
      if (ts.isIdentifier(callee) && ['test', 'describe', 'it', 'suite'].includes(callee.text)) {
        const decl = checker.getSymbolAtLocation(callee);
        const origin = decl && (decl.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(decl) : decl;
        return !!origin?.declarations?.some((d) => d.getSourceFile().fileName.includes('@types/node'));
      }
    }
    return false;
  };

  /** A parameter that takes anything - where a promise slips through unnoticed. */
  const acceptsAnything = (arg) => {
    const expected = checker.getContextualType(arg);
    return !!expected && (expected.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0;
  };

  const report = (node, why) => {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
    const where = path.relative(root, sf.fileName).replaceAll('\\', '/') + ':' + (line + 1) + ':' + (character + 1);
    problems.set(where, why + ': ' + node.getText().split('\n')[0].slice(0, 90));
  };

  const visit = (node) => {
    if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      if (!handedOn(e) && isPromise(e)) report(e, 'promise not awaited');
    }
    const condition =
      ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression
        : ts.isConditionalExpression(node) ? node.condition
          : ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken ? node.operand
            : undefined;
    if (condition && isPromise(condition, true)) report(condition, 'promise used as a condition (always truthy)');
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        if (isPromise(node.left, true)) report(node.left, 'promise used as a condition (always truthy)');
      }
      if (op === ts.SyntaxKind.PlusToken) {
        const stringy = (n) => (checker.getTypeAtLocation(n).flags & ts.TypeFlags.StringLike) !== 0;
        for (const [side, other] of [[node.left, node.right], [node.right, node.left]]) {
          if (stringy(other) && isPromise(side)) report(side, 'promise concatenated into a string');
        }
      }
    }
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) {
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      const expected = checker.getContextualType(value);
      const wantsPromise = expected && (expected.getProperty('then')
        || (expected.isUnion() && expected.types.some((t) => t.getProperty('then'))));
      if (!wantsPromise && isPromise(value)) report(value, 'promise stored in an object that does not expect one');
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const arg of node.arguments ?? []) {
        if (acceptsAnything(arg) && isPromise(arg, true)) report(arg, 'promise passed where any value is accepted');
      }
    }
    if (ts.isTemplateSpan(node) && isPromise(node.expression)) report(node.expression, 'promise in a template string');
    ts.forEachChild(node, visit);
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    visit(sf);
  }
}

if (problems.size > 0) {
  for (const [where, why] of [...problems].sort()) console.error(where + '  ' + why);
  console.error('\n' + problems.size + ' promise(s) not awaited or misused - see the header of this script for why that matters.');
  process.exit(1);
}
console.log('check-floating-promises: ok');
