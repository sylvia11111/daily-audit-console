import json
import tempfile
import unittest
from pathlib import Path

import app


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        app.init_db()

    def tearDown(self):
        self.temp.cleanup()

    def test_audit_pass_creates_traceable_demo_sync(self):
        stamp = app.now()
        report_id = "report-test"
        with app.get_db() as db:
            employee = db.execute("SELECT * FROM employees LIMIT 1").fetchone()
            db.execute(
                """INSERT INTO reports (id, report_date, employee_id, employee_name, task_name, content, plan, help_text, audit_status, sync_status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (report_id, "2026-09-26", employee["id"], employee["name"], "日报审计改造", "我完成了三张 SQL 数据表设计、日报接口联调和本地重启验证，累计完成 6 个核心接口的联调。", "补充权限设计", "无", "PASSED", "pending_wecom", stamp, stamp),
            )
            findings, questions = app.build_audit({"task_name": "日报审计改造", "content": "我完成了三张 SQL 数据表设计、日报接口联调和本地重启验证，累计完成 6 个核心接口的联调。"})
            db.execute(
                """INSERT INTO audits (id, report_id, summary, findings_json, questions_json, answers_json, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("audit-test", report_id, "审计完成", json.dumps(findings, ensure_ascii=False), json.dumps(questions, ensure_ascii=False), "{}", "PASSED", stamp, stamp),
            )
            db.execute(
                "INSERT INTO sync_jobs (report_id, status, marker, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (report_id, "pending", "<!-- daily-report:report-test -->", stamp, stamp),
            )

        synced = app.process_sync(report_id)

        self.assertEqual(synced["audit_status"], "PASSED")
        self.assertEqual(synced["sync_status"], "demo_synced")
        self.assertEqual(synced["sync_job"]["attempts"], 1)
        self.assertIn("本地演示", synced["sync_job"]["message"])
