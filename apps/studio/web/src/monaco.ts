// Monaco, bundled locally (no CDN) with its workers served from /assets/workers.

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

const WORKERS: Record<string, string> = {
  json: "json.worker.js",
  css: "css.worker.js",
  scss: "css.worker.js",
  less: "css.worker.js",
  html: "html.worker.js",
  handlebars: "html.worker.js",
  razor: "html.worker.js",
  typescript: "ts.worker.js",
  javascript: "ts.worker.js",
};

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    return new Worker(`/assets/workers/${WORKERS[label] ?? "editor.worker.js"}`, { name: label });
  },
};

monaco.editor.defineTheme("studio-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6b7280", fontStyle: "italic" },
    { token: "keyword", foreground: "98a4ff" },
    { token: "string", foreground: "9bd3a4" },
    { token: "number", foreground: "f5b94a" },
    { token: "type", foreground: "7dd3fc" },
  ],
  colors: {
    "editor.background": "#0d0e11",
    "editor.foreground": "#e6e8ec",
    "editorLineNumber.foreground": "#4b5160",
    "editorLineNumber.activeForeground": "#9aa1ad",
    "editor.lineHighlightBackground": "#16181d",
    "editor.selectionBackground": "#7c8cff44",
    "editorCursor.foreground": "#98a4ff",
    "editorIndentGuide.background1": "#1c1f26",
    "editorWidget.background": "#16181d",
    "editorWidget.border": "#23262e",
    "editorGutter.background": "#0d0e11",
    "scrollbarSlider.background": "#2b2f3980",
    "scrollbarSlider.hoverBackground": "#3a3f4c",
    "diffEditor.insertedTextBackground": "#4ade8022",
    "diffEditor.removedTextBackground": "#f8717122",
    "minimap.background": "#0d0e11",
  },
});

// The project's own tooling is the authority on type errors; the in-browser
// TypeScript service cannot see node_modules and would report false ones.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });

loader.config({ monaco });

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  xml: "xml",
  svg: "xml",
  tf: "hcl",
  dockerfile: "dockerfile",
  graphql: "graphql",
  php: "php",
  swift: "swift",
};

export function languageFor(filePath: string): string {
  const name = filePath.split("/").pop() ?? "";
  if (/^dockerfile/i.test(name)) return "dockerfile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_LANGUAGE[ext] ?? "plaintext";
}

export { monaco };
