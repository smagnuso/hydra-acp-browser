import { test } from "node:test";
import assert from "node:assert/strict";

const { renderMarkdown, linkifyFilePaths } = await import("../src/ui/markdown.js");

const mentions = new Map([
  ["src/foo.ts", { relPath: "src/foo.ts" }],
  ["src/foo.ts:42", { relPath: "src/foo.ts", line: 42 }],
  ["README.md", { relPath: "README.md" }],
]);

function render(src: string): string {
  return linkifyFilePaths(renderMarkdown(src), mentions);
}

test("a confirmed mention becomes a file link", () => {
  const html = render("see src/foo.ts for detail");
  assert.match(html, /<a class="file-link" href="#" data-path="src\/foo\.ts">src\/foo\.ts<\/a>/);
});

test("a line suffix rides along as data-line", () => {
  const html = render("see src/foo.ts:42 now");
  assert.match(html, /data-path="src\/foo\.ts" data-line="42">src\/foo\.ts:42<\/a>/);
});

test("the longest matching mention wins over its own prefix", () => {
  // "src/foo.ts" is also a key; linking that first would leave a
  // stranded ":42" outside the anchor.
  const html = render("at src/foo.ts:42.");
  assert.match(html, />src\/foo\.ts:42<\/a>/);
  assert.doesNotMatch(html, />src\/foo\.ts<\/a>:42/);
});

test("an unconfirmed path stays plain text", () => {
  const html = render("see src/other.ts for detail");
  assert.doesNotMatch(html, /file-link/);
});

test("a path inside a fenced code block is left alone", () => {
  const html = render("```ts\nimport x from 'src/foo.ts';\n```");
  assert.doesNotMatch(html, /file-link/);
});

test("a highlighted fenced block keeps its own markup intact", () => {
  const html = render("```ts\nconst p = 'src/foo.ts';\n```");
  assert.doesNotMatch(html, /file-link/);
  assert.match(html, /<pre><code class="hljs"/);
});

test("a code span that is only a path still links", () => {
  // Same reasoning as autolink's URL-in-backticks case: agents wrap
  // paths in backticks constantly, and leaving those dead makes the
  // common case unclickable.
  const html = render("open `src/foo.ts` please");
  assert.match(html, /<code><a class="file-link"/);
});

test("a code span holding a command stays verbatim", () => {
  const html = render("run `cat src/foo.ts` now");
  assert.match(html, /<code>cat src\/foo\.ts<\/code>/);
});

test("an existing markdown link is not re-linkified", () => {
  const html = render("[src/foo.ts](https://example.com/x)");
  assert.doesNotMatch(html, /file-link/);
  assert.match(html, /<a href="https:\/\/example\.com\/x"/);
});

test("a mention is not matched inside a longer path", () => {
  const html = render("vendor/src/foo.ts.bak is stale");
  assert.doesNotMatch(html, /file-link/);
});

test("a mention inside an attribute is never spliced", () => {
  // README.md is a confirmed mention and also appears in a fenced
  // block's data-lang-adjacent markup; nothing outside text content
  // should ever be rewritten.
  const html = linkifyFilePaths('<img alt="README.md"><p>README.md</p>', mentions);
  assert.match(html, /<img alt="README\.md">/);
  assert.match(html, /<p><a class="file-link"[^>]*>README\.md<\/a><\/p>/);
});

test("an empty mention map is a no-op", () => {
  const html = renderMarkdown("see src/foo.ts");
  assert.equal(linkifyFilePaths(html, new Map()), html);
});

// ---- Authored markdown links (the file-links skill's mandated form) ----
// These are NOT stat-verified: an authored link is a deliberate
// assertion, so they render without any entry in the mention map.

const noMentions = new Map<string, { relPath: string; line?: number; lineEnd?: number }>();

function md(src: string): string {
  return linkifyFilePaths(renderMarkdown(src), noMentions);
}

test("the skill's single-line form renders as a file link", () => {
  const html = md("[src/foo.ts:42](src/foo.ts#L42)");
  assert.match(
    html,
    /<a class="file-link" href="#" data-path="src\/foo\.ts" data-line="42">src\/foo\.ts:42<\/a>/,
  );
  // No leftover markdown punctuation around it.
  assert.doesNotMatch(html, /\[src\/foo\.ts:42\]/);
});

test("the skill's range form keeps both ends", () => {
  const html = md("[src/foo.ts:42-50](src/foo.ts#L42-L50)");
  assert.match(html, /data-path="src\/foo\.ts" data-line="42" data-line-end="50"/);
  assert.match(html, />src\/foo\.ts:42-50<\/a>/);
});

test("the lenient #L42-50 form parses, matching the TUI's regex", () => {
  assert.match(md("[x](src/foo.ts#L42-50)"), /data-line="42" data-line-end="50"/);
});

test("the skill's no-line form renders as a file link", () => {
  const html = md("[src/foo.ts](src/foo.ts)");
  assert.match(html, /<a class="file-link" href="#" data-path="src\/foo\.ts">/);
  assert.doesNotMatch(html, /data-line/);
});

test("a ./-prefixed path no longer escapes the SPA", () => {
  // Regression: this used to render target="_blank" pointing at a path
  // the browser server doesn't serve, so clicking left the app for a 404.
  const html = md("[x](./src/foo.ts#L42)");
  assert.doesNotMatch(html, /target="_blank"/);
  assert.match(html, /data-path="src\/foo\.ts" data-line="42"/);
});

test("an absolute path is left absolute for the server to scope-check", () => {
  assert.match(md("[x](/abs/foo.ts#L7)"), /data-path="\/abs\/foo\.ts" data-line="7"/);
});

test("a file:// URL is stripped to its path", () => {
  assert.match(md("[x](file:///abs/foo.ts#L7)"), /data-path="\/abs\/foo\.ts" data-line="7"/);
});

test("real web links are untouched, #L fragment or not", () => {
  for (const src of ["[x](https://example.com/a#L42)", "[x](http://example.com/b)"]) {
    const html = md(src);
    assert.match(html, /target="_blank"/);
    assert.doesNotMatch(html, /file-link/);
  }
});

test("a hydra session link still wins over file-ref parsing", () => {
  const html = md("[s](hydra://sessions/abc123)");
  assert.match(html, /<a href="#\/session\/abc123">/);
  assert.doesNotMatch(html, /file-link/);
});

test("a non-#L fragment is not a file reference", () => {
  const html = md("[x](guide.md#installation)");
  assert.doesNotMatch(html, /file-link/);
});

test("an ordinary relative link with no path shape stays as it was", () => {
  assert.doesNotMatch(md("[click](somewhere)"), /file-link/);
});

test("an authored link inside a fenced block is still left alone", () => {
  assert.doesNotMatch(md("```\n[x](src/foo.ts#L42)\n```"), /file-link/);
});
