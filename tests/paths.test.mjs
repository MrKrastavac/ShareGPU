import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { safeWorkspacePath, workspaceDir } from "../src/compute.mjs";

const LEASE = "11111111-2222-3333-4444-555555555555";

test("ordinary relative paths resolve inside the workspace", () => {
  for (const rel of ["out.txt", "sub/dir/model.pt", "./a/b.json"]) {
    const resolved = safeWorkspacePath(LEASE, rel);
    assert.ok(resolved, rel);
    assert.ok(resolved.startsWith(path.resolve(workspaceDir(LEASE)) + path.sep), rel);
  }
});

test("traversal outside the workspace is refused", () => {
  for (const rel of [
    "../../../etc/passwd",
    "../../secrets",
    "a/../../../..",
    "/etc/passwd",
    "sub/../../escape",
  ]) {
    const resolved = safeWorkspacePath(LEASE, rel);
    if (resolved !== null) {
      assert.ok(
        resolved.startsWith(path.resolve(workspaceDir(LEASE))),
        `${rel} escaped to ${resolved}`,
      );
    }
  }
});

test("an absolute path is treated as relative to the workspace, not the root", () => {
  const resolved = safeWorkspacePath(LEASE, "/etc/passwd");
  assert.ok(resolved.startsWith(path.resolve(workspaceDir(LEASE))));
  assert.ok(!resolved.startsWith("/etc/"));
});
