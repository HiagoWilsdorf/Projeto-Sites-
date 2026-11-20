'use strict';
const { getSettings, accountSettings } = require('./db');
const F = require('./finance');
const M = require('./messaging');

function inWindow(settings) {
  const now = F.nowTimeIn(settings.timezone);
  return now >= (settings.send_window_start || '00:00') && now <= (settings.send_window_end || '23:59');
}

/**
 * Executa as regras de cobrança.
 * @param {object} opts { ownerId: só uma conta (null = todas), force: ignora janela de horário, dryRun: só pré-visualiza }
 */
async function runAutomations(db, opts = {}) {
  const g = await getSettings(db);
  const summary = { ran_at: new Date().toISOString(), skipped: null, created: 0, sent: 0, pending_manual: 0, failed: 0, preview: [] };
  if (!opts.force && g.automations_enabled !== '1') { summary.skipped = 'Automações desativadas'; return summary; }
  if (!opts.force && !inWindow(g)) { summary.skipped = `Fora da janela de envio (${g.send_window_start}–${g.send_window_end})`; return summary; }
  const today = F.todayIn(g.timezone);
  const rules = await db.query('SELECT r.*, t.body AS template_body FROM rules r JOIN templates t ON t.id=r.template_id WHERE r.active');
  if (!rules.length) return summary;
  const params = [];
  let ownerFilter = '';
  if (opts.ownerId) { params.push(opts.ownerId); ownerFilter = 'AND l.owner_id=$1'; }
  const insts = await db.query(`
    SELECT i.*, l.client_id, l.owner_id FROM installments i
    JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id JOIN users u ON u.id=l.owner_id
    WHERE i.status='open' AND l.status='active' AND NOT c.archived AND u.active ${ownerFilter}
    ORDER BY i.due_date`, params);

  const cache = { s: new Map(), c: new Map(), l: new Map() };
  const memo = async (map, key, fn) => { if (!map.has(key)) map.set(key, await fn()); return map.get(key); };

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
      if (await db.one('SELECT 1 FROM messages WHERE dedupe_key=$1', [key])) continue;

      const settings = await memo(cache.s, inst.owner_id, () => accountSettings(db, inst.owner_id));
      const client = await memo(cache.c, inst.client_id, () => db.one('SELECT * FROM clients WHERE id=$1', [inst.client_id]));
      const loan = await memo(cache.l, inst.loan_id, () => db.one('SELECT * FROM loans WHERE id=$1', [inst.loan_id]));
      const body = M.render(rule.template_body, await M.buildContext(db, { settings, client, loan, installment: inst }));
      const kind = rule.trigger === 'after_due' ? 'overdue' : rule.trigger === 'on_due' ? 'due' : 'reminder';
      if (opts.dryRun) {
        summary.preview.push({ rule: rule.name, client: client.name, owner_id: inst.owner_id, installment_id: inst.id, channel: rule.channel, body });
        continue;
      }
      const msg = await M.dispatch(db, {
        ownerId: inst.owner_id, client, loanId: loan.id, installmentId: inst.id, ruleId: rule.id, dedupeKey: key, channel: rule.channel, kind, body, settings,
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

module.exports = { runAutomations, inWindow };
