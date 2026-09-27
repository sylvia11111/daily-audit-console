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
const titles = { dashboard: '工作台', submit: '提交日报', reports: '日报记录', team: '团队审核' };
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

function actionFor(report) {
  if (report.permissions.can_review) return { rank: 1, label: '主管审核', detail: '审计已通过，等待你的验收结论。', command: '审核日报' };
  if (report.permissions.is_owner && report.manager_review_status === 'REWORK_REQUIRED') return { rank: 2, label: '主管要求补充', detail: report.review_comment || '请根据主管意见补充日报。', command: '查看意见' };
  if (report.permissions.is_owner && ['QUESTION_PENDING', 'REANSWER_REQUIRED'].includes(report.audit_status)) return { rank: 3, label: '等待回答审计', detail: '完成 5 个理解验证问题后进入主管审核。', command: '继续回答' };
  if (report.sync_status === 'sync_failed') return { rank: 4, label: '企微同步异常', detail: report.sync_job?.message || '归档未完成，请检查同步配置。', command: '查看详情' };
  return null;
}

function renderDashboard(summary) {
  const active = actor();
  const actions = reports.map((report) => ({ report, action: actionFor(report) })).filter((item) => item.action).sort((left, right) => left.action.rank - right.action.rank);
  const todayReports = reports.filter((report) => report.report_date === dateToday());
  const passed = reports.filter((report) => report.audit_status === 'PASSED').length;
  const reviewed = reports.filter((report) => ['APPROVED', 'AUTO_APPROVED'].includes(report.manager_review_status)).length;
  const synced = reports.filter((report) => ['synced', 'demo_synced'].includes(report.sync_status)).length;
  document.querySelector('#workflow-submitted').textContent = todayReports.length;
  document.querySelector('#workflow-audited').textContent = passed;
  document.querySelector('#workflow-reviewed').textContent = reviewed;
  document.querySelector('#workflow-synced').textContent = synced;
  document.querySelector('#priority-count').textContent = actions.length;

  const primary = document.querySelector('#primary-action');
  const managerActions = actions.filter((item) => item.report.permissions.can_review);
  if (isManager() && managerActions.length) {
    document.querySelector('#workspace-title').textContent = `${active.name}，有 ${managerActions.length} 份日报等待审核`;
    document.querySelector('#workspace-copy').textContent = '主管审核是日报归档前的最后一道关口，优先处理等待时间较长的日报。';
    primary.textContent = '处理团队审核';
    primary.onclick = () => view('team');
  } else if (actions.length) {
    const next = actions[0];
    document.querySelector('#workspace-title').textContent = `${active.name}，${next.action.label}`;
    document.querySelector('#workspace-copy').textContent = next.action.detail;
    primary.textContent = next.action.command;
    primary.onclick = () => openReport(next.report.id);
  } else {
    document.querySelector('#workspace-title').textContent = `${active.name}，今天的日报闭环很顺畅`;
    document.querySelector('#workspace-copy').textContent = isManager() ? '当前没有待审核日报，可在团队审核中查看整体进度。' : '暂无待处理事项，提交日报后系统会自动开始审计。';
    primary.textContent = isManager() ? '查看团队审核' : '提交日报';
    primary.onclick = () => view(isManager() ? 'team' : 'submit');
  }

  document.querySelector('#priority-list').innerHTML = actions.length ? actions.slice(0, 4).map(({ report, action }) => `<article class="priority-row"><span class="priority-marker priority-${action.rank}"></span><div class="priority-copy"><span>${escapeHtml(action.label)}</span><strong>${escapeHtml(report.task_name)}</strong><p>${escapeHtml(report.employee_name)} · ${escapeHtml(action.detail)}</p></div><button class="text-command" data-report-id="${report.id}">${action.command}</button></article>`).join('') : '<div class="empty-priority"><strong>暂无待处理事项</strong><span>新的日报、审计反馈和同步异常会优先显示在这里。</span></div>';

  const teamSize = isManager() ? (teamData?.members.length || 1) : 1;
  const completedToday = isManager() ? new Set(todayReports.map((report) => report.employee_id).filter((id) => id !== currentActorId)).size : todayReports.length;
  const completion = Math.min(100, Math.round((completedToday / teamSize) * 100));
  const failed = reports.filter((report) => report.sync_status === 'sync_failed').length;
  document.querySelector('#health-title').textContent = isManager() ? '团队今日健康度' : '我的今日闭环';
  document.querySelector('#completion-ring').style.setProperty('--completion', `${completion * 3.6}deg`);
  document.querySelector('#completion-percent').textContent = `${completion}%`;
  document.querySelector('#health-submitted').textContent = isManager() ? `${completedToday}/${teamSize}` : summary.today;
  document.querySelector('#health-pending').textContent = actions.length;
  document.querySelector('#health-failed').textContent = failed;
  document.querySelector('#health-status').textContent = failed ? '需关注' : actions.length ? '处理中' : '状态良好';
  document.querySelector('#health-status').className = `health-status ${failed ? 'alert' : actions.length ? 'waiting' : ''}`;
  document.querySelector('#health-copy').textContent = failed ? '存在归档异常，建议先检查企微 MCP 配置与同步记录。' : actions.length ? '优先处理上方队列中的事项，避免日报停留在审核节点。' : '当前可见范围内没有会阻塞日报归档的事项。';

  document.querySelector('#recent-reports').innerHTML = reports.length ? reports.slice(0, 5).map((report) => `<article class="activity-row" data-report-id="${report.id}"><div class="activity-avatar">${escapeHtml(report.employee_name.slice(0, 1))}</div><div><strong>${escapeHtml(report.task_name)}</strong><p>${escapeHtml(report.employee_name)} · ${report.report_date} · ${chip(report.manager_review_status)}</p></div><span>${chip(report.sync_status)}</span></article>`).join('') : '<div class="empty-state">尚无日报，先提交一份吧。</div>';
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
  document.querySelector('#wecom-status').textContent = health.wecom_configured ? '企微 MCP 已配置' : '企微：本地演示模式';
  renderReports('#all-reports', reports, '当前身份没有可见日报。');
  renderTeam();
  renderDashboard(summary);
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
document.addEventListener('click', (event) => { const target = event.target.closest('[data-report-id]'); if (target) openReport(target.dataset.reportId); });
document.querySelector('#actor-select').addEventListener('change', async (event) => {
  currentActorId = event.target.value; localStorage.setItem('daily-audit-actor', currentActorId); updateIdentityUI(); view('dashboard');
  try { await refresh(); } catch (error) { notify(error.message); }
});
document.querySelector('#report-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
  try { const report = await api('/api/reports', { method: 'POST', body: JSON.stringify(values) }); event.currentTarget.reset(); document.querySelector('#report-date').value = dateToday(); updateIdentityUI(); await refresh(); await openReport(report.id); notify('日报已保存，首轮审计已自动完成。'); } catch (error) { notify(error.message); }
});

async function boot() {
  document.querySelector('#report-date').value = dateToday();
  document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  employees = await api('/api/employees');
  if (!employees.some((item) => item.id === currentActorId)) currentActorId = employees[0].id;
  document.querySelector('#actor-select').innerHTML = employees.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('');
  updateIdentityUI(); await refresh();
}
boot().catch((error) => notify(`启动失败：${error.message}`));
