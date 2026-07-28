import type { ListingSource } from "../listing-source.ts";

export interface ListingSourceContractFixture {
  readonly name: string;
  readonly input: unknown;
  readonly expected?: ListingSource;
}

/**
 * Shared executable fixtures for every TCS consumer. Keep security boundary
 * cases here instead of re-encoding subtly different client-side rules.
 */
export const TCS_LISTING_SOURCE_FIXTURES: readonly ListingSourceContractFixture[] =
  [
    {
      name: "canonical nested module preserves path case",
      input: {
        git: "https://GitHub.com/Acme/Widget.git/",
        path: "./Modules/OpenTofu/",
      },
      expected: {
        git: "https://github.com/Acme/Widget",
        path: "Modules/OpenTofu",
      },
    },
    {
      name: "empty root path canonicalizes to dot",
      input: { git: "https://example.com/acme/widget.git", path: "" },
      expected: {
        git: "https://example.com/acme/widget",
        path: ".",
      },
    },
    {
      name: "dot slash root path canonicalizes to dot",
      input: { git: "https://example.com/acme/widget", path: "./" },
      expected: {
        git: "https://example.com/acme/widget",
        path: ".",
      },
    },
    {
      name: "rejects parent traversal",
      input: { git: "https://example.com/acme/widget", path: "../secret" },
    },
    {
      name: "rejects nested parent traversal",
      input: { git: "https://example.com/acme/widget", path: "a/../secret" },
    },
    {
      name: "rejects encoded parent traversal",
      input: {
        git: "https://example.com/acme/widget",
        path: "a/%2e%2e/secret",
      },
    },
    {
      name: "rejects absolute module path",
      input: { git: "https://example.com/acme/widget", path: "/module" },
    },
    {
      name: "rejects backslash in module path",
      input: { git: "https://example.com/acme/widget", path: "Modules\\App" },
    },
    {
      name: "rejects control character in module path",
      input: {
        git: "https://example.com/acme/widget",
        path: "Modules/\u0001App",
      },
    },
    {
      name: "rejects C1 control character in module path",
      input: {
        git: "https://example.com/acme/widget",
        path: "Modules/\u0085App",
      },
    },
    {
      name: "rejects backslash in Git URL",
      input: {
        git: "https://example.com\\acme\\widget.git",
        path: ".",
      },
    },
    {
      name: "rejects Git URL query",
      input: {
        git: "https://example.com/acme/widget.git?token=secret",
        path: ".",
      },
    },
    {
      name: "rejects empty Git URL query delimiter",
      input: {
        git: "https://example.com/acme/widget.git?",
        path: ".",
      },
    },
    {
      name: "rejects Git URL fragment",
      input: {
        git: "https://example.com/acme/widget.git#main",
        path: ".",
      },
    },
    {
      name: "rejects empty Git URL fragment delimiter",
      input: {
        git: "https://example.com/acme/widget.git#",
        path: ".",
      },
    },
    {
      name: "rejects control character in Git URL",
      input: {
        git: "https://example.com/acme/\nwidget.git",
        path: ".",
      },
    },
    {
      name: "rejects C1 control character in Git URL",
      input: {
        git: "https://example.com/acme/\u0085widget.git",
        path: ".",
      },
    },
    {
      name: "rejects dashboard url alias",
      input: { url: "https://example.com/acme/widget", path: "." },
    },
    {
      name: "rejects ref authority in a listing source",
      input: {
        git: "https://example.com/acme/widget",
        ref: "main",
        path: ".",
      },
    },
  ];
