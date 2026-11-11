// Filesystem sandbox, secret redaction and process-argument safety.

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findFiles, listDir, readFile, searchFiles, writeFile } from "../../src/files.ts";
import { cleanEnv, run, which } from "../../src/proc.ts";
import { PathError, isSensitive, resolveInside, toSegments, validateProjectRoot } from "../../src/security/paths.ts";
import { redact, redactDeep, resetRedactionCache } from "../../src/security/redact.ts";
import { removeDir, tempDir } from "../helpers.ts";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof PathError ? error.code : `other:${(error as Error).message}`;
  }
  return "ok";
};

describe("path sandbox", () => {
  let root: string;
  let outside: string;

  before(() => {
    root = tempDir("sandbox");
    outside = tempDir("outside");
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 42;\n");
    writeFileSync(path.join(root, ".env"), "API_KEY=supersecretvalue123\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside");
  });
  after(() => {
    removeDir(root);
    removeDir(outside);
  });

  it("rejects traversal, absolute paths and Windows tricks", () => {
    assert.equal(code(() => toSegments("../etc/passwd")), "traversal");
    assert.equal(code(() => toSegments("src/../../x")), "traversal");
    assert.equal(code(() => toSegments("..\\..\\Windows\\system.ini")), "traversal");
    assert.equal(code(() => toSegments("/etc/passwd")), "absolute");
    assert.equal(code(() => toSegments("C:\\Windows\\system.ini")), "absolute");
    assert.equal(code(() => toSegments("c:secret")), "absolute");
    assert.equal(code(() => toSegments("\\\\server\\share\\x")), "absolute");
    assert.equal(code(() => toSegments("~/x")), "absolute");
    assert.equal(code(() => toSegments("src/app.ts:stream")), "invalid");
    assert.equal(code(() => toSegments("src/NUL")), "invalid");
    assert.equal(code(() => toSegments("src/con.txt")), "invalid");
    assert.equal(code(() => toSegments("src/app.ts. ")), "invalid");
    assert.equal(code(() => toSegments("a\0b")), "invalid");
    assert.equal(code(() => toSegments(42)), "invalid");
    assert.deepEqual(toSegments("./src//app.ts"), ["src", "app.ts"]);
    assert.deepEqual(toSegments("src\\app.ts"), ["src", "app.ts"]);
    assert.deepEqual(toSegments(""), []);
  });

  it("resolves inside the root and refuses a link that leads outside", (t) => {
    assert.ok(resolveInside(root, "src/app.ts").endsWith(path.join("src", "app.ts")));
    assert.ok(resolveInside(root, "new/dir/file.txt").includes("new"));
    try {
      symlinkSync(outside, path.join(root, "escape"), "junction");
    } catch {
      t.diagnostic("links are not available here; link escape not exercised");
      return;
    }
    assert.equal(code(() => resolveInside(root, "escape/secret.txt")), "traversal");
    assert.equal(code(() => readFile(root, "escape/secret.txt", true)), "traversal");
    assert.equal(code(() => writeFile(root, "escape/new.txt", "x", { create: true })), "traversal");
  });

  it("classifies files that may hold secrets", () => {
    for (const file of [".env", ".env.local", "config/.env.production", "id_rsa", "deploy.pem", ".aws/credentials", ".npmrc", "secrets.json", "terraform.tfvars", ".claude/settings.local.json", "aidlc/.aidlc-sessions/x.json"]) {
      assert.equal(isSensitive(file), true, file);
    }
    for (const file of [".env.example", "src/app.ts", "README.md", "environment.ts", "keyboard.ts", ".claude/settings.json"]) {
      assert.equal(isSensitive(file), false, file);
    }
  });

  it("never returns a sensitive file unless explicitly revealed, and never searches it", () => {
    assert.equal(code(() => readFile(root, ".env", false)), "sensitive");
    assert.match(readFile(root, ".env", true).content, /API_KEY/);
    assert.equal(searchFiles(root, "supersecretvalue123").hits.length, 0);
    assert.equal(listDir(root, "").find((e) => e.name === ".env")?.sensitive, true);
    assert.equal(code(() => writeFile(root, ".env", "X=1")), "sensitive");
  });

  it("reads, writes with conflict detection, searches and finds", () => {
    const file = readFile(root, "src/app.ts", false);
    assert.equal(file.content, "export const answer = 42;\n");
    assert.equal(code(() => writeFile(root, "src/app.ts", "x", { expectedMtime: file.mtime - 5000 })), "conflict");
    const saved = writeFile(root, "src/app.ts", "export const answer = 43;\n", { expectedMtime: file.mtime });
    assert.equal(saved.created, false);
    assert.equal(code(() => writeFile(root, "src/missing.ts", "x")), "not_found");
    assert.equal(writeFile(root, "src/deep/new.ts", "const x = 1;\n", { create: true }).created, true);
    assert.equal(code(() => writeFile(root, ".git/config", "x", { create: true })), "protected");
    assert.equal(code(() => writeFile(root, "../evil.txt", "x", { create: true })), "traversal");
    const hits = searchFiles(root, "answer = 43");
    assert.equal(hits.hits.length, 1);
    assert.equal(hits.hits[0].path, "src/app.ts");
    assert.equal(hits.hits[0].line, 1);
    assert.equal(code(() => searchFiles(root, "(", { regex: true })), "invalid");
    assert.deepEqual(findFiles(root, "new.ts"), ["src/deep/new.ts"]);
  });

  it("refuses filesystem roots as projects", () => {
    assert.equal(code(() => validateProjectRoot(path.parse(root).root)), "root");
    assert.equal(code(() => validateProjectRoot("")), "invalid");
    assert.equal(validateProjectRoot(root), path.resolve(root));
  });
});

