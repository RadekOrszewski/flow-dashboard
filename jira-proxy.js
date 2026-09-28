const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "jira-proxy" });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/jira/projects") {
      const body = await readJson(req);
      const client = createJiraClient(body);
      await validateIdentity(client);
      const projects = await fetchAccessibleProjects(client);
      sendJson(res, 200, { projects });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/jira/lead-times") {
      const body = await readJson(req);
      const client = createJiraClient(body);
      const projectKey = String(body.projectKey || "").trim().toUpperCase();
      if (!projectKey) {
        throw createHttpError(400, "Missing project key.");
      }

      await validateIdentity(client);
      await validateProject(client, projectKey);
      const issues = await fetchAllResolvedIssues(client, projectKey);
      const issuesWithStatusHistory = await enrichIssuesWithChangelog(client, issues);
      sendJson(res, 200, {
        projectKey,
        issues: issuesWithStatusHistory
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/jira/changelog/bulkfetch") {
      const body = await readJson(req);
      const client = createJiraClient(body);
      const payload = await fetchBulkChangelogPage(client, body.payload || {});
      sendJson(res, 200, payload);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    sendJson(res, status, {
      error: error.message || "Unexpected error",
      code: error.code || "UNEXPECTED_ERROR",
      details: error.details || null
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`jira-proxy listening on http://${HOST}:${PORT}`);
});

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", DEFAULT_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(createHttpError(413, "Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(createHttpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function createJiraClient(body) {
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const email = String(body.email || "").trim();
  const token = String(body.token || "").trim();

  if (!baseUrl) {
    throw createHttpError(400, "Missing Jira base URL.");
  }
  if (!email) {
    throw createHttpError(400, "Missing Atlassian email.");
  }
  if (!token) {
    throw createHttpError(400, "Missing API token.");
  }

  return {
    baseUrl,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`
    }
  };
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

async function jiraRequest(client, path, options = {}) {
  const response = await fetch(`${client.baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...client.headers,
      ...(options.headers || {})
    },
    body: options.body
  });

  const text = await response.text();
  if (!response.ok) {
    throw createJiraError(response.status, text, path);
  }

  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function createJiraError(statusCode, bodyText, path) {
  let details = null;
  try {
    details = bodyText ? JSON.parse(bodyText) : null;
  } catch (_error) {
    details = bodyText || null;
  }

  const error = createHttpError(statusCode, `Jira request failed for ${path}.`, {
    jira: details
  });
  error.code = `JIRA_${statusCode}`;
  return error;
}

function createHttpError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function validateIdentity(client) {
  await jiraRequest(client, "rest/api/3/myself");
}

async function validateProject(client, projectKey) {
  await jiraRequest(client, `rest/api/3/project/${encodeURIComponent(projectKey)}`);
}

async function fetchAccessibleProjects(client) {
  const payload = await jiraRequest(client, "rest/api/3/project/search?maxResults=100");
  const values = Array.isArray(payload?.values) ? payload.values : [];
  return values.map((project) => ({
    key: project.key,
    name: project.name || project.key
  })).sort((left, right) => left.key.localeCompare(right.key));
}

async function fetchAllResolvedIssues(client, projectKey) {
  const fields = "summary,created,resolutiondate,status";
  const jql = `project = ${projectKey} AND resolutiondate IS NOT EMPTY ORDER BY resolutiondate ASC`;
  const batchSize = 100;
  let nextPageToken = "";
  let isLast = false;
  const collected = [];

  while (!isLast) {
    const params = new URLSearchParams({
      jql,
      maxResults: String(batchSize),
      fields
    });
    if (nextPageToken) {
      params.set("nextPageToken", nextPageToken);
    }

    const payload = await jiraRequest(client, `rest/api/3/search/jql?${params.toString()}`);
    const batch = Array.isArray(payload?.issues) ? payload.issues : [];
    collected.push(...batch);
    isLast = Boolean(payload?.isLast !== false && !payload?.nextPageToken);
    nextPageToken = payload?.nextPageToken || "";
    if (!batch.length && !nextPageToken) {
      isLast = true;
    }
  }

  return collected;
}

async function enrichIssuesWithChangelog(client, issues) {
  if (!issues.length) {
    return [];
  }

  const statusHistoryByIssueId = await fetchStatusHistories(client, issues.map((issue) => issue.id));
  return issues.map((issue) => toLeadTimeIssue(issue, statusHistoryByIssueId.get(String(issue.id)) || []));
}

async function fetchStatusHistories(client, issueIds) {
  const historyByIssueId = new Map();
  const chunkSize = 100;

  for (let index = 0; index < issueIds.length; index += chunkSize) {
    const chunk = issueIds.slice(index, index + chunkSize);
    let nextPageToken = "";
    let isLast = false;

    while (!isLast) {
      const payload = await fetchBulkChangelogPage(client, {
        issueIdsOrKeys: chunk,
        fieldIds: ["status"],
        maxResults: 1000,
        nextPageToken
      });

      const values = Array.isArray(payload?.values) ? payload.values : [];
      for (const entry of values) {
        const issueId = String(entry.issueId || entry.issueIdOrKey || entry.issueKey || "");
        if (!issueId) {
          continue;
        }
        const target = historyByIssueId.get(issueId) || [];
        if (Array.isArray(entry.histories)) {
          target.push(...entry.histories);
        } else if (entry.historyMetadata || entry.items || entry.created) {
          target.push(entry);
        }
        historyByIssueId.set(issueId, target);
      }

      nextPageToken = payload?.nextPageToken || "";
      isLast = Boolean(payload?.isLast !== false && !nextPageToken);
      if (!values.length && !nextPageToken) {
        isLast = true;
      }
    }
  }

  for (const [issueId, histories] of historyByIssueId.entries()) {
    histories.sort((left, right) => new Date(left.created || 0).getTime() - new Date(right.created || 0).getTime());
    historyByIssueId.set(issueId, histories);
  }

  return historyByIssueId;
}

async function fetchBulkChangelogPage(client, payload) {
  const requestBody = {
    issueIdsOrKeys: Array.isArray(payload.issueIdsOrKeys) ? payload.issueIdsOrKeys : [],
    fieldIds: Array.isArray(payload.fieldIds) ? payload.fieldIds : ["status"],
    maxResults: Number(payload.maxResults || 1000)
  };
  if (payload.nextPageToken) {
    requestBody.nextPageToken = payload.nextPageToken;
  }

  return jiraRequest(client, "rest/api/3/changelog/bulkfetch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });
}

function toLeadTimeIssue(issue, histories) {
  const created = issue?.fields?.created;
  const resolved = issue?.fields?.resolutiondate;
  if (!created || !resolved) {
    return null;
  }

  const createdDate = new Date(created);
  const resolvedDate = new Date(resolved);
  if (Number.isNaN(createdDate.getTime()) || Number.isNaN(resolvedDate.getTime())) {
    return null;
  }

  const doneTransitionAt = findLatestDoneStatusTransition(histories) || resolvedDate;
  const leadTimeDays = roundToOneDecimal(Math.max(0, (doneTransitionAt.getTime() - createdDate.getTime()) / 86400000));

  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary || "",
    status: issue.fields.status?.name || "Unknown",
    createdIso: toInputDate(createdDate),
    resolvedIso: toInputDate(resolvedDate),
    createdAt: createdDate.toISOString(),
    resolvedAt: resolvedDate.toISOString(),
    doneTransitionAt: doneTransitionAt.toISOString(),
    leadTime: leadTimeDays
  };
}

function findLatestDoneStatusTransition(histories) {
  let candidate = null;
  for (const history of histories) {
    const items = Array.isArray(history.items) ? history.items : [];
    const movedToDone = items.some((item) => {
      const field = String(item.fieldId || item.field || "").toLowerCase();
      const toString = String(item.toString || "").toLowerCase();
      return field === "status" && /done|closed|resolved/.test(toString);
    });
    if (movedToDone && history.created) {
      const date = new Date(history.created);
      if (!Number.isNaN(date.getTime())) {
        candidate = date;
      }
    }
  }
  return candidate;
}

function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roundToOneDecimal(value) {
  return Math.round(value * 10) / 10;
}