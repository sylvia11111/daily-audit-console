# 发布到 GitHub

## 发布前检查

1. 确认 `.env`、SQLite 数据库和本地日志没有被加入 Git。仓库的 `.gitignore` 已忽略这些文件。
2. 把真实企微 MCP 地址、文档 ID、机器人密钥等配置仅保存在本机 `.env` 或 GitHub Secrets，不要提交到仓库。
3. 本地运行测试并确认页面可启动。

```bash
PYTHONPYCACHEPREFIX=/private/tmp/daily_audit_pycache python3 -m unittest discover -s tests -v
python3 app.py
```

## 使用 GitHub 网页创建仓库

1. 登录 GitHub，点击右上角 `+`，选择 `New repository`。
2. 仓库名称建议使用 `daily-audit-console`，选择 `Private`，不要勾选自动生成 README、`.gitignore` 或 License。
3. 创建后复制仓库 HTTPS 地址，例如 `https://github.com/<你的账号>/daily-audit-console.git`。

## 推送工程

在本工程目录执行以下命令，将 `<仓库地址>` 替换为刚复制的地址：

```bash
git add .
git commit -m "feat: initialize daily audit console"
git branch -M main
git remote add origin <仓库地址>
git push -u origin main
```

如果 GitHub 要求登录，推荐使用 GitHub Desktop，或使用 GitHub CLI 执行 `gh auth login` 后再推送。不要把 GitHub Token 写入命令、文档或代码文件。

## 后续更新

每次开发完成后：

```bash
git add .
git commit -m "feat: 简述本次改动"
git push
```

GitHub 用于存放源代码和文档，不应上传 `data/daily_audit.sqlite3`、`.env`、真实日报、附件或其他生产数据。
