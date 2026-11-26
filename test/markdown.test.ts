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

  test("preserves inline code and only formats emphasis outside literal spans", () => {
    const html = renderMarkdown(
      "**Use `oidc_owner_sub`** and `[x](https://example.com) <tag> *literal*`",
    );
    expect(html).toContain("<strong>Use <code>oidc_owner_sub</code></strong>");
    expect(html).toContain(
      "<code>[x](https://example.com) &lt;tag&gt; *literal*</code>",
    );
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<a ");
  });

  test("formats link labels without rewriting literal link destinations", () => {
    const html = renderMarkdown(
      "[`app_owner_sub` and *docs*](https://example.com/app_owner_sub)",
    );
    expect(html).toContain('href="https://example.com/app_owner_sub"');
    expect(html).toContain("<code>app_owner_sub</code> and <em>docs</em>");
  });

  test("resolves relative links from the fetched README while escaping the destination", () => {
    const source =
      "https://raw.githubusercontent.com/example/repo/HEAD/deploy/README.md";
    const html = renderMarkdown(
      "[guide](../docs/app_owner_sub.md?a=1&b=2)",
      source,
    );
    expect(html).toContain(
      'href="https://raw.githubusercontent.com/example/repo/HEAD/docs/app_owner_sub.md?a=1&amp;b=2"',
    );
    expect(renderMarkdown("[guide](../docs/guide.md)")).not.toContain("<a ");
    expect(
      renderMarkdown("[guide](//example.com/guide.md)", source),
    ).not.toContain("<a ");
    expect(
      renderMarkdown("[guide](javascript:alert%281%29)", source),
    ).not.toContain("<a ");
    expect(
      renderMarkdown(
        "[guide](blob:https://raw.githubusercontent.com/fixture)",
        source,
      ),
    ).not.toContain("<a ");
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
