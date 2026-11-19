'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../server/finance');

test('addMonths preserva o dia âncora e ajusta fim de mês', () => {
  assert.strictEqual(F.addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(F.addMonths('2028-01-31', 1), '2028-02-29');
  assert.strictEqual(F.dueDateFor('2026-01-31', 'monthly', 2), '2026-03-31');
  assert.strictEqual(F.addMonths('2026-11-15', 3), '2027-02-15');
});

test('juros simples: soma das parcelas = principal + juros', () => {
  const s = F.buildSchedule({ principalCents: 100000, rate: 10, method: 'simple', count: 3, firstDueDate: '2026-12-01', frequency: 'monthly' });
  assert.strictEqual(s.length, 3);
  const total = s.reduce((a, r) => a + r.amount_cents, 0);
  assert.strictEqual(total, 130000);
  assert.strictEqual(s.reduce((a, r) => a + r.principal_cents, 0), 100000);
  assert.deepStrictEqual(s.map((r) => r.due_date), ['2026-12-01', '2027-01-01', '2027-02-01']);
});

test('tabela Price: parcelas fixas e principal amortizado por completo', () => {
  const s = F.buildSchedule({ principalCents: 100000, rate: 5, method: 'price', count: 12, firstDueDate: '2026-12-10', frequency: 'monthly' });
  assert.strictEqual(s.reduce((a, r) => a + r.principal_cents, 0), 100000);
  assert.strictEqual(s[0].amount_cents, 11283); // PMT de 1000 a 5% em 12x ≈ 112,83
  assert.ok(Math.abs(s[11].amount_cents - 11283) <= 12);
});

test('só juros: principal na última parcela', () => {
  const s = F.buildSchedule({ principalCents: 50000, rate: 20, method: 'interest_only', count: 3, firstDueDate: '2026-12-01', frequency: 'weekly' });
  assert.deepStrictEqual(s.map((r) => r.amount_cents), [10000, 10000, 60000]);
  assert.deepStrictEqual(s.map((r) => r.due_date), ['2026-12-01', '2026-12-08', '2026-12-15']);
});

test('encargos de atraso: multa + mora diária', () => {
  const inst = { status: 'open', due_date: '2026-11-01', amount_cents: 10000, paid_cents: 0, waived_penalty: 0, penalty_cents: 0 };
  const loan = { late_fee_percent: 2, late_interest_daily: 1 };
  const st = F.installmentState(inst, loan, '2026-11-11');
  assert.strictEqual(st.days_late, 10);
  assert.strictEqual(st.late_fee_cents, 200);
  assert.strictEqual(st.late_interest_cents, 1000);
  assert.strictEqual(st.remaining_cents, 11200);
  assert.strictEqual(st.situation, 'overdue');
  assert.strictEqual(F.installmentState({ ...inst, waived_penalty: 1 }, loan, '2026-11-11').remaining_cents, 10000);
  assert.strictEqual(F.installmentState(inst, loan, '2026-11-01').situation, 'due_today');
});
