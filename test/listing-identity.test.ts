import { describe, expect, test } from "bun:test";
import { listingIdentity } from "../spec/listing.ts";

describe("listingIdentity", () => {
  test("normalizes host case, trailing .git and slashes", () => {
    const a = listingIdentity({
      git: "https://GitHub.com/tako0614/yurucommu.git/",
      path: "/sub/",
    });
    const b = listingIdentity({
      git: "https://github.com/tako0614/yurucommu",
      path: "sub",
    });
    expect(a).toBe(b);
  });

  test("ignores version selection and keys by repository path", () => {
    const a = listingIdentity({
      git: "https://github.com/x/y.git",
      path: "",
    });
    const b = listingIdentity({
      git: "https://github.com/x/y.git",
      path: ".",
    });
    expect(a).toBe(b);
  });

  test("different paths in the same repo are distinct", () => {
    const base = { git: "https://github.com/x/y.git" };
    expect(listingIdentity({ ...base, path: "a" })).not.toBe(
      listingIdentity({ ...base, path: "b" }),
    );
  });
});
