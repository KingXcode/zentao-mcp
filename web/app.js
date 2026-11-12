const $ = (selector) => document.querySelector(selector);
const token = $('meta[name="zentao-session"]').content;
const descriptions = {
  codex: "桌面应用 / CLI / IDE 插件", "claude-code": "终端与 Code 会话", "claude-desktop": "桌面应用",
  cursor: "编辑器", windsurf: "编辑器", vscode: "Copilot 全局配置", "vscode-local": "Local harness / 旧版配置", gemini: "命令行助手",
};
const icons = { codex: ">_", "claude-code": "✳", "claude-desktop": "✳", cursor: "C", windsurf: "W", vscode: "V", "vscode-local": "V", gemini: "✦" };
const stateLabels = { absent: "未安装", installed: "已注册", conflict: "同名冲突", error: "配置异常" };
let state;
let busy = false;
let closed = false;
let settingsDirty = false;
const selection = new Set();

async function api(endpoint, body) {
  const response = await fetch(`/api/${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Zentao-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || "操作失败，请重试"), { results: value.results });
  return value;
}

function notify(message, failure = false) {
  const notice = $("#notice");
  notice.hidden = false;
  notice.textContent = message;
  notice.classList.toggle("failure", failure);
  notice.setAttribute("role", failure ? "alert" : "status");
}

function log(message, backupPath, failure = false) {
  $("#empty-log").hidden = true;
  const row = document.createElement("li");
  const time = document.createElement("time");
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  row.append(time, document.createTextNode(message));
  if (failure) row.className = "failure";
  if (backupPath) {
    const backup = document.createElement("code");
    backup.textContent = `备份：${backupPath}`;
    row.append(backup);
  }
  $("#activity-log").prepend(row);
}

function updateButtons() {
  const eligible = state?.agents.filter((agent) => ["installed", "absent"].includes(agent.state)) || [];
  for (const element of document.querySelectorAll("button, input")) element.disabled = busy || closed;
  for (const row of document.querySelectorAll(".agent-row")) {
    const agent = state.agents.find((value) => value.id === row.dataset.id);
    const blocked = !["installed", "absent"].includes(agent.state);
    row.querySelector(".agent-checkbox").disabled = busy || closed || blocked;
    row.querySelector(".agent-action").disabled = busy || closed || blocked;
  }
  $("#install-selected").disabled = busy || closed || !selection.size;
  $("#uninstall-selected").disabled = busy || closed || !eligible.some((agent) => selection.has(agent.id) && agent.state === "installed");
  $("#select-all").disabled = busy || closed || !eligible.length;
  $("#select-all").checked = eligible.length > 0 && eligible.every((agent) => selection.has(agent.id));
  $("#select-all").indeterminate = selection.size > 0 && !$("#select-all").checked;
  $("#selection-label").textContent = selection.size ? `已选 ${selection.size} 项` : "全选";
}

function render() {
  $("#project-path").textContent = state.projectDirectory;
  $("#installed-count").textContent = `${state.agents.filter((agent) => agent.state === "installed").length} / ${state.agents.length} 已注册`;
  const settings = state.settings;
  if (!settingsDirty) $("#base-url").value = settings.baseUrl;
  $("#connection-state").textContent = settings.baseUrl ? "已保存地址" : "待配置";
  $("#connection-state").className = `badge ${settings.baseUrl ? "installed" : "muted"}`;
  $("#credential-state").textContent = settings.hasCredentials ? "已保存" : settings.hasToken ? "已有 Token" : "可选";
  const list = $("#agent-list");
  list.replaceChildren();
  for (const agent of state.agents) {
    const fragment = $("#agent-template").content.cloneNode(true);
    const row = fragment.querySelector("article");
    row.dataset.id = agent.id;
    row.querySelector("h3").textContent = agent.label;
    row.querySelector(".agent-description").textContent = descriptions[agent.id] || agent.id;
    const icon = row.querySelector(".agent-icon");
    icon.textContent = icons[agent.id] || agent.label[0];
    icon.classList.add(`icon-${agent.id}`);
    const badge = row.querySelector(".agent-state");
    badge.textContent = stateLabels[agent.state];
    badge.classList.add(agent.state);
    row.querySelector(".config-path").textContent = agent.configPath;
    if (["conflict", "error"].includes(agent.state)) {
      selection.delete(agent.id);
      const error = row.querySelector(".agent-error");
      error.hidden = false;
      error.textContent = agent.error || "已有其他来源的 zentao。请先核对该配置，工具不会覆盖或删除它。";
      row.querySelector("details").open = true;
    }
    const checkbox = row.querySelector(".agent-checkbox");
    checkbox.setAttribute("aria-label", `选择 ${agent.label}`);
    checkbox.checked = selection.has(agent.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selection.add(agent.id); else selection.delete(agent.id);
      updateButtons();
    });
    const button = row.querySelector(".agent-action");
    const action = agent.state === "installed" ? "uninstall" : "install";
    button.textContent = ["conflict", "error"].includes(agent.state) ? "需检查" : action === "install" ? "安装" : "卸载";
    button.setAttribute("aria-label", `${action === "install" ? "安装到" : "从"} ${agent.label}${action === "uninstall" ? " 卸载" : ""}`);
    button.classList.toggle("uninstall", action === "uninstall");
    button.addEventListener("click", () => change(action, [agent.id]));
    list.append(fragment);
  }
  list.setAttribute("aria-busy", "false");
  updateButtons();
}

async function refresh() {
  state = await api("state");
  render();
}

function logResults(results, action) {
  for (const result of results || []) {
    log(`${result.label}：${result.changed ? (action === "install" ? "已安装" : "已卸载") : "无需修改"}`, result.backupPath);
  }
}

async function change(action, agents) {
  if (busy || closed) return;
  busy = true;
  updateButtons();
  try {
    const { results } = await api("change", { action, agents });
    logResults(results, action);
    notify(`${action === "install" ? "安装" : "卸载"}已完成。重新启动对应 Agent 后生效。`);
  } catch (error) {
    logResults(error.results, action);
    const message = error instanceof TypeError ? "无法连接本地工具，请检查启动窗口是否仍在运行。" : error.message;
    notify(message, true);
    log(message, null, true);
  } finally {
    busy = false;
    try { await refresh(); } catch { updateButtons(); }
  }
}

$("#select-all").addEventListener("change", (event) => {
  selection.clear();
  if (event.target.checked) for (const agent of state.agents) if (["absent", "installed"].includes(agent.state)) selection.add(agent.id);
  render();
});
$("#install-selected").addEventListener("click", () => change("install", [...selection]));
$("#uninstall-selected").addEventListener("click", () => change("uninstall", state.agents.filter((agent) => selection.has(agent.id) && agent.state === "installed").map((agent) => agent.id)));
$("#refresh").addEventListener("click", async () => {
  if (busy || closed) return;
  busy = true;
  updateButtons();
  try { await refresh(); notify("已刷新本机配置状态。此状态表示已注册，连接结果请在 Agent 中查看。"); }
  catch { notify("读取失败，请检查本地工具是否仍在运行。", true); }
  finally { busy = false; updateButtons(); }
});
$("#clear-log").addEventListener("click", () => { $("#activity-log").replaceChildren(); $("#empty-log").hidden = false; });
$("#settings-form").addEventListener("input", () => { settingsDirty = true; });
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || closed) return;
  const account = $("#account").value;
  const password = $("#password").value;
  if (password !== $("#password-confirm").value) { notify("两次密码不一致，请重新输入。", true); return; }
  busy = true;
  updateButtons();
  try {
    await api("settings", { baseUrl: $("#base-url").value, account, password });
    settingsDirty = false;
    $("#account").value = "";
    $("#password").value = "";
    $("#password-confirm").value = "";
    notify("禅道连接已保存。凭据会在首次调用工具时用于登录。已运行的 Agent 请重新启动。");
    log("禅道连接配置已保存。");
    await refresh();
  } catch (error) { notify(error instanceof TypeError ? "无法连接本地工具，请重新启动。" : error.message, true); }
  finally { busy = false; updateButtons(); }
});
$("#shutdown").addEventListener("click", async () => {
  if (busy || closed) return;
  busy = true;
  updateButtons();
  try {
    await api("shutdown", {});
    closed = true;
    $(".local-indicator").textContent = "已关闭";
    notify("本地工具已关闭，可以关闭此页面。已安装的 MCP 可继续使用。");
  } catch { notify("无法连接本地工具，可以直接关闭启动窗口。", true); }
  finally { busy = false; updateButtons(); }
});

refresh().catch(() => {
  $("#agent-list").replaceChildren();
  $("#agent-list").setAttribute("aria-busy", "false");
  notify("无法读取本机配置。请确认启动窗口仍在运行，然后点击刷新状态。", true);
});
