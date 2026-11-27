/**
 * Minimal, dependency-free Markdown → HTML renderer for README display.
 *
 * SECURITY: the input is UNTRUSTED (a third party's repo README). Everything is
 * HTML-escaped FIRST, then only a whitelist of our own tags is introduced, and
 * link/image URLs are scheme-checked (http/https/anchor only). No raw HTML from
 * the source is ever passed through, so the result is safe for innerHTML.
 * It intentionally supports only the common subset (headings, emphasis, code,
 * lists, quotes, rules, links) — anything else degrades to escaped text.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const URL_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** Resolve a relative link against the fetched README's source. */
function safeUrl(escaped: string, source: URL | undefined): string {
  const url = escaped
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => URL_ENTITIES[entity]!)
    .trim();
  if (/^https?:\/\//i.test(url) || url.startsWith("#")) return escapeHtml(url);
  if (!source) return url.startsWith("/") ? escapeHtml(url) : "";
  try {
    const target = new URL(url, source);
    if (
      target.protocol === source.protocol &&
      target.origin === source.origin &&
      !target.username &&
      !target.password
    ) {
      return escapeHtml(target.href);
    }
  } catch {
    // A malformed destination stays plain text.
  }
  return "";
}

function readmeSource(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    const source = new URL(url);
    if (source.protocol === "https:" && !source.username && !source.password)
      return source;
  } catch {
    // A missing or malformed base leaves the existing Markdown subset available.
  }
  return undefined;
}

function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
}

/** Inline spans. Operates on ALREADY-ESCAPED text. */
function renderInline(escaped: string, source: URL | undefined): string {
  const spans: string[] = [];
  // Source angle brackets have already been escaped. Only the renderer can
  // introduce these markers, and generated HTML never reenters emphasis parsing.
  const protect = (html: string) => `<md-span-${spans.push(html) - 1}>`;
  const restore = (html: string) =>
    html.replace(/<md-span-(\d+)>/g, (_match, index) => spans[Number(index)]!);
  let out = escaped.replace(/`([^`]+)`/g, (_match, code) =>
    protect(`<code>${code}</code>`),
  );
  // Images become links, keeping third-party images out of the page.
  out = out.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g,
    (match, image: string, label: string, url: string) => {
      if (!image && !label) return match;
      const href = safeUrl(url, source);
      if (!href) return match;
      const content = label ? restore(renderEmphasis(label)) : href;
      return protect(
        `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${image ? "🖼 " : ""}${content}</a>`,
      );
    },
  );
  return restore(renderEmphasis(out));
}

export interface RenderMarkdownOptions {
  /** Shift heading levels downward (clamped to h6) to preserve page outline. */
  readonly headingOffset?: number;
}

export function renderMarkdown(
  md: string,
  sourceUrl?: string,
  opts?: RenderMarkdownOptions,
): string {
  const source = readmeSource(sourceUrl);
  const headingOffset = Math.max(0, Math.floor(opts?.headingOffset ?? 0));
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  type ListKind = "ul" | "ol";
  let listOpen: ListKind | null = null;
  const closeList = () => {
    if (listOpen) {
      html.push(`</${listOpen}>`);
      listOpen = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = /^\s*```/.exec(line);
    if (fence) {
      closeList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // skip closing fence
      html.push(
        `<pre class="md-code"><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Blank line.
    if (/^\s*$/.test(line)) {
      closeList();
      i += 1;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1]!.length + headingOffset);
      html.push(
        `<h${level}>${renderInline(escapeHtml(heading[2]!.trim()), source)}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      html.push("<hr />");
      i += 1;
      continue;
    }

    // Unordered / ordered list item.
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind: ListKind = ul ? "ul" : "ol";
      if (listOpen && listOpen !== kind) closeList();
      if (!listOpen) {
        listOpen = kind;
        html.push(`<${kind}>`);
      }
      html.push(
        `<li>${renderInline(escapeHtml((ul ?? ol)![1]!.trim()), source)}</li>`,
      );
      i += 1;
      continue;
    }

    // Blockquote (group consecutive).
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      html.push(
        `<blockquote>${renderInline(escapeHtml(quote.join(" ")), source)}</blockquote>`,
      );
      continue;
    }

    // Paragraph (group consecutive plain lines).
    closeList();
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*```/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    html.push(`<p>${renderInline(escapeHtml(para.join(" ")), source)}</p>`);
  }

  closeList();
  return html.join("\n");
}
