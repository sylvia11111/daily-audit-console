const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-Actor-ID': currentActorId, ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
};

let employees = [];
let currentActorId = localStorage.getItem('daily-audit-actor') || 'emp-chen';
let reports = [];
let teamData = null;
let selectedReport = null;
const dialog = document.querySelector('#audit-dialog');
const toast = document.querySelector('#toast');
const titles = { dashboard: '今日概览', submit: '提交日报', reports: '日报记录', team: '团队审核' };
const statusLabel = {
  DRAFT: '草稿', QUESTION_PENDING: '等待回答', REANSWER_REQUIRED: '需要补答', PASSED: '审计通过',
  NOT_REQUIRED: '未进入主管审核', PENDING_REVIEW: '等待主管审核', APPROVED: '主管已通过', AUTO_APPROVED: '自动通过', REWORK_REQUIRED: '主管要求补充',
  not_ready: '未就绪', pending_manager_review: '等待主管审核', pending_wecom: '待同步', syncing: '同步中', synced: '已归档', demo_synced: '本地演示完成', sync_failed: '同步失败',
};

function notify(message) { toast.textContent = message; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 3200); }
function dateToday() { return new Date().toISOString().slice(0, 10); }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value || ''; return node.innerHTML; }
function chip(value) { return `<span class="chip ${String(value).toLowerCase()}">${statusLabel[value] || value}</span>`; }
function actor() { return employees.find((item) => item.id === currentActorId); }
function isManager() { return actor() && actor().role_key !== 'member'; }
function view(name) {
  if (name === 'team' && !isManager()) return;
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${name}-view`));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  document.querySelector('#page-title').textContent = titles[name];
}
function row(report) {
  return `<article class="report-row"><div class="report-main"><strong>${escapeHtml(report.task_name)}</strong><span>${escapeHtml(report.employee_name)} · ${report.report_date} · V${report.version}</span></div><div>${chip(report.audit_status)}</div><div>${chip(report.manager_review_status)}</div><div>${chip(report.sync_status)}</div><button data-report-id="${report.id}">查看</button></article>`;
}
function renderReports(target, items, emptyText) {
  document.querySelector(target).innerHTML = items.length ? items.map(row).join('') : `<div class="empty-state">${emptyText}</div>`;
}

function updateIdentityUI() {
  const active = actor();
  const select = document.querySelector('#actor-select');
  select.value = currentActorId;
  document.querySelector('#actor-context').textContent = active ? `${active.department} · ${active.role}` : '身份不可用';
  document.querySelector('#team-nav').hidden = !isManager();
  document.querySelector('#employee').innerHTML = (active && active.role_key === 'admin' ? employees : [active])
    .filter(Boolean).map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('');
}

function renderTeam() {
  if (!teamData) return;
  document.querySelector('#team-description').textContent = `${teamData.members.length} 名成员在当前可见范围内；仅“主管待审”的日报可做审核操作。`;
  document.querySelector('#team-members').innerHTML = teamData.members.map((member) => {
    const memberReports = teamData.reports.filter((report) => report.employee_id === member.id);
    const pending = memberReports.filter((report) => report.manager_review_status === 'PENDING_REVIEW').length;
    return `<article class="member-card"><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.role)} · ${escapeHtml(member.department)}</span><small>${memberReports.length} 份可见日报，${pending} 份待审</small></article>`;
  }).join('') || '<div class="empty-state">暂无直属成员。</div>';
  const relevant = teamData.reports.filter((report) => report.employee_id !== currentActorId);
  renderReports('#team-reports', relevant, '当前没有需要处理的团队日报。');
}

async function refresh() {
  const requests = [api('/api/summary'), api('/api/reports'), api('/api/health')];
  if (isManager()) requests.push(api('/api/team'));
  const [summary, nextReports, health, nextTeam] = await Promise.all(requests);
  reports = nextReports;
  teamData = nextTeam || null;
  document.querySelector('#stat-today').textContent = summary.today;
  document.querySelector('#stat-passed').textContent = summary.passed;
  document.querySelector('#stat-waiting').textContent = summary.waiting;
  document.querySelector('#stat-manager-pending').textContent = summary.manager_pending;
  document.querySelector('#stat-failed').textContent = summary.sync_failed;
  document.querySelector('#wecom-status').textContent = health.wecom_configured ? '企微 MCP 已配置' : '企微：本地演示模式';
  renderReports('#recent-reports', reports, '尚无日报，先提交一份吧。');
  renderReports('#all-reports', reports, '当前身份没有可见日报。');
  renderTeam();
}

function reviewPanel(report) {
  const status = report.manager_review_status;
  const comment = report.review_comment ? `<p class="review-comment"><strong>主管意见：</strong>${escapeHtml(report.review_comment)}</p>` : '';
  if (report.permissions.can_review) {
    return `<section class="review-panel"><h3>主管审核</h3><p>确认日报与审计回答达到团队交付标准后，才会进入企微归档。</p><label for="review-comment">审核意见（要求补充时必填）</label><textarea id="review-comment" rows="3" placeholder="可记录验收依据、补充要求或风险提醒"></textarea><div class="audit-actions"><button class="secondary-button" id="request-rework">要求补充</button><button class="command-button" id="approve-report">通过并归档</button></div></section>`;
  }
  const hint = status === 'PENDING_REVIEW' ? '已完成审计，正在等待主管审核。' : status === 'REWORK_REQUIRED' ? '主管要求补充后，请重新提交一份日报版本。' : status === 'APPROVED' || status === 'AUTO_APPROVED' ? '主管审核已通过，可以归档或重试同步。' : '完成全部审计问题后，将自动进入主管审核。';
  return `<section class="review-panel readonly"><h3>主管审核</h3><p>${hint}</p>${comment}</section>`;
}

async function openReport(id) {
  selectedReport = await api(`/api/reports/${id}`);
  const report = selectedReport;
  document.querySelector('#audit-title').textContent = `${report.employee_name} · ${report.report_date}`;
  if (!report.audit) {
    const canStart = report.permissions.is_owner;
    document.querySelector('#audit-body').innerHTML = `<div class="audit-content"><p class="audit-summary">日报已保存。${canStart ? '现在开始生成审计问题。' : '等待提交人发起审计。'}</p>${canStart ? '<button class="command-button" id="start-audit">开始审计</button>' : ''}</div>`;
    dialog.showModal();
    const start = document.querySelector('#start-audit'); if (start) start.onclick = startAudit;
    return;
  }
  const audit = report.audit;
  const findings = audit.findings.map((item) => `<article class="finding ${item.severity}"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></article>`).join('');
  const canAnswer = report.permissions.is_owner && audit.status !== 'PASSED';
  const answers = audit.questions.map((item) => `<div class="answer"><label for="${item.id}">${item.level} · ${escapeHtml(item.prompt)}</label><textarea id="${item.id}" ${canAnswer ? '' : 'disabled'} placeholder="不少于 20 个字符">${escapeHtml(audit.answers[item.id] || '')}</textarea></div>`).join('');
  const auditAction = canAnswer ? `<div class="audit-actions"><span>${audit.status === 'REANSWER_REQUIRED' ? '请补充所有答案后重新提交。' : '5 个问题均需填写至少 20 个字符。'}</span><button class="command-button" id="submit-answers">提交回答</button></div>` : '';
  const canRetry = ['APPROVED', 'AUTO_APPROVED'].includes(report.manager_review_status);
  const syncAction = canRetry ? `<div class="audit-actions sync-action"><span>${statusLabel[report.sync_status] || report.sync_status}</span><button class="secondary-button" id="retry-sync">重新同步企微</button></div>` : '';
  document.querySelector('#audit-body').innerHTML = `<div class="audit-content"><p class="audit-summary">${escapeHtml(audit.summary)}</p><div class="audit-grid">${findings}</div><div class="answers">${answers}</div>${auditAction}${reviewPanel(report)}${syncAction}</div>`;
  dialog.showModal();
  const submit = document.querySelector('#submit-answers');
  const retry = document.querySelector('#retry-sync');
  const approve = document.querySelector('#approve-report');
  const rework = document.querySelector('#request-rework');
  if (submit) submit.onclick = submitAnswers;
  if (retry) retry.onclick = retrySync;
  if (approve) approve.onclick = () => reviewReport('APPROVED');
  if (rework) rework.onclick = () => reviewReport('REWORK_REQUIRED');
}

async function startAudit() { try { await api(`/api/reports/${selectedReport.id}/audit`, { method: 'POST', body: '{}' }); await refresh(); await openReport(selectedReport.id); } catch (error) { notify(error.message); } }
async function submitAnswers() {
  const answers = Object.fromEntries(selectedReport.audit.questions.map((question) => [question.id, document.querySelector(`#${question.id}`).value]));
  try { const updated = await api(`/api/reports/${selectedReport.id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) }); await refresh(); await openReport(updated.id); notify(updated.manager_review_status === 'PENDING_REVIEW' ? '审计通过，已进入主管审核。' : '回答已保存。'); } catch (error) { notify(error.message); }
}
async function reviewReport(decision) {
  const comment = document.querySelector('#review-comment').value;
  try { const updated = await api(`/api/reports/${selectedReport.id}/review`, { method: 'POST', body: JSON.stringify({ decision, comment }) }); await refresh(); await openReport(updated.id); notify(decision === 'APPROVED' ? '主管审核通过，已提交归档。' : '已通知提交人补充日报。'); } catch (error) { notify(error.message); }
}
async function retrySync() { try { const updated = await api(`/api/reports/${selectedReport.id}/sync`, { method: 'POST', body: '{}' }); await refresh(); await openReport(updated.id); notify(['synced', 'demo_synced'].includes(updated.sync_status) ? '同步已完成。' : '同步未完成，请查看状态。'); } catch (error) { notify(error.message); } }

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => view(item.dataset.view)));
document.querySelectorAll('[data-view-target]').forEach((item) => item.addEventListener('click', () => view(item.dataset.viewTarget)));
document.querySelector('#close-dialog').onclick = () => dialog.close();
document.addEventListener('click', (event) => { const button = event.target.closest('[data-report-id]'); if (button) openReport(button.dataset.reportId); });
document.querySelector('#actor-select').addEventListener('change', async (event) => {
  currentActorId = event.target.value; localStorage.setItem('daily-audit-actor', currentActorId); updateIdentityUI(); view('dashboard');
  try { await refresh(); } catch (error) { notify(error.message); }
});
document.querySelector('#report-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
  try { const report = await api('/api/reports', { method: 'POST', body: JSON.stringify(values) }); event.currentTarget.reset(); document.querySelector('#report-date').value = dateToday(); updateIdentityUI(); await refresh(); await openReport(report.id); notify('日报已保存，开始审计。'); } catch (error) { notify(error.message); }
});

async function boot() {
  document.querySelector('#report-date').value = dateToday();
  employees = await api('/api/employees');
  if (!employees.some((item) => item.id === currentActorId)) currentActorId = employees[0].id;
  document.querySelector('#actor-select').innerHTML = employees.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('');
  updateIdentityUI(); await refresh();
}
boot().catch((error) => notify(`启动失败：${error.message}`));
