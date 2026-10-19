import ts from 'typescript';
import { createHash } from 'node:crypto';

/** AST summaries retain names and hashes, never full function bodies. */
function symbols(path: string, source: string): Map<string, string> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const result = new Map<string, string>();
  const visit = (node: ts.Node, scope: string) => {
    let name: string | undefined;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) name = node.name.getText(file);
    else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name.getText(file);
    const key = name ? `${scope}${scope ? '.' : ''}${name}` : scope;
    if (name) result.set(key, createHash('sha256').update(node.getText(file)).digest('hex'));
    ts.forEachChild(node, child => visit(child, key));
  };
  visit(file, ''); return result;
}
export function touchedSymbols(path: string, before: string, after: string): string[] {
  const old = symbols(path, before), current = symbols(path, after);
  return [...new Set([...old.keys(), ...current.keys()])].filter(name => old.get(name) !== current.get(name)).slice(0, 100);
}
