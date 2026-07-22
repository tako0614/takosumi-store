import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../web/src/lib/markdown.ts";

describe("renderMarkdown (safe README renderer)", () => {
  test("escapes raw HTML so scripts cannot execute", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders headings, bold, and inline code", () => {
    const html = renderMarkdown("# Title\n\nsome **bold** and `code`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  test("renders http(s) links but drops dangerous schemes", () => {
    const ok = renderMarkdown("[site](https://example.com)");
    expect(ok).toContain('href="https://example.com"');
    expect(ok).toContain("nofollow");

    // The dangerous link is left as inert escaped text — never an anchor.
    const bad = renderMarkdown("[x](javascript:alert(1))");
    expect(bad).not.toContain('href="javascript:');
    expect(bad).not.toContain("<a ");
  });

  test("renders fenced code blocks with escaped contents", () => {
    const html = renderMarkdown("```\n<b>not bold</b>\n```");
    expect(html).toContain('<pre class="md-code">');
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
  });

  test("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol>");
  });
});
