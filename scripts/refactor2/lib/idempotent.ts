import { existsSync } from "node:fs";
import path from "node:path";
import {
  type ExportDeclaration,
  Node,
  type Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

export interface ReexportLookup {
  barrel: string;
  from: string;
  symbol: string;
  typeOnly?: boolean;
}

export function hasTopLevelDecl(sf: SourceFile, name: string): boolean {
  for (const stmt of sf.getStatements()) {
    switch (stmt.getKind()) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration: {
        if (Node.hasName(stmt) && stmt.getName() === name) return true;
        break;
      }
      case SyntaxKind.VariableStatement: {
        const decls = stmt
          .asKind(SyntaxKind.VariableStatement)
          ?.getDeclarationList()
          .getDeclarations();
        if (!decls) break;
        for (const decl of decls) {
          if (decl.getName() === name) return true;
        }
        break;
      }
    }
  }
  return false;
}

export function hasExportedDecl(sf: SourceFile, name: string): boolean {
  const exported = sf.getExportedDeclarations().get(name);
  if (!exported || exported.length === 0) return false;
  for (const decl of exported) {
    if (decl.getSourceFile().getFilePath() === sf.getFilePath()) return true;
  }
  return false;
}

export function typeHasMemberAcrossProject(
  project: Project,
  typeName: string,
  prop: string,
): boolean {
  for (const sf of project.getSourceFiles()) {
    if (hasTypeMember(sf, typeName, prop)) return true;
  }
  return false;
}

export function hasTypeMember(
  sf: SourceFile,
  typeName: string,
  prop: string,
): boolean {
  const iface = sf.getInterface(typeName);
  if (iface && iface.getProperty(prop)) return true;
  const alias = sf.getTypeAlias(typeName);
  if (alias) {
    const typeNode = alias.getTypeNode();
    if (typeNode && Node.isTypeLiteral(typeNode)) {
      for (const member of typeNode.getMembers()) {
        if (Node.isPropertySignature(member) && member.getName() === prop) {
          return true;
        }
      }
    }
  }
  return false;
}

export function fileOnDisk(cwd: string, relOrAbs: string): boolean {
  return existsSync(path.resolve(cwd, relOrAbs));
}

export function barrelReexportsSymbol(
  project: Project,
  cwd: string,
  lookup: ReexportLookup,
): boolean {
  const barrelSf = loadSourceFile(project, cwd, lookup.barrel);
  const sourceSf = loadSourceFile(project, cwd, lookup.from);
  if (!barrelSf || !sourceSf) return false;
  const absSource = sourceSf.getFilePath();
  for (const decl of barrelSf.getExportDeclarations()) {
    if (!declTargetsSource(decl, absSource)) continue;
    for (const named of decl.getNamedExports()) {
      if (named.getName() !== lookup.symbol) continue;
      if (lookup.typeOnly === undefined) return true;
      const declTypeOnly = decl.isTypeOnly();
      const specTypeOnly = named.isTypeOnly() || declTypeOnly;
      if (specTypeOnly === lookup.typeOnly) return true;
    }
  }
  return false;
}

export function countImportsOfSymbolFrom(
  project: Project,
  cwd: string,
  symbol: string,
  fromFile: string,
): number {
  const oldSf = loadSourceFile(project, cwd, fromFile);
  if (!oldSf) return 0;
  const oldPath = oldSf.getFilePath();
  let count = 0;
  for (const sf of project.getSourceFiles()) {
    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (resolved?.getFilePath() !== oldPath) continue;
      for (const named of imp.getNamedImports()) {
        if (named.getName() === symbol) count++;
      }
    }
  }
  return count;
}

export function loadSourceFile(
  project: Project,
  cwd: string,
  file: string,
): SourceFile | undefined {
  const abs = path.resolve(cwd, file);
  return (
    project.getSourceFile(abs) ??
    project.getSourceFile(file) ??
    project.addSourceFileAtPathIfExists(abs) ??
    project.addSourceFileAtPathIfExists(file)
  );
}

function declTargetsSource(
  decl: ExportDeclaration,
  absSource: string,
): boolean {
  if (!decl.getModuleSpecifier()) return false;
  const declSource = decl.getModuleSpecifierSourceFile();
  return declSource?.getFilePath() === absSource;
}
