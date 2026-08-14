import assert from "node:assert/strict";
import test from "node:test";

import {
  collectBugImages,
  createZentaoBugService,
  detectImageMime,
} from "../lib/zentao-bug-service.mjs";

test("listProjectBugs reads every page and filters accounts and actionable statuses", async () => {
  const calls = [];
  const pages = {
    1: { total: 4, bugs: [
      { id: 1, title: "keep active", status: "active", pri: 1, severity: 2, assignedTo: { account: "wangk", realname: "王昆" } },
      { id: 2, title: "drop closed", status: "closed", pri: 2, severity: 3, assignedTo: "wangk" },
    ] },
    2: { total: 4, bugs: [
      { id: 3, title: "keep confirmed", status: "confirmed", pri: 3, severity: 3, assignedTo: "czw" },
      { id: 4, title: "drop person", status: "active", pri: 2, severity: 2, assignedTo: "someone" },
    ] },
  };
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test/",
    client: { get: async (path, query) => { calls.push({ path, query }); return pages[query.page]; } },
  });
  const result = await service.listProjectBugs({
    projectId: 502,
    assigneeAccounts: ["wangk", "czw"],
    includeCurrentUser: false,
    statuses: ["active", "confirmed"],
    pageSize: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.total, 4);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.bugs.map(({ id }) => id), [1, 3]);
  assert.equal(result.bugs[0].webUrl, "http://zentao.test/index.php?m=bug&f=view&bugID=1");
});

test("listProjectBugs resolves the current account only when requested", async () => {
  const paths = [];
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: {
      get: async (path) => {
        paths.push(path);
        if (path === "/user") return { profile: { account: "niesy", realname: "聂嗣洋" } };
        return { total: 2, bugs: [
          { id: 1, status: "active", assignedTo: "niesy" },
          { id: 2, status: "active", assignedTo: "someone" },
        ] };
      },
    },
  });
  const result = await service.listProjectBugs({
    projectId: 502,
    assigneeAccounts: [],
    includeCurrentUser: true,
    statuses: ["active", "confirmed"],
  });
  assert.deepEqual(paths, ["/user", "/projects/502/bugs"]);
  assert.deepEqual(result.bugs.map(({ id }) => id), [1]);
});

test("listProjectBugs rejects a current-user profile without an account", async () => {
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: { get: async () => ({ profile: { realname: "匿名" } }) },
  });
  await assert.rejects(service.listProjectBugs({ projectId: 502, includeCurrentUser: true }), /当前禅道用户账号缺失/);
});

test("listProjectBugs rejects project responses over the page limit", async () => {
  let calls = 0;
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: { get: async () => { calls += 1; return { total: 10001, bugs: [] }; } },
  });
  await assert.rejects(service.listProjectBugs({ projectId: 502 }), /禅道项目 Bug 分页超过 100 页限制/);
  assert.equal(calls, 1);
});

test("getBugDetail extracts deduplicated images from steps files and action comments", async () => {
  const bug = {
    id: 22530,
    title: "CR differs",
    steps: '<p>step</p><img src="/index.php?m=file&f=read&t=png&fileID=10" alt="step.png">',
    files: [{ id: 11, title: "attachment.jpg", extension: "jpg", size: 20 }],
    actions: [{ id: 99, comment: '<p>comment</p><img src="/index.php?m=file&f=read&t=png&fileID=10">' }],
  };
  const service = createZentaoBugService({ baseUrl: "http://zentao.test", client: { get: async () => bug } });
  const detail = await service.getBugDetail({ bugId: 22530, includeActions: true });
  assert.equal(detail.webUrl, "http://zentao.test/index.php?m=bug&f=view&bugID=22530");
  assert.deepEqual(detail.images.map(({ fileId, source }) => [fileId, source]), [[10, "steps"], [11, "file"]]);
  assert.equal(detail.steps, "step");
  assert.equal(detail.actions[0].comment, "comment");
});

