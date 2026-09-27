#!/usr/bin/env python3
"""Local daily-report audit service. Uses only the Python standard library."""

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.environ.get("DAILY_AUDIT_DB", str(DATA_DIR / "daily_audit.sqlite3")))
HOST = os.environ.get("DAILY_AUDIT_HOST", "127.0.0.1")
PORT = int(os.environ.get("DAILY_AUDIT_PORT", "4174"))


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def init_db():
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS employees (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              role TEXT NOT NULL,
              role_key TEXT NOT NULL,
              department TEXT NOT NULL,
              manager_id TEXT
            );
            CREATE TABLE IF NOT EXISTS reports (
              id TEXT PRIMARY KEY,
              report_date TEXT NOT NULL,
              employee_id TEXT NOT NULL REFERENCES employees(id),
              employee_name TEXT NOT NULL,
              task_name TEXT NOT NULL,
              content TEXT NOT NULL,
              plan TEXT NOT NULL DEFAULT '',
              help_text TEXT NOT NULL DEFAULT '',
              version INTEGER NOT NULL DEFAULT 1,
              audit_status TEXT NOT NULL DEFAULT 'DRAFT',
              manager_review_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
              reviewer_id TEXT,
              reviewer_name TEXT,
              review_comment TEXT NOT NULL DEFAULT '',
              reviewed_at TEXT,
              sync_status TEXT NOT NULL DEFAULT 'not_ready',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS reports_by_date ON reports(report_date DESC);
            CREATE TABLE IF NOT EXISTS audits (
              id TEXT PRIMARY KEY,
              report_id TEXT NOT NULL REFERENCES reports(id),
              summary TEXT NOT NULL,
              findings_json TEXT NOT NULL,
              questions_json TEXT NOT NULL,
              answers_json TEXT NOT NULL DEFAULT '{}',
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS audits_by_report ON audits(report_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS sync_jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              report_id TEXT NOT NULL UNIQUE REFERENCES reports(id),
              status TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              marker TEXT NOT NULL,
              message TEXT NOT NULL DEFAULT '',
              synced_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        # ALTER-based migrations keep databases created by earlier local builds usable.
        employee_columns = {row[1] for row in db.execute("PRAGMA table_info(employees)")}
        report_columns = {row[1] for row in db.execute("PRAGMA table_info(reports)")}
        if "manager_id" not in employee_columns:
            db.execute("ALTER TABLE employees ADD COLUMN manager_id TEXT")
        migrations = {
            "manager_review_status": "TEXT NOT NULL DEFAULT 'NOT_REQUIRED'",
            "reviewer_id": "TEXT",
            "reviewer_name": "TEXT",
            "review_comment": "TEXT NOT NULL DEFAULT ''",
            "reviewed_at": "TEXT",
        }
        for column, definition in migrations.items():
            if column not in report_columns:
                db.execute(f"ALTER TABLE reports ADD COLUMN {column} {definition}")
        count = db.execute("SELECT COUNT(*) FROM employees").fetchone()[0]
        if not count:
            db.executemany(
                "INSERT INTO employees (id, name, role, role_key, department, manager_id) VALUES (?, ?, ?, ?, ?, ?)",
                [
                    ("emp-chen", "陈远", "算法工程师", "member", "算法平台", "emp-li"),
                    ("emp-li", "李文", "产品负责人", "manager", "产品与运营", "emp-zhou"),
                    ("emp-zhou", "周青", "系统管理员", "admin", "工程效能", None),
                ],
            )


def row_dict(row):
    return dict(row) if row else None


def load_employee(employee_id):
    with get_db() as db:
        return row_dict(db.execute("SELECT * FROM employees WHERE id = ?", (employee_id,)).fetchone())


def visible_employee_ids(actor):
    """Return the people whose reports this local RBAC actor may read."""
    if actor["role_key"] == "admin":
        return None
    ids = {actor["id"]}
    if actor["role_key"] == "manager":
        with get_db() as db:
            ids.update(row[0] for row in db.execute("SELECT id FROM employees WHERE manager_id = ?", (actor["id"],)))
    return ids


def can_view_report(actor, report):
    allowed = visible_employee_ids(actor)
    return allowed is None or report["employee_id"] in allowed


def can_review_report(actor, report):
    return (
        report["audit_status"] == "PASSED"
        and report["manager_review_status"] == "PENDING_REVIEW"
        and (actor["role_key"] == "admin" or report["employee_id"] != actor["id"] and load_employee(report["employee_id"])["manager_id"] == actor["id"])
    )


def decorate_report(report, actor):
    if not report:
        return None
    report["permissions"] = {
        "is_owner": actor["id"] == report["employee_id"],
        "can_review": can_review_report(actor, report),
    }
    return report


def load_report(report_id):
    with get_db() as db:
        report = db.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
        if not report:
            return None
        value = row_dict(report)
        audit = db.execute("SELECT * FROM audits WHERE report_id = ? ORDER BY created_at DESC LIMIT 1", (report_id,)).fetchone()
        job = db.execute("SELECT * FROM sync_jobs WHERE report_id = ?", (report_id,)).fetchone()
    if audit:
        value["audit"] = row_dict(audit)
        value["audit"]["findings"] = json.loads(value["audit"].pop("findings_json"))
        value["audit"]["questions"] = json.loads(value["audit"].pop("questions_json"))
        value["audit"]["answers"] = json.loads(value["audit"].pop("answers_json"))
    if job:
        value["sync_job"] = row_dict(job)
    return value


def build_audit(report):
    content = report["content"].strip()
    findings = []
    if len(content) < 80:
        findings.append({"severity": "attention", "title": "进展描述偏短", "detail": "补充完成动作、产出位置和验证结果，便于主管快速判断进展。"})
    if not any(char.isdigit() for char in content):
        findings.append({"severity": "attention", "title": "缺少可验收结果", "detail": "建议补充数量、完成度、测试结论或可访问的产出位置。"})
    if "我" not in content and "本人" not in content:
        findings.append({"severity": "notice", "title": "工作主体不够明确", "detail": "建议明确本人负责的动作，避免只描述团队结论。"})
    if not findings:
        findings.append({"severity": "pass", "title": "日报具备基础可读性", "detail": "工作主体、进展与结果表达较完整，继续通过问答确认理解深度。"})
    questions = [
        {"id": "q1", "level": "L1", "prompt": f"请解释日报中与“{report['task_name']}”最相关的一个专业名词。"},
        {"id": "q2", "level": "L2", "prompt": "你采用了什么方法或步骤？为什么选择它？"},
        {"id": "q3", "level": "L3", "prompt": "这项工作与当前任务目标之间的关系是什么？"},
        {"id": "q4", "level": "L4", "prompt": "请列出今天由你亲自完成的关键动作和对应产出。"},
        {"id": "q5", "level": "L5", "prompt": "下一步最可能遇到的风险是什么？你打算如何验证或处理？"},
    ]
    return findings, questions


def create_audit(report_id):
    """Create the first audit as part of report submission; safe to call repeatedly."""
    report = load_report(report_id)
    if not report:
        raise ValueError("日报不存在")
    if report.get("audit"):
        return report
    findings, questions = build_audit(report)
    audit_id, stamp = f"audit-{uuid.uuid4().hex[:12]}", now()
    with get_db() as db:
        db.execute(
            "INSERT INTO audits (id, report_id, summary, findings_json, questions_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'QUESTION_PENDING', ?, ?)",
            (audit_id, report_id, "已自动完成首轮审计，请回答 5 个验证问题。", json.dumps(findings, ensure_ascii=False), json.dumps(questions, ensure_ascii=False), stamp, stamp),
        )
        db.execute("UPDATE reports SET audit_status = 'QUESTION_PENDING', updated_at = ? WHERE id = ?", (stamp, report_id))
    return load_report(report_id)


def mcp_content(response):
    result = response.get("result", response)
    for item in result.get("content", []) if isinstance(result, dict) else []:
        if item.get("type") == "text" and item.get("text"):
            return item["text"]
    return ""


def mcp_call(endpoint, tool, arguments):
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": f"daily-{uuid.uuid4().hex[:8]}",
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }).encode("utf-8")
    request = Request(endpoint, data=payload, headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def sync_to_wecom(report):
    endpoint = os.environ.get("WECOM_MCP_DOC_URL", "").strip()
    document_id = os.environ.get("WECOM_DOCUMENT_ID", "").strip()
    marker = f"<!-- daily-report:{report['id']} -->"
    if not endpoint or not document_id:
        return "demo_synced", "本地演示同步完成。配置 WECOM_MCP_DOC_URL 和 WECOM_DOCUMENT_ID 后会写入真实企微文档。"
    try:
        existing = mcp_content(mcp_call(endpoint, "get_doc_content", {"type": 2, "docid": document_id}))
        if marker in existing:
            return "synced", "企微文档已存在该日报，幂等跳过。"
        block = "\n".join([
            marker,
            f"## {report['report_date']} · {report['employee_name']}",
            f"- **任务**：{report['task_name']}",
            f"- **今日完成**：{report['content']}",
            f"- **明日计划**：{report['plan'] or '未填写'}",
            f"- **需要协助**：{report['help_text'] or '无'}",
        ])
        content = (existing.strip() or "# 部门日报汇总") + "\n\n" + block
        mcp_call(endpoint, "edit_doc_content", {"docid": document_id, "content": content, "content_type": 1})
        return "synced", "已写入企微文档。"
    except (URLError, TimeoutError, ValueError, KeyError) as error:
        return "sync_failed", f"企微同步失败：{error}"


def process_sync(report_id):
    report = load_report(report_id)
    if not report:
        return None
    timestamp = now()
    with get_db() as db:
        db.execute("UPDATE sync_jobs SET status = 'syncing', attempts = attempts + 1, updated_at = ? WHERE report_id = ?", (timestamp, report_id))
        db.execute("UPDATE reports SET sync_status = 'syncing', updated_at = ? WHERE id = ?", (timestamp, report_id))
    status, message = sync_to_wecom(report)
    with get_db() as db:
        db.execute("UPDATE sync_jobs SET status = ?, message = ?, synced_at = CASE WHEN ? IN ('synced', 'demo_synced') THEN ? ELSE synced_at END, updated_at = ? WHERE report_id = ?", (status, message, status, now(), now(), report_id))
        db.execute("UPDATE reports SET sync_status = ?, updated_at = ? WHERE id = ?", (status, now(), report_id))
    return load_report(report_id)


def record_manager_review(report_id, actor, decision, comment):
    """Persist a supervisor decision and start archival only after approval."""
    report = load_report(report_id)
    if not report:
        raise ValueError("日报不存在")
    if not can_review_report(actor, report):
        raise PermissionError("当前身份无权审核或日报尚未进入主管审核")
    decision = str(decision).upper()
    comment = str(comment).strip()
    if decision not in ("APPROVED", "REWORK_REQUIRED"):
        raise ValueError("审核结论必须是 APPROVED 或 REWORK_REQUIRED")
    if decision == "REWORK_REQUIRED" and len(comment) < 4:
        raise ValueError("要求补充时请填写具体审核意见")
    stamp = now()
    with get_db() as db:
        db.execute("UPDATE reports SET manager_review_status = ?, reviewer_id = ?, reviewer_name = ?, review_comment = ?, reviewed_at = ?, sync_status = ?, updated_at = ? WHERE id = ?", (decision, actor["id"], actor["name"], comment, stamp, "pending_wecom" if decision == "APPROVED" else "not_ready", stamp, report_id))
        if decision == "APPROVED":
            marker = f"<!-- daily-report:{report_id} -->"
            db.execute("INSERT OR IGNORE INTO sync_jobs (report_id, status, marker, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)", (report_id, marker, stamp, stamp))
    return process_sync(report_id) if decision == "APPROVED" else load_report(report_id)


class AppHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1024 * 1024:
            raise ValueError("请求内容超过 1 MB")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def current_actor(self):
        """Resolve the active local demo identity from the request header."""
        actor_id = self.headers.get("X-Actor-ID", "emp-chen").strip()
        actor = load_employee(actor_id)
        if not actor:
            self.send_json({"error": "当前身份不存在，请重新选择账号"}, HTTPStatus.UNAUTHORIZED)
        return actor

    def report_ids_for_actor(self, actor):
        employee_ids = visible_employee_ids(actor)
        with get_db() as db:
            if employee_ids is None:
                return [row[0] for row in db.execute("SELECT id FROM reports ORDER BY updated_at DESC LIMIT 100")]
            placeholders = ",".join("?" for _ in employee_ids)
            return [row[0] for row in db.execute(f"SELECT id FROM reports WHERE employee_id IN ({placeholders}) ORDER BY updated_at DESC LIMIT 100", tuple(employee_ids))]

    def serve_static(self, filename):
        path = STATIC / filename
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_types = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8"}
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_types.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self.serve_static("index.html")
        if path.startswith("/static/"):
            return self.serve_static(path.removeprefix("/static/"))
        if path == "/api/health":
            return self.send_json({"ok": True, "database": str(DB_PATH.name), "wecom_configured": bool(os.environ.get("WECOM_MCP_DOC_URL") and os.environ.get("WECOM_DOCUMENT_ID"))})
        if path == "/api/employees":
            with get_db() as db:
                employees = [row_dict(row) for row in db.execute("SELECT * FROM employees ORDER BY role_key, name")]
            return self.send_json(employees)
        if path == "/api/reports":
            actor = self.current_actor()
            if not actor:
                return
            return self.send_json([decorate_report(load_report(report_id), actor) for report_id in self.report_ids_for_actor(actor)])
        if path == "/api/summary":
            actor = self.current_actor()
            if not actor:
                return
            employee_ids = visible_employee_ids(actor)
            clause, values = "", ()
            if employee_ids is not None:
                clause = f" WHERE employee_id IN ({','.join('?' for _ in employee_ids)})"
                values = tuple(employee_ids)
            with get_db() as db:
                today = datetime.now().date().isoformat()
                summary = {
                    "today": db.execute(f"SELECT COUNT(*) FROM reports{clause}{' AND' if clause else ' WHERE'} report_date = ?", values + (today,)).fetchone()[0],
                    "passed": db.execute(f"SELECT COUNT(*) FROM reports{clause}{' AND' if clause else ' WHERE'} audit_status = 'PASSED'", values).fetchone()[0],
                    "waiting": db.execute(f"SELECT COUNT(*) FROM reports{clause}{' AND' if clause else ' WHERE'} audit_status IN ('DRAFT', 'QUESTION_PENDING', 'REANSWER_REQUIRED')", values).fetchone()[0],
                    "manager_pending": db.execute(f"SELECT COUNT(*) FROM reports{clause}{' AND' if clause else ' WHERE'} manager_review_status = 'PENDING_REVIEW'", values).fetchone()[0],
                    "sync_failed": db.execute(f"SELECT COUNT(*) FROM reports{clause}{' AND' if clause else ' WHERE'} sync_status = 'sync_failed'", values).fetchone()[0],
                }
            return self.send_json({**summary, "actor": actor})
        if path == "/api/team":
            actor = self.current_actor()
            if not actor:
                return
            if actor["role_key"] == "member":
                return self.send_json({"error": "当前身份没有团队管理权限"}, HTTPStatus.FORBIDDEN)
            with get_db() as db:
                if actor["role_key"] == "admin":
                    members = [row_dict(row) for row in db.execute("SELECT * FROM employees WHERE id != ? ORDER BY department, name", (actor["id"],))]
                else:
                    members = [row_dict(row) for row in db.execute("SELECT * FROM employees WHERE manager_id = ? ORDER BY name", (actor["id"],))]
            reports = [decorate_report(load_report(report_id), actor) for report_id in self.report_ids_for_actor(actor)]
            return self.send_json({"members": members, "reports": reports, "actor": actor})
        if path.startswith("/api/reports/"):
            actor = self.current_actor()
            if not actor:
                return
            report = load_report(path.rsplit("/", 1)[1])
            if report and not can_view_report(actor, report):
                return self.send_json({"error": "无权查看这份日报"}, HTTPStatus.FORBIDDEN)
            return self.send_json(decorate_report(report, actor) or {"error": "日报不存在"}, HTTPStatus.OK if report else HTTPStatus.NOT_FOUND)
        return self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            payload = self.read_json()
            actor = self.current_actor()
            if not actor:
                return
            if path == "/api/reports":
                required = ["employee_id", "task_name", "content"]
                if any(not str(payload.get(field, "")).strip() for field in required):
                    return self.send_json({"error": "员工、关联任务和今日完成不能为空"}, HTTPStatus.BAD_REQUEST)
                if payload["employee_id"] != actor["id"] and actor["role_key"] != "admin":
                    return self.send_json({"error": "只能以当前身份提交日报"}, HTTPStatus.FORBIDDEN)
                with get_db() as db:
                    employee = db.execute("SELECT * FROM employees WHERE id = ?", (payload["employee_id"],)).fetchone()
                    if not employee:
                        return self.send_json({"error": "员工不存在"}, HTTPStatus.BAD_REQUEST)
                    stamp = now()
                    report_id = f"report-{uuid.uuid4().hex[:12]}"
                    db.execute("""INSERT INTO reports (id, report_date, employee_id, employee_name, task_name, content, plan, help_text, audit_status, sync_status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'not_ready', ?, ?)""", (report_id, payload.get("report_date") or datetime.now().date().isoformat(), employee["id"], employee["name"], payload["task_name"].strip(), payload["content"].strip(), payload.get("plan", "").strip(), payload.get("help_text", "").strip(), stamp, stamp))
                return self.send_json(decorate_report(create_audit(report_id), actor), HTTPStatus.CREATED)
            if path.endswith("/audit") and path.startswith("/api/reports/"):
                report_id = path.split("/")[3]
                report = load_report(report_id)
                if not report:
                    return self.send_json({"error": "日报不存在"}, HTTPStatus.NOT_FOUND)
                if report["employee_id"] != actor["id"] and actor["role_key"] != "admin":
                    return self.send_json({"error": "只有提交人可以发起审计"}, HTTPStatus.FORBIDDEN)
                return self.send_json(decorate_report(create_audit(report_id), actor))
            if path.endswith("/answers") and path.startswith("/api/reports/"):
                report_id = path.split("/")[3]
                report = load_report(report_id)
                if not report or not report.get("audit"):
                    return self.send_json({"error": "请先执行审计"}, HTTPStatus.BAD_REQUEST)
                if report["employee_id"] != actor["id"] and actor["role_key"] != "admin":
                    return self.send_json({"error": "只有提交人可以回答审计问题"}, HTTPStatus.FORBIDDEN)
                if report["audit_status"] == "PASSED":
                    return self.send_json({"error": "这份日报已完成审计，不能重复回答"}, HTTPStatus.CONFLICT)
                answers = payload.get("answers", {})
                questions = report["audit"]["questions"]
                missing = [question["id"] for question in questions if len(str(answers.get(question["id"], "")).strip()) < 20]
                audit_status = "REANSWER_REQUIRED" if missing else "PASSED"
                manager_id = load_employee(report["employee_id"])["manager_id"]
                review_status = "PENDING_REVIEW" if audit_status == "PASSED" and manager_id else "AUTO_APPROVED" if audit_status == "PASSED" else "NOT_REQUIRED"
                sync_status = "pending_manager_review" if review_status == "PENDING_REVIEW" else "pending_wecom" if review_status == "AUTO_APPROVED" else "not_ready"
                stamp = now()
                with get_db() as db:
                    db.execute("UPDATE audits SET answers_json = ?, status = ?, updated_at = ? WHERE id = ?", (json.dumps(answers, ensure_ascii=False), audit_status, stamp, report["audit"]["id"]))
                    db.execute("UPDATE reports SET audit_status = ?, manager_review_status = ?, sync_status = ?, updated_at = ? WHERE id = ?", (audit_status, review_status, sync_status, stamp, report_id))
                    if review_status == "AUTO_APPROVED":
                        marker = f"<!-- daily-report:{report_id} -->"
                        db.execute("INSERT OR IGNORE INTO sync_jobs (report_id, status, marker, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)", (report_id, marker, stamp, stamp))
                if review_status == "AUTO_APPROVED":
                    return self.send_json(decorate_report(process_sync(report_id), actor))
                return self.send_json(decorate_report(load_report(report_id), actor))
            if path.endswith("/review") and path.startswith("/api/reports/"):
                report_id = path.split("/")[3]
                return self.send_json(decorate_report(record_manager_review(report_id, actor, payload.get("decision", ""), payload.get("comment", "")), actor))
            if path.endswith("/sync") and path.startswith("/api/reports/"):
                report_id = path.split("/")[3]
                report = load_report(report_id)
                if not report or report["audit_status"] != "PASSED" or report["manager_review_status"] not in ("APPROVED", "AUTO_APPROVED"):
                    return self.send_json({"error": "只有主管审核通过的日报可以同步"}, HTTPStatus.BAD_REQUEST)
                if not can_view_report(actor, report):
                    return self.send_json({"error": "无权同步这份日报"}, HTTPStatus.FORBIDDEN)
                return self.send_json(decorate_report(process_sync(report_id), actor))
            return self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
        except PermissionError as error:
            return self.send_json({"error": str(error)}, HTTPStatus.FORBIDDEN)
        except (ValueError, json.JSONDecodeError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except sqlite3.Error as error:
            return self.send_json({"error": f"数据库错误：{error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Daily Audit running at http://{HOST}:{PORT}")
    print(f"SQLite database: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
