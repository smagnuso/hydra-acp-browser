// Tiny XSS-safe markdown renderer. Caller passes the result to
// `element.innerHTML`; the rendering escapes all input text up-front so
// only this file's own tags reach the DOM.

import { highlightFenced } from "./hljs.js";

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Bare URLs. Agents emit them constantly without markdown link syntax,
// and unlinked they're useless on a phone — you can't even select them
// cleanly. Input here is already escaped, so `&` reads as `&amp;`; that
// is also what an href wants, so it passes through untouched.
function linkifyPlain(s: string): string {
  return s.replace(/\bhttps?:\/\/[^\s<]+/g, (raw) => {
    let url = raw;
    let trail = "";
    // Trailing punctuation is nearly always the sentence's, not the
    // URL's. The entities are what escapeHtml made of quotes.
    for (;;) {
      const m = url.match(/(&quot;|&#39;|&gt;|[.,;:!?'\]}"])$/);
      if (!m) break;
      trail = m[0] + trail;
      url = url.slice(0, -m[0].length);
    }
    // A closing paren only belongs to the sentence if it has no opener
    // inside the URL — wikipedia-style paths legitimately end in one.
    while (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
      trail = ")" + trail;
      url = url.slice(0, -1);
    }
    if (!url) return raw;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
}

// Linkify only the stretches that aren't already inside a tag this
// renderer produced: never rewrite the innards of a markdown link, and
// leave <code> alone EXCEPT when the span is nothing but a URL. Agents
// habitually wrap a bare link in backticks, and treating that as
// literal makes the common case unclickable, while a code span holding
// a command (`curl https://…`) still stays verbatim.
function autolink(s: string): string {
  const protectedSpan = /<code>([\s\S]*?)<\/code>|<a\b[^>]*>[\s\S]*?<\/a>/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = protectedSpan.exec(s)) !== null) {
    out += linkifyPlain(s.slice(last, m.index));
    const codeInner = m[1];
    if (codeInner !== undefined && /^https?:\/\/[^\s<]+$/.test(codeInner.trim())) {
      out += `<code>${linkifyPlain(codeInner)}</code>`;
    } else {
      out += m[0];
    }
    last = m.index + m[0].length;
  }
  return out + linkifyPlain(s.slice(last));
}

export interface FileMention {
  relPath: string;
  line?: number;
  lineEnd?: number;
}

export interface FileRef {
  path: string;
  line?: number;
  lineEnd?: number;
}

// Matching is identical to the TUI's fragment parser (cli's
// screen.ts:5096 and :5404, `/^(.*?)#L(\d+)(?:-L?\d+)?$/`) so the two
// clients can't drift on what counts as a line reference: #L42,
// #L42-L50 and the lenient #L42-50 all parse. The only difference is
// that we capture the range end instead of discarding it — the TUI
// drops it because it's launching an editor at a single line, while we
// have a gutter to shade.
const LINE_FRAGMENT_RE = /^(.*?)#L(\d+)(?:-L?(\d+))?$/;

// Either a path separator or a dot-extension, mirroring the server's
// own qualifies() heuristic (file-mentions.ts) so prose scanning and
// authored links agree on what's path-shaped.
function pathShaped(path: string): boolean {
  return path.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(path);
}

// A markdown link URL that points at a file in the session's project
// rather than out at the web: scheme-less (or file://), optionally with
// a GitHub-style #L fragment. This is the form the file-links skill
// tells agents to emit, and the convention the TUI already follows —
// there is no hydra:// file scheme to match.
export function parseFileRefUrl(url: string): FileRef | null {
  let raw = url;
  if (/^file:\/\//i.test(raw)) {
    // Strip scheme and any host, as the TUI does before parsing.
    raw = raw.slice(7).replace(/^[^/]*/, "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // http(s), mailto, hydra://… — not ours.
    return null;
  }
  if (raw === "" || raw.startsWith("//") || raw.startsWith("#")) {
    return null;
  }
  const frag = LINE_FRAGMENT_RE.exec(raw);
  const path = (frag ? frag[1]! : raw).replace(/^\.\//, "");
  if (!path) return null;
  // Some other kind of fragment (#section) isn't a file reference.
  if (!frag && raw.includes("#")) return null;
  // An explicit #L fragment is signal enough on its own; without one we
  // fall back to shape, so an ordinary relative link like [x](somewhere)
  // keeps rendering the way it does today.
  if (!frag && !pathShaped(path)) return null;
  const line = frag ? Number(frag[2]) : undefined;
  const endRaw = frag?.[3];
  const lineEnd = endRaw === undefined ? undefined : Number(endRaw);
  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
  };
}

// Shared by both link sources (authored markdown links and confirmed
// prose mentions) so they produce byte-identical markup, and so the one
// delegated tap handler in main.ts covers both.
function fileLinkHtml(ref: FileRef, label: string, escapePath: boolean): string {
  const path = escapePath ? escapeHtml(ref.path) : ref.path;
  const lineAttr = ref.line === undefined ? "" : ` data-line="${ref.line}"`;
  const endAttr = ref.lineEnd === undefined ? "" : ` data-line-end="${ref.lineEnd}"`;
  return `<a class="file-link" href="#" data-path="${path}"${lineAttr}${endAttr}>${label}</a>`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turn server-confirmed file mentions into links into the Files preview.
// Runs over finished HTML (after renderMarkdown), so it has to skip
// anything that isn't plain text content: tags themselves, so a mention
// can't be spliced into an attribute; <pre> blocks wholesale, since a
// path inside example code or a diff isn't a reference to follow; and
// existing <a>s, which can't nest. The one <code> exception mirrors
// autolink's: agents habitually wrap a lone path in backticks, and
// treating that as literal makes the common case unclickable, while a
// code span holding a command stays verbatim.
//
// `mentions` is keyed by the exact substring the server matched, so this
// pass never decides for itself what looks like a path — an entry only
// exists if the server statted a real file for it.
export function linkifyFilePaths(html: string, mentions: Map<string, FileMention>): string {
  if (mentions.size === 0) {
    return html;
  }
  // Longest first so "src/a.ts:42" wins over its own "src/a.ts" prefix.
  const alternation = [...mentions.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  // Leading boundary is a consumed character rather than a lookbehind:
  // iOS Safari only grew lookbehind in 16.4 and this is a phone-first UI.
  const mentionRe = new RegExp(`(^|[^\\w/.-])(${alternation})(?![\\w/-])`, "g");
  const linkify = (text: string): string =>
    text.replace(mentionRe, (_m, before: string, raw: string) => {
      const hit = mentions.get(raw);
      if (!hit) return _m;
      // relPath comes off the wire unescaped, unlike inlineMd's input.
      const ref = { path: hit.relPath, line: hit.line, lineEnd: hit.lineEnd };
      return `${before}${fileLinkHtml(ref, raw, true)}`;
    });
  const skip = /<pre\b[\s\S]*?<\/pre>|<code\b[^>]*>([\s\S]*?)<\/code>|<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = skip.exec(html)) !== null) {
    out += linkify(html.slice(last, m.index));
    const codeInner = m[1];
    out +=
      codeInner !== undefined && mentions.has(codeInner.trim())
        ? m[0].replace(codeInner, linkify(codeInner))
        : m[0];
    last = m.index + m[0].length;
  }
  return out + linkify(html.slice(last));
}

// Apply inline markdown to a chunk of *already-escaped* HTML.
function inlineMd(s: string): string {
  // Code spans first so their content isn't further transformed.
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // Bold + italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  // Markdown links [text](url) — accepts http(s)://, relative paths,
  // and hydra://sessions/<id> (rewritten to in-app SPA navigation).
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    // Hydra session link: rewrite to same-page hash route so clicking
    // navigates the SPA to that session instead of opening a new tab.
    // Accepts the permissive shape hydra://[<host>:<port>/]sessions/<id>[#turn-<n>]
    // to match the TUI parser; host and turn fragment are dropped in v1.
    const hydraMatch = url.match(/^hydra:\/\/(?:[^/\s]+\/)?sessions\/([A-Za-z0-9_-]+)(?:#turn-\d+)?$/);
    if (hydraMatch) {
      const sid = hydraMatch[1]!;
      return `<a href="#/session/${escapeHtml(sid)}">${text}</a>`;
    }
    // An authored file link is a deliberate assertion, so unlike prose
    // scanning it isn't stat-verified here: the click goes through
    // /api/files/read, which still enforces the cwd boundary and shows
    // the overlay's error state for a path that isn't there. Bonus, it
    // renders on first paint instead of waiting for the turn-end scan.
    const fileRef = parseFileRefUrl(url);
    if (fileRef) {
      // url arrived already escaped (see this function's contract), so
      // re-escaping the path would double-encode it.
      return fileLinkHtml(fileRef, text, false);
    }
    if (!/^(https?:\/\/|\/|\.)/i.test(url)) {
      return `[${text}](${url})`;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Last: everything above has already produced its anchors, so this
  // can skip them rather than nesting one inside another.
  return autolink(s);
}

// Parse a `| a | b | c |` row into trimmed cell strings, or null if
// the line doesn't look like a table row. Leading/trailing pipes are
// optional. Escaped pipes (`\|`) aren't supported — none of the
// agents we drive emit them in tables.
function parseTableRow(s: string): string[] | null {
  const trimmed = s.trim();
  if (!trimmed.includes("|")) return null;
  let stripped = trimmed;
  if (stripped.startsWith("|")) stripped = stripped.slice(1);
  if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
  return stripped.split("|").map((c) => c.trim());
}

// Returns alignment array (one per cell) if `s` is a table separator
// like `|---|:---:|---:|`, else null. Also asserts at least one cell
// has hyphens — protects against false-positives on lines like `|||`.
function parseTableSeparator(s: string): Array<"left" | "center" | "right" | null> | null {
  const cells = parseTableRow(s);
  if (!cells || cells.length === 0) return null;
  const aligns: Array<"left" | "center" | "right" | null> = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

function renderCodeBlock(code: string, lang: string): string {
  const highlighted = highlightFenced(code, lang);
  const langAttr = escapeHtml(lang);
  const codeAttrs = highlighted !== null ? ` class="hljs" data-lang="${langAttr}"` : ` data-lang="${langAttr}"`;
  const body = highlighted ?? escapeHtml(code);
  return `<pre><code${codeAttrs}>${body}</code></pre>`;
}

function renderTableRow(
  cells: string[],
  aligns: Array<"left" | "center" | "right" | null>,
  tag: "th" | "td",
): string {
  let out = "<tr>";
  for (let i = 0; i < cells.length; i++) {
    const align = aligns[i] ?? null;
    const styleAttr = align ? ` style="text-align:${align}"` : "";
    out += `<${tag}${styleAttr}>${inlineMd(escapeHtml(cells[i]!))}</${tag}>`;
  }
  out += "</tr>";
  return out;
}

export function renderMarkdown(src: unknown): string {
  if (typeof src !== "string") {
    src = String(src ?? "");
  }
  const lines = (src as string).split("\n");
  let out = "";
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;
  // Buffered rather than emitted immediately: a hard-wrapped source line
  // (an item's text continuing on the next line, indented under the
  // marker) doesn't itself look like a new list item, so it needs to
  // append to the item still being built rather than force it closed.
  let listItemLines: string[] = [];
  let para: string[] = [];

  function flushPara(): void {
    if (para.length === 0) return;
    out += `<p>${inlineMd(para.join(" "))}</p>`;
    para = [];
  }
  function flushListItem(): void {
    if (listItemLines.length === 0) return;
    out += `<li>${inlineMd(listItemLines.join(" "))}</li>`;
    listItemLines = [];
  }
  function closeList(): void {
    if (listType) {
      flushListItem();
      out += `</${listType}>`;
      listType = null;
    }
  }

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    if (inCode) {
      if (/^```/.test(raw)) {
        out += renderCodeBlock(codeBuf.join("\n"), codeLang);
        inCode = false;
        codeBuf = [];
        codeLang = "";
        i++;
        continue;
      }
      codeBuf.push(raw);
      i++;
      continue;
    }
    if (/^```/.test(raw)) {
      flushPara();
      closeList();
      inCode = true;
      codeLang = raw.slice(3).trim();
      i++;
      continue;
    }
    // GFM table: header row followed by a separator row, then any
    // number of body rows. Detected by looking ahead at the next line.
    if (i + 1 < lines.length && raw.includes("|")) {
      const headerCells = parseTableRow(raw);
      const aligns = parseTableSeparator(lines[i + 1]!);
      if (
        headerCells &&
        aligns &&
        headerCells.length > 0 &&
        // Most agents emit equal-cell-count tables; pad/truncate
        // gracefully if the separator's count differs.
        aligns.length > 0
      ) {
        flushPara();
        closeList();
        const cols = Math.max(headerCells.length, aligns.length);
        const paddedAligns: Array<"left" | "center" | "right" | null> = [];
        for (let c = 0; c < cols; c++) paddedAligns.push(aligns[c] ?? null);
        out += "<table><thead>";
        out += renderTableRow(headerCells, paddedAligns, "th");
        out += "</thead><tbody>";
        let j = i + 2;
        while (j < lines.length) {
          const rowCells = parseTableRow(lines[j]!);
          if (!rowCells) break;
          out += renderTableRow(rowCells, paddedAligns, "td");
          j++;
        }
        out += "</tbody></table>";
        i = j;
        continue;
      }
    }
    if (/^\s*$/.test(raw)) {
      flushPara();
      closeList();
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,3})\s+(.+)$/))) {
      flushPara();
      closeList();
      const level = m[1]!.length;
      out += `<h${level}>${inlineMd(escapeHtml(m[2]!))}</h${level}>`;
      i++;
      continue;
    }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out += "<ul>";
        listType = "ul";
      } else {
        flushListItem();
      }
      listItemLines.push(escapeHtml(m[1]!));
      i++;
      continue;
    }
    if ((m = raw.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out += "<ol>";
        listType = "ol";
      } else {
        flushListItem();
      }
      listItemLines.push(escapeHtml(m[1]!));
      i++;
      continue;
    }
    if ((m = raw.match(/^\s*>\s?(.*)$/))) {
      flushPara();
      closeList();
      out += `<blockquote>${inlineMd(escapeHtml(m[1]!))}</blockquote>`;
      i++;
      continue;
    }
    // A non-blank line that doesn't start any other block: inside a
    // list this is a wrapped continuation of the item in progress
    // (CommonMark's "lazy continuation"), not a new paragraph.
    if (listType !== null) {
      listItemLines.push(escapeHtml(raw.trim()));
      i++;
      continue;
    }
    para.push(escapeHtml(raw));
    i++;
  }
  if (inCode) {
    out += renderCodeBlock(codeBuf.join("\n"), codeLang);
  }
  flushPara();
  closeList();
  return out;
}

// Inline-only formatting for synthetic CLI-style text (`.body.raw`):
// links (including hydra:// session links), code spans, bold/italic, and
// bare-URL autolinking, but no block-level parsing — so the literal line
// breaks and indentation that make it "raw" still survive.
export function renderInlineMarkdown(src: unknown): string {
  const s = typeof src === "string" ? src : String(src ?? "");
  return inlineMd(escapeHtml(s));
}

// Best-effort flatten of an ACP content blob (string | array | object)
// into a string. Lives here because it's used in multiple places that
// also lean on markdown.
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(contentToText).join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}
