import { strict as assert } from "node:assert";
import { test } from "node:test";
import { win32, posix } from "node:path";
import { shortenHome, splitRelPath } from "../src/cost/aggregate.js";
import { filetypeForPath } from "../src/cost/language.js";

test("splitRelPath splits win32 relative paths on backslashes", () => {
  const rel = win32.relative("C:\\Users\\x\\dev", "C:\\Users\\x\\dev\\a\\b\\c");
  assert.deepEqual(splitRelPath(rel, "win32"), ["a", "b", "c"]);
});

test("splitRelPath accepts forward slashes on win32 too", () => {
  assert.deepEqual(splitRelPath("a/b\\c", "win32"), ["a", "b", "c"]);
});

test("splitRelPath keeps POSIX behaviour", () => {
  const rel = posix.relative("/home/x/dev", "/home/x/dev/a/b/c");
  assert.deepEqual(splitRelPath(rel, "linux"), ["a", "b", "c"]);
  assert.deepEqual(splitRelPath("a\\b/c", "linux"), ["a\\b", "c"]);
});

test("depth group key is the same for win32 and POSIX hosts at every depth", () => {
  const winParts = splitRelPath(win32.relative("C:\\r", "C:\\r\\a\\b\\c"), "win32");
  const posixParts = splitRelPath(posix.relative("/r", "/r/a/b/c"), "linux");
  for (const depth of [1, 2, 3, 5]) {
    const w = winParts.slice(0, Math.min(depth, winParts.length)).join("/");
    const p = posixParts.slice(0, Math.min(depth, posixParts.length)).join("/");
    assert.equal(w, p);
  }
});

test("shortenHome keeps the full path on win32", () => {
  assert.equal(
    shortenHome("C:\\Users\\x\\proj", "C:\\Users\\x", "win32"),
    "C:\\Users\\x\\proj",
  );
  assert.equal(shortenHome("C:\\Users\\x", "C:\\Users\\x", "win32"), "C:\\Users\\x");
});

test("shortenHome abbreviates to ~ on POSIX", () => {
  assert.equal(shortenHome("/home/x", "/home/x", "linux"), "~");
  assert.equal(shortenHome("/home/x/proj/y", "/home/x", "linux"), "~/proj/y");
  assert.equal(shortenHome("/home/xavier/p", "/home/x", "linux"), "/home/xavier/p");
  assert.equal(shortenHome("/opt/p", "/home/x", "darwin"), "/opt/p");
});

test("filetypeForPath finds the base name in Windows paths", () => {
  assert.equal(filetypeForPath("C:\\work\\app\\Dockerfile"), "Dockerfile");
  assert.equal(filetypeForPath("C:\\work\\app\\GNUmakefile"), "Makefile");
  assert.equal(filetypeForPath("C:\\work\\app\\Main.TS"), ".ts");
  assert.equal(filetypeForPath("C:/work\\app/CMakeLists.txt"), "CMakeLists.txt");
});

test("filetypeForPath keeps POSIX behaviour", () => {
  assert.equal(filetypeForPath("/work/app/Dockerfile"), "Dockerfile");
  assert.equal(filetypeForPath("Makefile"), "Makefile");
  assert.equal(filetypeForPath("/work/app/x.rs"), ".rs");
  assert.equal(filetypeForPath("/work/app/.bashrc"), "<no ext>");
});
