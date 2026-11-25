'use strict';
// Localização consentida: descobre o IP de quem acessa o link e faz a consulta
// de geolocalização (IP e, quando o cliente autoriza, GPS do navegador).
// Tudo é acionado por uma página pública com aviso e consentimento explícito.

const GENERIC_UA = 'gestao-emprestimos-verificacao/1.0';

/** IP real do cliente, respeitando o proxy (Vercel/Neon). */
function ipFromReq(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '').trim();
}

/** IPs locais/privados não têm geolocalização pública. */
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^(fc|fd)/i.test(ip)) return true;
  return false;
}

async function fetchJson(url, { timeout = 6000, headers } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': GENERIC_UA, 'Accept': 'application/json', ...headers } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Geolocalização aproximada pelo IP. Tenta ipwho.is e, se falhar, ipapi.co.
 * Nunca lança: retorna null quando não consegue (o registro é salvo mesmo assim).
 */
async function lookupIp(ip) {
  if (isPrivateIp(ip)) return null;
  const a = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (a && a.success !== false && (a.latitude != null || a.city)) {
    return {
      city: a.city || null, region: a.region || null, country: a.country || null,
      lat: a.latitude ?? null, lng: a.longitude ?? null,
      org: a.connection?.isp || a.connection?.org || null,
    };
  }
  const b = await fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  if (b && !b.error && (b.latitude != null || b.city)) {
    return {
      city: b.city || null, region: b.region || null, country: b.country_name || b.country || null,
      lat: b.latitude ?? null, lng: b.longitude ?? null,
      org: b.org || null,
    };
  }
  return null;
}

/**
 * Endereço aproximado a partir das coordenadas de GPS (OpenStreetMap/Nominatim).
 * Enviamos apenas lat/lng — nenhum dado pessoal do cliente. Nunca lança.
 */
async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0&accept-language=pt-BR`;
  const r = await fetchJson(url, { headers: { 'Accept-Language': 'pt-BR' } });
  return r?.display_name || null;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

module.exports = { ipFromReq, isPrivateIp, lookupIp, reverseGeocode, num };