describe("secret redaction", () => {
  it("masks vendor tokens, keys, bearer tokens and URL passwords", () => {
    const samples = [
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-123456789012-abcdefghijkl",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    ];
    for (const secret of samples) {
      const out = redact(`value is ${secret} ok`);
      assert.ok(!out.includes(secret), secret);
      assert.ok(out.includes("[redacted]"));
    }
    assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer [redacted]");
    assert.equal(redact("postgres://app:hunter2pass@db:5432/x"), "postgres://app:[redacted]@db:5432/x");
    assert.match(redact("DB_PASSWORD=Sup3rS3cret!"), /DB_PASSWORD=\[redacted\]/);
    assert.match(redact('"api_key": "abc123def456"'), /"api_key": "\[redacted\]"/);
    assert.match(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), /^\[redacted\]$/);
  });

  it("leaves ordinary text and references alone", () => {
    assert.equal(redact("password=$DB_PASSWORD"), "password=$DB_PASSWORD");
    assert.equal(redact("12 passed, 0 failed in src/token.ts"), "12 passed, 0 failed in src/token.ts");
    assert.equal(redact("the tokenizer handles keys"), "the tokenizer handles keys");
  });

  it("masks values of secret-named environment variables wherever they appear", () => {
    process.env.STUDIO_TEST_API_TOKEN = "zz-plain-looking-value-0001";
    resetRedactionCache();
    assert.equal(redact("echo zz-plain-looking-value-0001 done"), "echo [redacted] done");
    delete process.env.STUDIO_TEST_API_TOKEN;
    resetRedactionCache();
  });

  it("redacts and truncates nested values", () => {
    const out = redactDeep({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'", nested: [{ long: "x".repeat(50) }] }, 20) as { command: string; nested: Array<{ long: string }> };
    assert.ok(!out.command.includes("abcdefghijklmnopqrstuvwxyz"));
    assert.match(out.nested[0].long, /more characters/);
  });
});

describe("process execution", () => {
  it("strips a parent Claude Code session from the child environment", () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "abc";
    const env = cleanEnv({ NO_COLOR: "1" });
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.NO_COLOR, "1");
    assert.ok(env.PATH ?? env.Path);
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it("passes arguments literally, never through a shell", async () => {
    const result = await run(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a b", "&& echo injected", "$(whoami)", "%PATH%", "x;y|z"], { cwd: process.cwd() });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), ["a b", "&& echo injected", "$(whoami)", "%PATH%", "x;y|z"]);
  });

  it("reports a missing command and a timeout instead of throwing", async () => {
    const missing = await run("definitely-not-a-real-command-xyz", [], { cwd: process.cwd() });
    assert.equal(missing.code, null);
    assert.match(missing.error ?? "", /not found/i);
    const slow = await run(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { cwd: process.cwd(), timeoutMs: 400 });
    assert.equal(slow.timedOut, true);
    assert.equal(which("not a valid name;rm"), null);
  });

  it("refuses shell metacharacters for .cmd launchers on Windows", { skip: process.platform !== "win32" }, async () => {
    const npm = which("npm");
    if (!npm || !/\.(cmd|bat)$/i.test(npm)) return;
    const result = await run("npm", ["--version", "& calc"], { cwd: process.cwd() });
    assert.equal(result.code, null);
    assert.match(result.error ?? "", /not allowed/);
    const ok = await run("npm", ["--version"], { cwd: process.cwd(), timeoutMs: 60000 });
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /^\d+\.\d+/);
  });
});
