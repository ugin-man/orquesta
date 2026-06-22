const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dashboardRoot = path.join(__dirname, "assets", "dashboard");
const stateRoot = path.join(root, ".orquesta", "state");
const visionRoot = path.join(root, ".orquesta", "vision");
const failuresRoot = path.join(root, ".orquesta", "failures");
const userTasksRoot = path.join(root, ".orquesta", "user_tasks");
const setupRoot = path.join(root, ".orquesta", "setup");
const port = Number(process.env.PORT || process.argv[2] || 4177);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function readJsonFrom(basePath, fileName, fallback = null) {
  const filePath = path.join(basePath, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJson(fileName) {
  return readJsonFrom(stateRoot, fileName, {});
}

function writeJsonTo(basePath, fileName, data) {
  fs.mkdirSync(basePath, { recursive: true });
  fs.writeFileSync(path.join(basePath, fileName), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readJsonl(fileName) {
  const filePath = path.join(stateRoot, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function nextBatchId(answerBatches) {
  const max = answerBatches
    .map((batch) => String(batch.batch_id || "").match(/^A(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return `A${String(max + 1).padStart(3, "0")}`;
}

function appendEvent(event) {
  const filePath = path.join(stateRoot, "events.jsonl");
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function saveVisionAnswers(payload) {
  const submitted = Array.isArray(payload.answers) ? payload.answers : [];
  const answers = submitted
    .map((answer) => ({
      question_id: String(answer.question_id || "").trim(),
      answer: String(answer.answer || "").trim()
    }))
    .filter((answer) => answer.question_id && answer.answer);

  if (!answers.length) {
    const error = new Error("No non-empty answers submitted");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const questionsState = readJsonFrom(visionRoot, "questions.json", { version: 1, questions: [], curation_policy: {} });
  const answersState = readJsonFrom(visionRoot, "answers.json", { version: 1, answer_batches: [] });
  const existingBatches = answersState.answer_batches || [];
  const batchId = nextBatchId(existingBatches);
  const questionIds = new Set(answers.map((answer) => answer.question_id));
  const readyQuestionIds = new Set((questionsState.questions || [])
    .filter((question) => question.status === "ready")
    .map((question) => question.question_id));
  const invalidQuestionIds = [...questionIds].filter((questionId) => !readyQuestionIds.has(questionId));
  if (invalidQuestionIds.length) {
    const error = new Error(`Questions are not ready or do not exist: ${invalidQuestionIds.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  answersState.version = answersState.version || 1;
  answersState.answer_batches = [
    ...existingBatches,
    {
      batch_id: batchId,
      question_ids: [...questionIds],
      source: "dashboard_text_answer",
      status: "needs_curation",
      answers: answers.map((answer) => ({
        question_id: answer.question_id,
        answer: answer.answer,
        answered_at: now
      })),
      curator_report: null,
      adopted_updates: []
    }
  ];

  questionsState.questions = (questionsState.questions || []).map((question) => {
    if (!questionIds.has(question.question_id)) return question;
    return {
      ...question,
      status: "answered",
      answer_id: batchId,
      answered_at: now
    };
  });

  writeJsonTo(visionRoot, "answers.json", answersState);
  writeJsonTo(visionRoot, "questions.json", questionsState);
  appendEvent({
    ts: now,
    type: "vision_answers_submitted",
    batch_id: batchId,
    summary: `User submitted ${answers.length} vision answers through the dashboard.`
  });

  return { batch_id: batchId, saved: answers.length };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(dashboardRoot, `.${requested}`);

  if (!filePath.startsWith(dashboardRoot)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/state")) {
    try {
      sendJson(res, 200, {
        agents: readJson("agents.json").agents || [],
        sessions: readJson("sessions.json").sessions || [],
        tasks: readJson("tasks.json").tasks || [],
        directives: readJson("directives.json").directives || [],
        events: readJsonl("events.jsonl"),
        vision: {
          questions: readJsonFrom(visionRoot, "questions.json", { questions: [], curation_policy: {} }),
          answers: readJsonFrom(visionRoot, "answers.json", { answer_batches: [] })
        },
        failures: {
          incidents: readJsonFrom(failuresRoot, "incidents.json", { incidents: [], wake_policy: {} }),
          userActions: readJsonFrom(failuresRoot, "user_actions.json", { actions: [] })
        },
        userTasks: readJsonFrom(userTasksRoot, "queue.json", { tasks: [], policy: {} }),
        setup: readJsonFrom(setupRoot, "options.json", { available_packs: [], enabled_packs: [] }),
        loadedFiles: ["agents.json", "sessions.json", "tasks.json", "directives.json", "events.jsonl", "questions.json", "answers.json", "incidents.json", "user_actions.json", "queue.json", "options.json"],
        loadedAt: new Date().toISOString(),
        source: "server"
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/answers") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, saveVisionAnswers(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Orquesta dashboard: http://127.0.0.1:${port}/`);
});