test("getBugDetail preserves the legacy string-user summaries", async () => {
  const bug = {
    id: 1,
    openedBy: "opened",
    assignedTo: "assigned",
    resolvedBy: "resolved",
    closedBy: "closed",
    lastEditedBy: "edited",
    actions: [{ id: 2, actor: "actor" }],
  };
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: { get: async () => bug },
  });

  const detail = await service.getBugDetail({ bugId: 1, includeActions: true });

  assert.deepEqual(detail.openedBy, { account: "opened" });
  assert.deepEqual(detail.assignedTo, { account: "assigned" });
  assert.deepEqual(detail.resolvedBy, { account: "resolved" });
  assert.deepEqual(detail.closedBy, { account: "closed" });
  assert.deepEqual(detail.lastEditedBy, { account: "edited" });
  assert.deepEqual(detail.actions[0].actor, { account: "actor" });
});

test("collectBugImages accepts object files and retains the first occurrence of a duplicate file", () => {
  const images = collectBugImages({
    steps: '<img src="/file?fileID=10" alt="from steps">',
    files: {
      10: { id: 10, title: "duplicate.png", extension: "png" },
      11: { id: 11, title: "photo.webp", extension: "webp" },
      12: { id: 12, title: "document.pdf", extension: "pdf" },
    },
    actions: [{ id: 8, comment: '<img src="/file?fileID=10" alt="from action">' }],
  });
  assert.deepEqual(images.map(({ fileId, source, actionId, title }) => [fileId, source, actionId, title]), [
    [10, "steps", null, "from steps"],
    [11, "file", null, "photo.webp"],
  ]);
});

test("getBugImage rejects a file that is not attached to the bug", async () => {
  let binaryCalled = false;
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: {
      get: async () => ({ id: 1, steps: '<img src="/file?fileID=10">', files: [], actions: [] }),
      getBinary: async () => { binaryCalled = true; },
    },
  });
  await assert.rejects(service.getBugImage({ bugId: 1, fileId: 12 }), /图片不属于 Bug 1/);
  assert.equal(binaryCalled, false);
});

test("getBugImage validates PNG JPEG GIF and WebP signatures", async () => {
  const signatures = [
    { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff, 0xe0] },
    { mime: "image/gif", bytes: [...Buffer.from("GIF89a")] },
    { mime: "image/webp", bytes: [...Buffer.from("RIFF1234WEBP")] },
  ];
  for (const sample of signatures) {
    const service = createZentaoBugService({
      baseUrl: "http://zentao.test",
      client: {
        get: async () => ({ id: 1, steps: '<img src="/file?fileID=10">', files: [], actions: [] }),
        getBinary: async () => ({ bytes: Uint8Array.from(sample.bytes), contentType: "application/octet-stream", contentDisposition: "" }),
      },
    });
    assert.equal((await service.getBugImage({ bugId: 1, fileId: 10 })).mimeType, sample.mime);
  }
});

test("getBugImage rejects unsupported image data and mismatched image media types", async () => {
  const createService = (bytes, contentType) => createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: {
      get: async () => ({ id: 1, steps: '<img src="/file?fileID=10">', files: [], actions: [] }),
      getBinary: async () => ({ bytes: Uint8Array.from(bytes), contentType, contentDisposition: "" }),
    },
  });
  await assert.rejects(createService([1, 2, 3], "application/octet-stream").getBugImage({ bugId: 1, fileId: 10 }), /禅道 Bug 图片格式不受支持/);
  await assert.rejects(createService([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/jpeg").getBugImage({ bugId: 1, fileId: 10 }), /禅道 Bug 图片类型与内容不一致/);
});

test("getBugImage forwards the default five MiB binary limit", async () => {
  let maxBytes;
  const service = createZentaoBugService({
    baseUrl: "http://zentao.test",
    client: {
      get: async () => ({ id: 1, steps: '<img src="/file?fileID=10">', files: [], actions: [] }),
      getBinary: async (path, options) => {
        maxBytes = options.maxBytes;
        throw new Error(`文件超过 ${options.maxBytes} 字节限制`);
      },
    },
  });
  await assert.rejects(service.getBugImage({ bugId: 1, fileId: 10 }), /文件超过 5242880 字节限制/);
  assert.equal(maxBytes, 5 * 1024 * 1024);
});

test("detectImageMime only accepts documented image signatures", () => {
  assert.equal(detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectImageMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  assert.equal(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(detectImageMime(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
  assert.equal(detectImageMime(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c])), null);
});
