'use strict';
const { getSettings } = require('./db');
const F = require('./finance');
const M = require('./messaging');

function inWindow(settings) {
  const now = F.nowTimeIn(settings.timezone);
  const start = settings.send_window_start || '00:00';
  const end = settings.send_window_end || '23:59';
  return now >= start && now <= end;
}

/**
 * Executa as regras de automação de cobrança.
 * @param {object} opts { force: ignora janela de horário, dryRun: só lista o que seria enviado }
 */
async function runAutomations(db, opts = {}) {
  const settings = getSettings(db);
  const summary = { ran_at: new Date().toISOString(), skipped: null, created: 0, sent: 0, pending_manual: 0, failed: 0, preview: [] };
  if (!opts.force && !inWindow(settings)) {
    summary.skipped = `Fora da janela de envio (${settings.send_window_start}–${settings.send_window_end})`;
    return summary;
  }
  const today = F.todayIn(settings.timezone);
  const rules = db.prepare(`SELECT r.*, t.body AS template_body FROM rules r JOIN templates t ON t.id=r.template_id WHERE r.active=1`).all();
  const insts = db.prepare(`
    SELECT i.*, l.client_id, l.late_fee_percent, l.late_interest_daily, l.installments_count, l.principal_cents AS loan_principal,
           l.total_cents AS loan_total, l.status AS loan_status
    FROM installments i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id
    WHERE i.status='open' AND l.status='active' AND c.archived=0`).all();

  const clientCache = new Map();
  const loanCache = new Map();
  const getClient = (id) => clientCache.get(id) || (clientCache.set(id, db.prepare('SELECT * FROM clients WHERE id=?').get(id)), clientCache.get(id));
  const getLoan = (id) => loanCache.get(id) || (loanCache.set(id, db.prepare('SELECT * FROM loans WHERE id=?').get(id)), loanCache.get(id));

  for (const inst of insts) {
    const daysToDue = F.diffDays(today, inst.due_date);
    for (const rule of rules) {
      let key = null;
      if (rule.trigger === 'before_due') {
        if (daysToDue >= 1 && daysToDue <= rule.days) key = `r${rule.id}:i${inst.id}`;
      } else if (rule.trigger === 'on_due') {
        if (daysToDue === 0) key = `r${rule.id}:i${inst.id}`;
      } else if (rule.trigger === 'after_due') {
        const late = -daysToDue;
        if (late >= rule.days && late > 0) {
          const k = rule.repeat_every > 0 ? Math.floor((late - rule.days) / rule.repeat_every) : 0;
          if (!(rule.max_repeats > 0 && k >= rule.max_repeats)) key = `r${rule.id}:i${inst.id}:${k}`;
        }
      }
      if (!key) continue;
      if (db.prepare('SELECT 1 FROM messages WHERE dedupe_key=?').get(key)) continue;

      const client = getClient(inst.client_id);
      const loan = getLoan(inst.loan_id);
      const body = M.render(rule.template_body, M.buildContext(db, { client, loan, installment: inst }));
      const kind = rule.trigger === 'after_due' ? 'overdue' : rule.trigger === 'on_due' ? 'due' : 'reminder';

      if (opts.dryRun) {
        summary.preview.push({ rule: rule.name, client: client.name, installment_id: inst.id, channel: rule.channel, body });
        continue;
      }
      const msg = await M.dispatch(db, {
        client, loanId: loan.id, installmentId: inst.id, ruleId: rule.id, dedupeKey: key, channel: rule.channel, kind, body,
      });
      if (!msg) continue;
      summary.created++;
      if (msg.status === 'sent') summary.sent++;
      else if (msg.status === 'pending_manual') summary.pending_manual++;
      else if (msg.status === 'failed') summary.failed++;
    }
  }
  return summary;
}

function startScheduler(db, log = console) {
  let timer = null;
  let running = false;
  let last = null;
  const tick = async () => {
    const s = getSettings(db);
    if (s.scheduler_enabled !== '1' || running) return;
    running = true;
    try {
      last = await runAutomations(db);
      if (last.created) log.log(`[automação] ${last.created} mensagem(ns): ${last.sent} enviadas, ${last.pending_manual} p/ envio manual, ${last.failed} falhas`);
    } catch (e) {
      log.error('[automação] erro:', e);
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    clearInterval(timer);
    const minutes = Math.max(1, Number(getSettings(db).scheduler_interval_minutes) || 15);
    timer = setInterval(tick, minutes * 60000);
    timer.unref?.();
  };
  schedule();
  setTimeout(tick, 5000).unref?.();
  return { tick, reschedule: schedule, last: () => last, stop: () => clearInterval(timer) };
}

module.exports = { runAutomations, startScheduler };
