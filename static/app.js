const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
};

let reports = [];
let selectedReport = null;
const dialog = document.querySelector('#audit-dialog');
const toast = document.querySelector('#toast');
const titles = { dashboard: '今日概览', submit: '提交日报', reports: '日报记录' };
const statusLabel = { DRAFT: '草稿', QUESTION_PENDING: '等待回答', REANSWER_REQUIRED: '需要补答', PASSED: '审计通过', not_ready: '未就绪', pending_wecom: '待同步', syncing: '同步中', synced: '已归档', demo_synced: '本地演示完成', sync_failed: '同步失败' };

function notify(message) { toast.textContent = message; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 3200); }
function dateToday() { return new Date().toISOString().slice(0, 10); }
function chip(value) { return `<span class="chip ${String(value).toLowerCase()}">${statusLabel[value] || value}</span>`; }
function view(name) {
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${name}-view`));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  document.querySelector('#page-title').textContent = titles[name];
}
function row(report) {
  return `<article class="report-row"><div class="report-main"><strong>${escapeHtml(report.task_name)}</strong><span>${escapeHtml(report.employee_name)} · ${report.report_date}</span></div><div>${chip(report.audit_status)}</div><div>${chip(report.sync_status)}</div><button data-report-id="${report.id}">查看</button></article>`;
}
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value || ''; return node.innerHTML; }

async function refresh() {
  const [summary, nextReports, health] = await Promise.all([api('/api/summary'), api('/api/reports'), api('/api/health')]);
  reports = nextReports;
  document.querySelector('#stat-today').textContent = summary.today;
  document.querySelector('#stat-passed').textContent = summary.passed;
  document.querySelector('#stat-waiting').textContent = summary.waiting;
  document.querySelector('#stat-failed').textContent = summary.sync_failed;
  document.querySelector('#wecom-status').textContent = health.wecom_configured ? '企微 MCP 已配置' : '企微：本地演示模式';
  const markup = reports.length ? reports.map(row).join('') : '<div class="empty-state">尚无日报，先提交一份吧。</div>';
  document.querySelector('#recent-reports').innerHTML = markup;
  document.querySelector('#all-reports').innerHTML = markup;
}

async function openReport(id) {
  selectedReport = await api(`/api/reports/${id}`);
  const report = selectedReport;
  document.querySelector('#audit-title').textContent = `${report.employee_name} · ${report.report_date}`;
  if (!report.audit) {
    document.querySelector('#audit-body').innerHTML = `<div class="audit-content"><p class="audit-summary">日报已保存。现在开始生成审计问题。</p><button class="command-button" id="start-audit">开始审计</button></div>`;
    dialog.showModal();
    document.querySelector('#start-audit').onclick = startAudit;
    return;
  }
  const audit = report.audit;
  const findings = audit.findings.map((item) => `<article class="finding ${item.severity}"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></article>`).join('');
  const answers = audit.questions.map((item) => `<div class="answer"><label for="${item.id}">${item.level} · ${escapeHtml(item.prompt)}</label><textarea id="${item.id}" ${audit.status === 'PASSED' ? 'disabled' : ''} placeholder="不少于 20 个字符">${escapeHtml(audit.answers[item.id] || '')}</textarea></div>`).join('');
  const action = audit.status === 'PASSED'
    ? `<div class="audit-actions"><span>审计已通过，${statusLabel[report.sync_status] || report.sync_status}。</span><button class="command-button" id="retry-sync">重新同步企微</button></div>`
    : `<div class="audit-actions"><span>${audit.status === 'REANSWER_REQUIRED' ? '请补充所有答案后重新提交。' : '5 个问题均需填写至少 20 个字符。'}</span><button class="command-button" id="submit-answers">提交回答</button></div>`;
  document.querySelector('#audit-body').innerHTML = `<div class="audit-content"><p class="audit-summary">${escapeHtml(audit.summary)}</p><div class="audit-grid">${findings}</div><div class="answers">${answers}</div>${action}</div>`;
  dialog.showModal();
  const submit = document.querySelector('#submit-answers');
  const retry = document.querySelector('#retry-sync');
  if (submit) submit.onclick = submitAnswers;
  if (retry) retry.onclick = retrySync;
}

async function startAudit() {
  try { await api(`/api/reports/${selectedReport.id}/audit`, { method: 'POST', body: '{}' }); await openReport(selectedReport.id); await refresh(); } catch (error) { notify(error.message); }
}
async function submitAnswers() {
  const answers = Object.fromEntries(selectedReport.audit.questions.map((question) => [question.id, document.querySelector(`#${question.id}`).value]));
  try { const updated = await api(`/api/reports/${selectedReport.id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) }); selectedReport = updated; await refresh(); await openReport(updated.id); notify(updated.audit_status === 'PASSED' ? '审计通过，已提交归档。' : '答案需要继续补充。'); } catch (error) { notify(error.message); }
}
async function retrySync() {
  try { const updated = await api(`/api/reports/${selectedReport.id}/sync`, { method: 'POST', body: '{}' }); selectedReport = updated; await refresh(); await openReport(updated.id); notify(['synced', 'demo_synced'].includes(updated.sync_status) ? '同步已完成。' : '同步未完成，请查看状态。'); } catch (error) { notify(error.message); }
}

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => view(item.dataset.view)));
document.querySelectorAll('[data-view-target]').forEach((item) => item.addEventListener('click', () => view(item.dataset.viewTarget)));
document.querySelector('#close-dialog').onclick = () => dialog.close();
document.addEventListener('click', (event) => { const button = event.target.closest('[data-report-id]'); if (button) openReport(button.dataset.reportId); });
document.querySelector('#report-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try { const report = await api('/api/reports', { method: 'POST', body: JSON.stringify(values) }); event.currentTarget.reset(); document.querySelector('#report-date').value = dateToday(); await refresh(); await openReport(report.id); notify('日报已保存，开始审计。'); } catch (error) { notify(error.message); }
});

async function boot() {
  document.querySelector('#report-date').value = dateToday();
  const employees = await api('/api/employees');
  document.querySelector('#employee').innerHTML = employees.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('');
  await refresh();
}
boot().catch((error) => notify(`启动失败：${error.message}`));
