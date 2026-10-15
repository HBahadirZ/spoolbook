// Spoolbook cost engine. Pure functions: no DOM, no storage.
// Weights in grams, lengths in millimetres, time in hours, money in the user's currency.

export const MATERIALS = {
  PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, Nylon: 1.14, PC: 1.20, 'PLA-CF': 1.30, 'PETG-CF': 1.30, Other: 1.24,
};

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
export const num = (raw) => {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim().replace(',', '.');
  return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
};
const pos = (raw, fallback = 0) => { const v = num(raw); return isNum(v) && v >= 0 ? v : fallback; };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Grams of filament for a length in mm. density in g/cm³, diameter in mm. */
export function gramsFromLength(lengthMm, diameterMm = 1.75, density = 1.24) {
  const r = diameterMm / 2;
  return (lengthMm * Math.PI * r * r * density) / 1000;
}
export function lengthFromGrams(grams, diameterMm = 1.75, density = 1.24) {
  const r = diameterMm / 2;
  return (grams * 1000) / (Math.PI * r * r * density);
}

export function spoolCostPerGram(spool) {
  const price = pos(spool?.price, NaN);
  const weight = pos(spool?.weightG, NaN);
  return isNum(price) && isNum(weight) && weight > 0 ? price / weight : NaN;
}

export function printerHourlyCost(printer) {
  const price = pos(printer?.price);
  const life = pos(printer?.lifeHours);
  const maint = pos(printer?.maintPerHour);
  return (life > 0 ? price / life : 0) + maint;
}

/** Parses "1h 2m 3s", "2d 4h", "95m", "1:30" (h:mm) or plain hours "1.5" into hours. */
export function parseDuration(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim().toLowerCase();
  if (!s) return NaN;
  let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0);
  if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);
  let total = 0, found = false;
  for (const [re, mult] of [[/(\d+(?:\.\d+)?)\s*d/, 24], [/(\d+(?:\.\d+)?)\s*h/, 1], [/(\d+(?:\.\d+)?)\s*m(?!s)/, 1 / 60], [/(\d+(?:\.\d+)?)\s*s/, 1 / 3600]]) {
    const x = s.match(re);
    if (x) { total += parseFloat(x[1]) * mult; found = true; }
  }
  return found ? total : NaN;
}

export function formatDuration(hours) {
  if (!isNum(hours) || hours <= 0) return '0m';
  const totalMin = Math.round(hours * 60);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', m || (!d && !h) ? `${m}m` : ''].filter(Boolean).join(' ');
}

/**
 * Costs a job.
 * job = { printerId, prints: [{ label, time, runs, filaments: [{ spoolId, grams }] }],
 *         units, setupMin, postMinPerRun, extras: [{ label, cost }], failurePct, markupPct }
 * ctx = { printers, spools, settings: { electricityRate, laborRate, taxPct, feePct, feeFixed, roundTo } }
 */
export function costJob(job, ctx) {
  const warnings = [];
  const printer = (ctx.printers || []).find((p) => p.id === job.printerId) || null;
  if (!printer) warnings.push('Pick a printer.');
  const s = ctx.settings || {};
  const rate = pos(s.electricityRate);
  const watts = pos(printer?.watts);
  const machinePerHour = printer ? printerHourlyCost(printer) : 0;

  let material = 0, electricity = 0, wear = 0, hours = 0, runsTotal = 0;
  const gramsBySpool = new Map();
  const prints = (job.prints || []).map((pr) => {
    const runs = Math.max(0, Math.round(pos(pr.runs, 1)));
    const h = parseDuration(pr.time);
    const printHours = isNum(h) ? h : 0;
    if (!isNum(h) && String(pr.time ?? '').trim()) warnings.push(`Check the print time for ${pr.label || 'a print'}.`);
    let mat = 0, grams = 0;
    for (const f of pr.filaments || []) {
      const g = pos(f.grams);
      const spool = (ctx.spools || []).find((sp) => sp.id === f.spoolId);
      const cpg = spoolCostPerGram(spool);
      if (g > 0 && !spool) warnings.push(`Pick a spool for ${pr.label || 'a print'}.`);
      else if (g > 0 && !isNum(cpg)) warnings.push(`Add the price and weight for ${spool.name || 'a spool'}.`);
      if (isNum(cpg)) mat += g * cpg;
      grams += g;
      if (spool && g > 0) gramsBySpool.set(spool.id, (gramsBySpool.get(spool.id) || 0) + g * runs);
    }
    const elec = (watts / 1000) * printHours * rate;
    const w = printHours * machinePerHour;
    material += mat * runs; electricity += elec * runs; wear += w * runs;
    hours += printHours * runs; runsTotal += runs;
    return { label: pr.label, runs, hours: printHours, grams, material: mat, electricity: elec, wear: w, perRun: mat + elec + w };
  });

  const machine = material + electricity + wear;
  const failurePct = pos(job.failurePct);
  const failure = machine * failurePct / 100;
  const laborMin = pos(job.setupMin) + pos(job.postMinPerRun) * runsTotal;
  const labor = (laborMin / 60) * pos(s.laborRate);
  const extras = (job.extras || []).reduce((a, e) => a + pos(e.cost), 0);
  const cost = machine + failure + labor + extras;

  const markupPct = pos(job.markupPct);
  let price = cost * (1 + markupPct / 100);
  const step = pos(s.roundTo);
  if (step > 0 && price > 0) price = Math.ceil(price / step - 1e-9) * step;
  const units = Math.max(1, Math.round(pos(job.units, 1)));
  const feePct = pos(s.feePct), feeFixed = pos(s.feeFixed);
  const fees = price > 0 ? price * feePct / 100 + feeFixed : 0;
  const profit = price - fees - cost;
  const tax = price * pos(s.taxPct) / 100;

  // Spool stock check
  const shortages = [];
  for (const [id, need] of gramsBySpool) {
    const sp = ctx.spools.find((x) => x.id === id);
    const left = pos(sp.remainingG, NaN);
    if (isNum(left) && need > left + 1e-9) shortages.push({ spoolId: id, name: sp.name, need: round2(need), left: round2(left) });
  }

  return {
    prints, warnings, shortages,
    gramsBySpool: Object.fromEntries([...gramsBySpool].map(([k, v]) => [k, round2(v)])),
    totalGrams: round2([...gramsBySpool.values()].reduce((a, b) => a + b, 0)),
    hours, runs: runsTotal, laborMin,
    material: round2(material), electricity: round2(electricity), wear: round2(wear),
    failure: round2(failure), failurePct, labor: round2(labor), extras: round2(extras),
    cost: round2(cost), markupPct, price: round2(price), units,
    perUnit: round2(price / units), costPerUnit: round2(cost / units),
    fees: round2(fees), profit: round2(profit), margin: price > 0 ? profit / price : 0,
    tax: round2(tax), total: round2(price + tax),
  };
}
