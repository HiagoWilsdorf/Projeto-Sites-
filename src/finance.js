'use strict';
// Cálculos financeiros. Todos os valores monetários em centavos (inteiros).

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function fmtDate({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(s, n) {
  const { y, m, d } = parseDate(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmtDate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

// Soma meses mantendo o dia de referência (31/01 + 1 mês = 28/02 ou 29/02).
function addMonths(s, n, anchorDay) {
  const { y, m, d } = parseDate(s);
  const day = anchorDay || d;
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return fmtDate({ y: ny, m: nm, d: Math.min(day, daysInMonth(ny, nm)) });
}

function diffDays(a, b) {
  // b - a em dias
  const A = parseDate(a), B = parseDate(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000);
}

function dueDateFor(firstDue, frequency, index) {
  switch (frequency) {
    case 'monthly': return addMonths(firstDue, index, parseDate(firstDue).d);
    case 'biweekly': return addDays(firstDue, 14 * index);
    case 'weekly': return addDays(firstDue, 7 * index);
    case 'daily': return addDays(firstDue, index);
    default: throw new Error('Frequência inválida: ' + frequency);
  }
}

/**
 * Gera o cronograma de parcelas.
 * @param {object} p
 * @param {number} p.principalCents
 * @param {number} p.rate  taxa em % por período
 * @param {string} p.method simple | price | interest_only
 * @param {number} p.count
 * @param {string} p.firstDueDate YYYY-MM-DD
 * @param {string} p.frequency
 */
function buildSchedule({ principalCents, rate, method, count, firstDueDate, frequency }) {
  const P = Math.round(principalCents);
  const n = Math.max(1, Math.floor(count));
  const r = Number(rate) / 100;
  if (!(P > 0)) throw new Error('Valor emprestado deve ser maior que zero');
  if (!(r >= 0)) throw new Error('Taxa de juros inválida');

  const rows = [];
  if (method === 'simple') {
    // Juros simples sobre o principal: total = P * (1 + r*n), parcelas iguais.
    const totalInterest = Math.round(P * r * n);
    const base = Math.floor(P / n);
    const baseI = Math.floor(totalInterest / n);
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const pc = last ? P - base * (n - 1) : base;
      const ic = last ? totalInterest - baseI * (n - 1) : baseI;
      rows.push({ principal: pc, interest: ic });
    }
  } else if (method === 'price') {
    // Tabela Price (juros compostos, parcelas fixas).
    const pmt = r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
    const pmtC = Math.round(pmt);
    let balance = P;
    for (let i = 0; i < n; i++) {
      const interest = Math.round(balance * r);
      let principal = pmtC - interest;
      if (i === n - 1) principal = balance; // última parcela zera o saldo
      balance -= principal;
      rows.push({ principal, interest });
    }
  } else if (method === 'interest_only') {
    // Só juros a cada período; principal devolvido na última parcela.
    const interest = Math.round(P * r);
    for (let i = 0; i < n; i++) {
      rows.push({ principal: i === n - 1 ? P : 0, interest });
    }
  } else {
    throw new Error('Método de cálculo inválido: ' + method);
  }

  return rows.map((row, i) => ({
    number: i + 1,
    due_date: dueDateFor(firstDueDate, frequency, i),
    principal_cents: row.principal,
    interest_cents: row.interest,
    amount_cents: row.principal + row.interest,
  }));
}

/**
 * Encargos por atraso de uma parcela em aberto, numa data de referência.
 * multa: % única sobre o valor da parcela; mora: % ao dia (juros simples) sobre o valor da parcela.
 */
function lateCharges(inst, loan, refDate) {
  if (inst.status !== 'open') return { daysLate: 0, fee: 0, interest: 0, total: 0 };
  const daysLate = Math.max(0, diffDays(inst.due_date, refDate));
  if (daysLate === 0 || inst.waived_penalty) return { daysLate, fee: 0, interest: 0, total: 0 };
  const base = inst.amount_cents;
  const fee = Math.round(base * (Number(loan.late_fee_percent) || 0) / 100);
  const interest = Math.round(base * (Number(loan.late_interest_daily) || 0) / 100 * daysLate);
  return { daysLate, fee, interest, total: fee + interest };
}

/** Situação atual de uma parcela. */
function installmentState(inst, loan, refDate) {
  const charges = lateCharges(inst, loan, refDate);
  const penalty = inst.status === 'open' ? charges.total : inst.penalty_cents;
  const due = inst.amount_cents + penalty;
  const remaining = inst.status === 'open' ? Math.max(0, due - inst.paid_cents) : 0;
  let situation;
  if (inst.status === 'paid') situation = 'paid';
  else if (inst.status === 'canceled') situation = 'canceled';
  else if (charges.daysLate > 0) situation = 'overdue';
  else if (inst.due_date === refDate) situation = 'due_today';
  else situation = 'open';
  return {
    ...inst,
    days_late: charges.daysLate,
    late_fee_cents: inst.status === 'open' ? charges.fee : 0,
    late_interest_cents: inst.status === 'open' ? charges.interest : 0,
    current_penalty_cents: penalty,
    updated_amount_cents: due,
    remaining_cents: remaining,
    situation,
  };
}

function formatBRL(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBR(s) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function nowTimeIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  } catch {
    return new Date().toISOString().slice(11, 16);
  }
}

module.exports = {
  addDays, addMonths, diffDays, dueDateFor, buildSchedule, lateCharges,
  installmentState, formatBRL, formatDateBR, todayIn, nowTimeIn,
};
