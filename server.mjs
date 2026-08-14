import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createMcpOutput } from "./lib/mcp-output.mjs";
import { createRuntimeClient } from "./lib/runtime-client.mjs";
import { createZentaoBugService } from "./lib/zentao-bug-service.mjs";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(projectDirectory, ".env");
const credentialLauncherPath = path.join(
  projectDirectory,
  "scripts",
  "configure-credentials.command",
);
const client = createRuntimeClient({
  envPath,
  launcherPath: credentialLauncherPath,
  fetchImpl: fetch,
});
const bugService = createZentaoBugService({ client, baseUrl: client.baseUrl });

const zentaoGet = (path, query) => client.get(path, query);
const { ok, fail, image } = createMcpOutput(
  client.redactOutbound,
  client.containsOutboundSecret,
);

function accountOf(user) {
  if (!user) return "";
  return typeof user === "object" ? String(user.account || "") : String(user);
}

async function getAllProductBugs(productId) {
  const pageSize = 100;
  const first = await zentaoGet(`/products/${productId}/bugs`, { page: 1, limit: pageSize });
  const bugs = [...(first.bugs || [])];
  const total = Number(first.total || bugs.length);
  const totalPages = Math.min(Math.ceil(total / pageSize), 100);

  for (let page = 2; page <= totalPages; page += 1) {
    const data = await zentaoGet(`/products/${productId}/bugs`, { page, limit: pageSize });
    bugs.push(...(data.bugs || []));
  }
  return bugs;
}

const server = new McpServer(
  { name: "company-zentao", version: "0.1.0" },
  {
    instructions:
      "这是公司禅道的只读查询服务。优先使用列表工具获取 ID；不要根据名称猜测 ID。",
  },
);

server.registerTool(
  "list_projects",
  {
    title: "查询禅道项目列表",
    description: "查询当前账号有权查看的禅道项目，可按状态筛选。",
    inputSchema: {
      status: z.enum(["all", "undone", "wait", "doing", "suspended", "closed"]).default("all"),
      page: z.number().int().positive().default(1),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ status, page, limit }) => {
    try {
      const data = await zentaoGet("/projects", {
        status,
        page,
        limit,
      });
      const projects = (data.projects || data.data || []).map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        begin: item.begin,
        end: item.end,
        PM: item.PM,
      }));
      return ok({ page: data.page || page, total: data.total, projects });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_products",
  {
    title: "查询禅道产品列表",
    description: "查询当前 Token 账号有权查看的禅道产品及其产品 ID。查询 Bug 前应先调用此工具确认产品 ID。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async () => {
    try {
      const data = await zentaoGet("/products");
      const products = (data.products || data.data || []).map((item) => ({
        id: item.id,
        name: item.name,
        code: item.code,
        status: item.status,
        type: item.type,
      }));
      return ok({ products });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_product_bugs",
  {
    title: "查询禅道产品 Bug",
    description: "根据禅道产品 ID 查询 Bug，可只返回尚未关闭的问题。",
    inputSchema: {
      productId: z.number().int().positive().describe("禅道产品 ID"),
      status: z.enum(["all", "unclosed", "unresolved", "assigntome"]).default("unclosed"),
      page: z.number().int().positive().default(1),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ productId, status, page, limit }) => {
    try {
      try {
        await zentaoGet(`/products/${productId}`);
      } catch (error) {
        throw new Error(
          `产品 ${productId} 不存在，或当前 Token 账号没有查看该产品的权限。请先调用 list_products 获取可访问的产品 ID。原始错误：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const [allBugs, profileData] = await Promise.all([
        getAllProductBugs(productId),
        status === "assigntome" ? zentaoGet("/user") : Promise.resolve(null),
      ]);
      const currentAccount = profileData?.profile?.account || "";
      const filteredBugs = allBugs.filter((bug) => {
        if (status === "all") return true;
        if (status === "assigntome") return accountOf(bug.assignedTo) === currentAccount;
        if (status === "unresolved") return bug.status === "active";
        if (status === "unclosed") return bug.status !== "closed";
        return true;
      });
      const start = (page - 1) * limit;
      const bugs = filteredBugs.slice(start, start + limit).map((bug) => ({
        id: bug.id,
        title: bug.title,
        priority: bug.pri,
        severity: bug.severity,
        status: bug.status,
        assignedTo: bug.assignedTo,
        openedBy: bug.openedBy,
        openedDate: bug.openedDate,
        deadline: bug.deadline,
      }));
      return ok({ page, total: filteredBugs.length, limit, bugs });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_project_bugs",
  {
    title: "查询禅道项目 Bug",
    description: "按项目、状态和指派人账号查询全部匹配 Bug，并返回可点击禅道链接。",
    inputSchema: {
      projectId: z.number().int().positive().default(502),
      assigneeAccounts: z.array(z.string().min(1)).default([]),
      includeCurrentUser: z.boolean().default(false),
      statuses: z.array(z.enum(["active", "confirmed", "resolved", "closed", "delay", "postponed"]))
        .default(["active", "confirmed"]),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (args) => {
    try {
      return ok(await bugService.listProjectBugs(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_bug_detail",
  {
    title: "查询禅道 Bug 详情",
    description:
      "根据 Bug ID 读取完整详情，包括标题、描述/重现步骤、环境、所属产品项目、版本、指派与解决信息、附件；可选返回操作历史。",
    inputSchema: {
      bugId: z.number().int().positive().describe("禅道 Bug ID"),
      includeActions: z.boolean().default(false).describe("是否包含操作历史，默认不包含以减少返回内容"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (args) => {
    try {
      return ok(await bugService.getBugDetail(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_bug_image",
  {
    title: "读取禅道 Bug 图片",
    description: "读取确认属于指定 Bug 正文、附件或操作历史的图片。",
    inputSchema: {
      bugId: z.number().int().positive(),
      fileId: z.number().int().positive(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (args) => {
    try {
      const result = await bugService.getBugImage(args);
      return image(result.bytes, result.mimeType);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_execution_tasks",
  {
    title: "查询禅道迭代任务",
    description: "根据执行/迭代 ID 查询任务列表。",
    inputSchema: {
      executionId: z.number().int().positive().describe("禅道执行或迭代 ID"),
      status: z.enum(["all", "unclosed", "assignedtome", "myinvolved", "assignedbyme"]).default("unclosed"),
      page: z.number().int().positive().default(1),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ executionId, status, page, limit }) => {
    try {
      const data = await zentaoGet(`/executions/${executionId}/tasks`, {
        status,
        page,
        limit,
      });
      const tasks = (data.tasks || data.data || []).map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        priority: task.pri,
        assignedTo: task.assignedTo,
        estimate: task.estimate,
        consumed: task.consumed,
        left: task.left,
        deadline: task.deadline,
      }));
      return ok({ page: data.page || page, total: data.total, tasks });
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
