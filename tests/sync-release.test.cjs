const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  sync,
  validateManifest,
  compare,
  ORIGIN,
  REPO,
} = require("../scripts/sync-release.cjs");
const manifest = {
  version: "0.9.20",
  downloadUrl: ORIGIN + "/updates/assets/101/EclipseAssistant-0.9.20.Setup.exe",
  sourceUrl: ORIGIN + "/updates/assets/102/EclipseAssistant-v0.9.20-source.zip",
};
function fixture(options = {}) {
  const calls = [],
    network = [];
  let latest = { tag_name: "v0.9.8", draft: false, assets: [] },
    target = null;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "api") {
      if (args[1].includes("?per_page=100"))
        return JSON.stringify(target ? [target] : []);
      if (args[1].endsWith("/latest")) return JSON.stringify(latest);
      return target?.draft ? null : JSON.stringify(target);
    }
    if (args[1] === "create")
      target = {
        tag_name: "v0.9.20",
        draft: true,
        prerelease: false,
        assets: [],
      };
    if (args[1] === "upload") {
      const file = args[3],
        data = fs.readFileSync(file);
      target.assets.push({
        name: path.basename(file),
        state: "uploaded",
        size: data.length,
        digest: "sha256:" + createHash("sha256").update(data).digest("hex"),
      });
    }
    if (args[1] === "edit") {
      target.draft = false;
      latest = target;
    }
    return "";
  };
  const fetchImpl = async (url, opts) => {
    network.push({ url, opts });
    assert.equal(opts?.redirect, "error");
    assert.equal(opts?.headers?.Authorization, undefined);
    if (url.endsWith("/latest.json")) return Response.json(manifest);
    const data = Buffer.from(
      url.endsWith(".exe") ? "MZ synthetic installer" : "PK synthetic source",
    );
    return new Response(data, {
      headers: {
        "Content-Length": String(
          options.truncated ? data.length + 10 : data.length,
        ),
      },
    });
  };
  return {
    gh,
    fetchImpl,
    calls,
    network,
    setLatest: (v) => {
      latest = v;
    },
    setTarget: (v) => {
      target = v;
    },
    get target() {
      return target;
    },
  };
}
test("versions compare numerically, not lexically; only exact owned asset URLs and matching names are allowed", () => {
  assert.equal(compare("0.9.20", "0.9.8"), 1);
  assert.equal(compare("0.10.0", "0.9.20"), 1);
  for (const version of ["0.9.20-beta", "01.9.20", "<script>", "1.2"])
    assert.throws(() => validateManifest({ ...manifest, version }));
  for (const downloadUrl of [
    "https://evil.test/file.exe",
    ORIGIN + "/updates/assets/101/secrets.txt",
    manifest.downloadUrl + "?token=not-allowed",
    "http:" + manifest.downloadUrl.slice(6),
    ORIGIN + "/updates/assets/101/EclipseAssistant-0.9.19.Setup.exe",
  ])
    assert.throws(() => validateManifest({ ...manifest, downloadUrl }));
  assert.deepEqual(validateManifest(manifest), manifest);
});
test("preview makes no changes and stale channel cannot downgrade a newer public release", async () => {
  const f = fixture();
  assert.equal((await sync(f)).status, "available");
  assert.equal(f.calls.filter((a) => a[0] === "release").length, 0);
  assert.equal(f.network.length, 1);
  f.setLatest({ tag_name: "v0.9.21", draft: false, assets: [] });
  assert.equal(
    (await sync({ ...f, publish: true })).status,
    "skip-stale-channel",
  );
  assert.equal(f.calls.filter((a) => a[0] === "release").length, 0);
});
test("complete verified installer, corresponding source and checksums publish together; repeat performs no download or mutation", async () => {
  const f = fixture();
  const result = await sync({ ...f, publish: true });
  assert.equal(result.status, "published");
  assert.equal(result.version, "0.9.20");
  assert.equal(f.target.draft, false);
  assert.equal(f.target.assets.length, 3);
  assert.deepEqual(
    f.calls.filter((a) => a[0] === "release").map((a) => a[1]),
    ["create", "upload", "upload", "upload", "edit"],
  );
  assert.ok(
    f.calls.filter((a) => a[0] === "release").every((a) => a.includes(REPO)),
  );
  const count = f.calls.filter((a) => a[0] === "release").length,
    transfers = f.network.length;
  assert.equal((await sync({ ...f, publish: true })).status, "already-current");
  assert.equal(f.calls.filter((a) => a[0] === "release").length, count);
  assert.equal(f.network.length, transfers + 1);
});
test("a truncated transfer cannot publish even a draft", async () => {
  const f = fixture({ truncated: true });
  await assert.rejects(sync({ ...f, publish: true }), /Truncated/);
  assert.equal(f.target, null);
  assert.equal(f.calls.filter((a) => a[0] === "release").length, 0);
});
test("an uploaded draft without a Git tag is found and published without duplicate creation or replacement", async () => {
  const f = fixture();
  await sync({ ...f, publish: true });
  f.target.draft = true;
  f.setLatest({ tag_name: "v0.9.8", draft: false, assets: [] });
  const before = f.calls.filter(
    (a) => a[0] === "release" && a[1] !== "edit",
  ).length;
  assert.equal((await sync({ ...f, publish: true })).status, "published");
  assert.equal(f.target.draft, false);
  assert.equal(
    f.calls.filter((a) => a[0] === "release" && a[1] !== "edit").length,
    before,
  );
});
test("an existing mismatched installer is never overwritten or promoted", async () => {
  const f = fixture();
  f.setTarget({
    tag_name: "v0.9.20",
    draft: true,
    assets: [
      {
        name: "EclipseAssistant-0.9.20.Setup.exe",
        size: 1,
        digest: "sha256:" + "0".repeat(64),
        state: "uploaded",
      },
    ],
  });
  await assert.rejects(sync({ ...f, publish: true }), /refusing to overwrite/);
  assert.equal(f.calls.filter((a) => a[0] === "release").length, 0);
});
test("public workflow uses only its repo-scoped runtime token, never private-repo access or executable artifacts as code", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../scripts/sync-release.cjs"),
    "utf8",
  );
  assert.doesNotMatch(
    script,
    /--clobber|eval\(|extract(?:ToDirectory|All|Archive)\(/i,
  );
  assert.deepEqual(
    [...script.matchAll(/execFileSync\(\s*(['"])([^'"]+)\1/g)].map(
      (match) => match[2],
    ),
    ["gh"],
  );
  const workflow = fs.readFileSync(
    path.join(__dirname, "../.github/workflows/sync-release.yml"),
    "utf8",
  );
  assert.match(workflow, /7-59\/10/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|pull_request_target|EclipseReign\/EclipseAssistant/,
  );
  assert.match(workflow, /GH_TOKEN: \$\{\{ github.token \}\}/);
});
