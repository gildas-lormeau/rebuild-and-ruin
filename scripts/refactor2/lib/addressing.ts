import path from "node:path";
import process from "node:process";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import {
  AmbiguousSymbolError,
  type ResolvedSymbol,
  type SymbolAddress,
  SymbolNotFoundError,
} from "./types.ts";

export function resolveAll(
  project: Project,
  input: string,
  opts: { near?: string } = {},
): ResolvedSymbol[] {
  const address = parseAddress(input);
  if (address.file) {
    return [resolveSymbol(project, input, opts)];
  }
  const matches: ResolvedSymbol[] = [];
  for (const sf of project.getSourceFiles()) {
    if (!hasTopLevelName(sf, address.name)) continue;
    if (opts.near && !sf.getFullText().includes(opts.near)) continue;
    matches.push({
      file: sf.getFilePath(),
      name: address.name,
      member: address.member,
      sourceFile: sf,
    });
  }
  return matches;
}

export function resolveSymbol(
  project: Project,
  input: string,
  opts: { near?: string } = {},
): ResolvedSymbol {
  const address = parseAddress(input);
  if (address.file) {
    const sourceFile = loadSource(project, address.file);
    if (!sourceFile) {
      throw new SymbolNotFoundError(input);
    }
    if (!hasTopLevelName(sourceFile, address.name)) {
      throw new SymbolNotFoundError(input);
    }
    return {
      file: sourceFile.getFilePath(),
      name: address.name,
      member: address.member,
      sourceFile,
    };
  }

  const matches: ResolvedSymbol[] = [];
  for (const sf of project.getSourceFiles()) {
    if (!hasTopLevelName(sf, address.name)) continue;
    if (opts.near && !sf.getFullText().includes(opts.near)) continue;
    matches.push({
      file: sf.getFilePath(),
      name: address.name,
      member: address.member,
      sourceFile: sf,
    });
  }

  if (matches.length === 0) throw new SymbolNotFoundError(input);
  if (matches.length === 1) return matches[0];
  throw new AmbiguousSymbolError(
    input,
    matches.map((m) => ({ file: toRel(m.file), name: m.name })),
  );
}

export function parseAddress(raw: string): SymbolAddress {
  const hashIndex = raw.indexOf("#");
  if (hashIndex >= 0) {
    const file = raw.slice(0, hashIndex);
    const rest = raw.slice(hashIndex + 1);
    const { name, member } = splitMember(rest);
    return { raw, file, name, member };
  }
  const { name, member } = splitMember(raw);
  return { raw, name, member };
}

export function toRel(absPath: string): string {
  return path.relative(process.cwd(), absPath) || absPath;
}

function splitMember(input: string): { name: string; member?: string } {
  const dotIndex = input.indexOf(".");
  if (dotIndex < 0) return { name: input };
  return { name: input.slice(0, dotIndex), member: input.slice(dotIndex + 1) };
}

function loadSource(project: Project, file: string): SourceFile | undefined {
  const abs = path.resolve(file);
  return (
    project.getSourceFile(abs) ??
    project.getSourceFile(file) ??
    project.addSourceFileAtPathIfExists(abs)
  );
}

function hasTopLevelName(sf: SourceFile, name: string): boolean {
  for (const decl of topLevelDeclarations(sf)) {
    if (declarationName(decl) === name) return true;
  }
  return false;
}

function* topLevelDeclarations(sf: SourceFile): Iterable<Node> {
  for (const stmt of sf.getStatements()) {
    switch (stmt.getKind()) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration:
        yield stmt;
        break;
      case SyntaxKind.VariableStatement: {
        const decls = stmt
          .asKind(SyntaxKind.VariableStatement)
          ?.getDeclarationList()
          .getDeclarations();
        if (decls) {
          for (const decl of decls) yield decl;
        }
        break;
      }
    }
  }
}

function declarationName(node: Node): string | undefined {
  if (Node.hasName(node)) return node.getName();
  return undefined;
}
