import { plainText } from "./mcp-output.mjs";

const DEFAULT_PROJECT_ID = 502;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_ACTIONABLE_STATUSES = ["active", "confirmed"];
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function buildBugWebUrl(baseUrl, bugId) {
  const url = new URL("/index.php", `${baseUrl.replace(/\/$/, "")}/`);
  url.search = new URLSearchParams({ m: "bug", f: "view", bugID: String(bugId) });
  return url.toString();
}

function accountOf(value) {
  return typeof value === "object" && value !== null ? String(value.account || "") : String(value || "");
}

function userSummary(value) {
  if (!value) return null;
  if (typeof value !== "object") return { account: String(value), realname: "" };
  return { account: value.account || "", realname: value.realname || value.name || "" };
}

function imageTags(html, source, actionId = null) {
  const images = [];
  for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || "";
    const fileId = Number(new URL(src, "http://placeholder").searchParams.get("fileID"));
    if (!Number.isSafeInteger(fileId) || fileId <= 0) continue;
    const title = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "";
    images.push({ fileId, source, actionId, title });
  }
  return images;
}

function filesOf(files) {
  if (Array.isArray(files)) return files;
  if (files && typeof files === "object") return Object.values(files);
  return [];
}

export function collectBugImages(bug) {
  const candidates = [
    ...imageTags(bug?.steps, "steps"),
    ...filesOf(bug?.files)
      .filter((file) => IMAGE_EXTENSIONS.has(String(file?.extension || "").toLowerCase()))
      .map((file) => ({
        fileId: Number(file.id),
        source: "file",
        actionId: null,
        title: file.title || "",
      })),
    ...filesOf(bug?.actions).flatMap((action) => imageTags(action?.comment, "action", action?.id ?? null)),
  ];
  const seen = new Set();
  return candidates.filter((image) => {
    if (!Number.isSafeInteger(image.fileId) || image.fileId <= 0 || seen.has(image.fileId)) return false;
    seen.add(image.fileId);
    return true;
  });
}

export function detectImageMime(bytes) {
  const has = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  if (has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (has(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (has(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || has(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return "image/gif";
  if (has(0x52, 0x49, 0x46, 0x46) && hasAt(bytes, 8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

function hasAt(bytes, offset, ...signature) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function bugDetail(bug, baseUrl, includeActions) {
  const result = {
    id: bug.id,
    title: bug.title,
    status: bug.status,
    subStatus: bug.subStatus,
    type: bug.type,
    priority: bug.pri,
    severity: bug.severity,
    confirmed: bug.confirmed,
    product: { id: bug.product, name: bug.productName || "" },
    project: { id: bug.project, name: bug.projectName || "" },
    execution: { id: bug.execution, name: bug.executionName || "" },
    module: { id: bug.module, name: bug.moduleTitle || "" },
    plan: { id: bug.plan, name: bug.planName || "" },
    openedBuild: bug.openedBuild,
    resolvedBuild: bug.resolvedBuild,
    environment: { os: bug.os, browser: bug.browser, hardware: bug.hardware },
    steps: plainText(bug.steps),
    openedBy: userSummary(bug.openedBy),
    openedDate: bug.openedDate,
    assignedTo: userSummary(bug.assignedTo),
    assignedDate: bug.assignedDate,
    deadline: bug.deadline,
    resolution: bug.resolution,
    resolvedBy: userSummary(bug.resolvedBy),
    resolvedDate: bug.resolvedDate,
    closedBy: userSummary(bug.closedBy),
    closedDate: bug.closedDate,
    activatedCount: bug.activatedCount,
    activatedDate: bug.activatedDate,
    lastEditedBy: userSummary(bug.lastEditedBy),
    lastEditedDate: bug.lastEditedDate,
    files: filesOf(bug.files).map((file) => ({
      id: file.id,
      title: file.title,
      extension: file.extension,
      size: file.size,
    })),
    webUrl: buildBugWebUrl(baseUrl, bug.id),
    images: collectBugImages(bug),
  };
  if (includeActions) {
    result.actions = filesOf(bug.actions).map((action) => ({
      id: action.id,
      actor: userSummary(action.actor),
      action: action.action,
      date: action.date,
      comment: plainText(action.comment),
    }));
  }
  return result;
}

export function createZentaoBugService({ client, baseUrl, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES }) {
  async function listProjectBugs({
    projectId = DEFAULT_PROJECT_ID,
    assigneeAccounts = [],
    includeCurrentUser = false,
    statuses = DEFAULT_ACTIONABLE_STATUSES,
    pageSize = DEFAULT_PAGE_SIZE,
  } = {}) {
    const accounts = new Set(assigneeAccounts.map((account) => String(account)).filter(Boolean));
    if (includeCurrentUser) {
      const profile = await client.get("/user");
      const currentAccount = String(profile?.profile?.account || "");
      if (!currentAccount) throw new Error("当前禅道用户账号缺失");
      accounts.add(currentAccount);
    }
    const first = await client.get(`/projects/${projectId}/bugs`, { page: 1, limit: pageSize });
    const all = [...(first.bugs || first.data || [])];
    const total = Number(first.total || all.length);
    const pages = Math.ceil(total / pageSize);
    if (pages > MAX_PAGES) throw new Error(`禅道项目 Bug 分页超过 ${MAX_PAGES} 页限制`);
    for (let page = 2; page <= pages; page += 1) {
      const data = await client.get(`/projects/${projectId}/bugs`, { page, limit: pageSize });
      all.push(...(data.bugs || data.data || []));
    }
    const actionableStatuses = new Set(statuses);
    const bugs = all
      .filter((bug) => actionableStatuses.has(bug.status) && accounts.has(accountOf(bug.assignedTo)))
      .map((bug) => ({
        id: bug.id,
        title: bug.title,
        priority: bug.pri,
        severity: bug.severity,
        status: bug.status,
        assignedTo: userSummary(bug.assignedTo),
        openedBy: userSummary(bug.openedBy),
        openedDate: bug.openedDate,
        deadline: bug.deadline,
        webUrl: buildBugWebUrl(baseUrl, bug.id),
      }));
    return { total, matched: bugs.length, bugs };
  }

  async function getBugDetail({ bugId, includeActions = false }) {
    const bug = await client.get(`/bugs/${bugId}`);
    return bugDetail(bug, baseUrl, includeActions);
  }

  async function getBugImage({ bugId, fileId }) {
    const bug = await client.get(`/bugs/${bugId}`);
    const numericFileId = Number(fileId);
    if (!collectBugImages(bug).some((image) => image.fileId === numericFileId)) {
      throw new Error(`图片不属于 Bug ${bugId}`);
    }
    const binary = await client.getBinary(`/files/${numericFileId}`, { maxBytes: maxImageBytes });
    const mimeType = detectImageMime(binary.bytes);
    if (!mimeType) throw new Error("禅道 Bug 图片格式不受支持");
    if (binary.contentType.startsWith("image/") && binary.contentType !== mimeType) {
      throw new Error("禅道 Bug 图片类型与内容不一致");
    }
    return { fileId: numericFileId, mimeType, bytes: binary.bytes };
  }

  return { listProjectBugs, getBugDetail, getBugImage };
}
