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

/** Allow only safe link/image targets; everything else becomes empty. */
function safeUrl(raw: string): string {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url) || url.startsWith("#") || url.startsWith("/")) {
    // The url is embedded into an already-escaped attribute context.
    return escapeHtml(url);
  }
  return "";
}

/** Inline spans. Operates on ALREADY-ESCAPED text. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Inline code first, so its contents are not further transformed.
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Images → a safe link (avoid loading arbitrary remote images).
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (m, alt: string, url: string) => {
      const href = safeUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">🖼 ${alt || href}</a>`
        : escapeHtml(m);
    },
  );
  // Links.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (m, text: string, url: string) => {
      const href = safeUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
        : escapeHtml(m);
    },
  );
  // Bold then italic.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return out;
}

export function renderMarkdown(md: string): string {
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
      const level = heading[1]!.length;
      html.push(
        `<h${level}>${renderInline(escapeHtml(heading[2]!.trim()))}</h${level}>`,
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
      html.push(`<li>${renderInline(escapeHtml((ul ?? ol)![1]!.trim()))}</li>`);
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
        `<blockquote>${renderInline(escapeHtml(quote.join(" ")))}</blockquote>`,
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
    html.push(`<p>${renderInline(escapeHtml(para.join(" ")))}</p>`);
  }

  closeList();
  return html.join("\n");
}
