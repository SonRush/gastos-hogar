// Worker de la app (dashboard + API). Solo abre con un JWT valido de Cloudflare Access.
import html from './index.html';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const hoyMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

// ---------- autenticacion (Cloudflare Access) ----------

let certCache = { at: 0, keys: [] };
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function verificarAccess(req, env) {
  // Falla cerrado: sin configuracion de Access no se atiende a nadie.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { error: 'Access no configurado', status: 503 };
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) return { error: 'No autenticado', status: 401 };
  try {
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64u(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64u(p)));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const validos = env.ACCESS_AUD.split(',').map((x) => x.trim()).filter(Boolean);
    if (!aud.some((a) => validos.includes(a))) throw new Error('aud');
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new Error('iss');
    if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('exp');

    if (Date.now() - certCache.at > 3600_000 || !certCache.keys.some((k) => k.kid === header.kid)) {
      const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('kid');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new Error('firma');
    return { email: payload.email || 'desconocido' };
  } catch (e) {
    return { error: 'Token invalido', status: 401 };
  }
}

// ---------- rutas ----------

export default {
  async fetch(req, env) {
    const auth = await verificarAccess(req, env);
    if (auth.error) return new Response(auth.error, { status: auth.status });

    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== 'GET') {
      // Defensa CSRF: solo peticiones del mismo origen.
      const origin = req.headers.get('origin');
      if (!origin || new URL(origin).host !== url.host) return json({ error: 'origen no permitido' }, 403);
    }

    try {
      if (path === '/' && req.method === 'GET') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (path === '/api/meta') return meta(env, auth);
      if (path === '/api/resumen') return resumen(env, url);
      if (path === '/api/gastos' && req.method === 'GET') return listar(env, url);

      let m = path.match(/^\/api\/gastos\/(\d+)$/);
      if (m && req.method === 'PATCH') return editar(env, Number(m[1]), await req.json(), auth);
      m = path.match(/^\/api\/gastos\/(\d+)\/(archivar|restaurar)$/);
      if (m && req.method === 'POST') return archivar(env, Number(m[1]), m[2], auth);
      m = path.match(/^\/api\/gastos\/(\d+)\/devolucion$/);
      if (m && req.method === 'POST') return devolver(env, Number(m[1]), await req.json().catch(() => ({})), auth);
      m = path.match(/^\/api\/gastos\/(\d+)\/imagen$/);
      if (m && req.method === 'GET') return imagen(env, Number(m[1]));
      m = path.match(/^\/api\/categorias\/(\d+)$/);
      if (m && req.method === 'PUT') return presupuesto(env, Number(m[1]), await req.json(), auth);
    } catch (e) {
      console.error('error', e && e.message);
      return json({ error: 'error interno' }, 500);
    }
    return json({ error: 'no encontrado' }, 404);
  },
};

const mesValido = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? m : hoyMX().slice(0, 7));
const bitacora = (env, gasto_id, accion, detalle, autor) =>
  env.DB.prepare('INSERT INTO cambios (gasto_id, accion, detalle, autor) VALUES (?,?,?,?)')
    .bind(gasto_id, accion, detalle, autor).run();

async function meta(env, auth) {
  const cats = await env.DB.prepare('SELECT id, nombre FROM categorias WHERE activa=1 ORDER BY id').all();
  const mets = await env.DB.prepare('SELECT id, nombre FROM metodos_pago WHERE activo=1 ORDER BY id').all();
  return json({ categorias: cats.results, metodos: mets.results, usuario: auth.email });
}

async function resumen(env, url) {
  const mes = mesValido(url.searchParams.get('mes'));
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nombre, c.presupuesto_centavos presupuesto,
       COALESCE((SELECT SUM(monto_centavos) FROM gastos WHERE categoria_id=c.id AND estado='activo' AND substr(fecha,1,7)=?),0) gastado
     FROM categorias c WHERE c.activa=1 ORDER BY c.id`,
  ).bind(mes).all();
  const sin = await env.DB.prepare(
    `SELECT COALESCE(SUM(monto_centavos),0) t FROM gastos WHERE categoria_id IS NULL AND estado='activo' AND substr(fecha,1,7)=?`,
  ).bind(mes).first();
  const total = results.reduce((s, r) => s + r.gastado, 0) + sin.t;
  return json({ mes, total, sin_categoria: sin.t, categorias: results });
}

async function listar(env, url) {
  const mes = mesValido(url.searchParams.get('mes'));
  const archivados = url.searchParams.get('archivados') === '1';
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.monto_centavos, g.fecha, g.comercio, g.categoria_id, g.metodo_pago_id, g.estado,
            g.devolucion_de, g.imagen_key IS NOT NULL tiene_imagen, c.nombre categoria, m.nombre metodo
     FROM gastos g LEFT JOIN categorias c ON c.id=g.categoria_id LEFT JOIN metodos_pago m ON m.id=g.metodo_pago_id
     WHERE substr(g.fecha,1,7)=? AND (? OR g.estado='activo') ORDER BY g.fecha DESC, g.id DESC`,
  ).bind(mes, archivados ? 1 : 0).all();
  return json({ mes, gastos: results });
}

async function editar(env, id, body, auth) {
  const g = await env.DB.prepare('SELECT * FROM gastos WHERE id=?').bind(id).first();
  if (!g) return json({ error: 'no existe' }, 404);
  const sets = [], vals = [], cambios = {};
  const poner = (col, v) => { sets.push(`${col}=?`); vals.push(v); cambios[col] = [g[col], v]; };

  if ('monto_centavos' in body) {
    if (!Number.isInteger(body.monto_centavos) || body.monto_centavos === 0 || Math.abs(body.monto_centavos) > 1e9) return json({ error: 'monto invalido' }, 400);
    poner('monto_centavos', body.monto_centavos);
  }
  if ('fecha' in body) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) return json({ error: 'fecha invalida' }, 400);
    poner('fecha', body.fecha);
  }
  if ('comercio' in body) poner('comercio', String(body.comercio).slice(0, 80));
  if ('categoria_id' in body) {
    if (!(await env.DB.prepare('SELECT 1 FROM categorias WHERE id=?').bind(body.categoria_id).first())) return json({ error: 'categoria invalida' }, 400);
    poner('categoria_id', body.categoria_id);
  }
  if ('metodo_pago_id' in body) {
    if (!(await env.DB.prepare('SELECT 1 FROM metodos_pago WHERE id=?').bind(body.metodo_pago_id).first())) return json({ error: 'metodo invalido' }, 400);
    poner('metodo_pago_id', body.metodo_pago_id);
  }
  if (!sets.length) return json({ error: 'sin cambios' }, 400);
  await env.DB.prepare(`UPDATE gastos SET ${sets.join(', ')} WHERE id=?`).bind(...vals, id).run();
  await bitacora(env, id, 'editar', JSON.stringify(cambios), auth.email);
  return json({ ok: true });
}

async function archivar(env, id, accion, auth) {
  const estado = accion === 'archivar' ? 'archivado' : 'activo';
  const r = await env.DB.prepare('UPDATE gastos SET estado=? WHERE id=?').bind(estado, id).run();
  if (!r.meta.changes) return json({ error: 'no existe' }, 404);
  await bitacora(env, id, accion, null, auth.email);
  return json({ ok: true });
}

async function devolver(env, id, body, auth) {
  const g = await env.DB.prepare('SELECT * FROM gastos WHERE id=? AND devolucion_de IS NULL AND monto_centavos > 0').bind(id).first();
  if (!g) return json({ error: 'gasto no valido para devolucion' }, 400);
  const prev = await env.DB.prepare(
    `SELECT COALESCE(-SUM(monto_centavos),0) t FROM gastos WHERE devolucion_de=? AND estado='activo'`,
  ).bind(id).first();
  const monto = body.monto_centavos ?? g.monto_centavos - prev.t;
  if (!Number.isInteger(monto) || monto <= 0 || monto + prev.t > g.monto_centavos) return json({ error: 'monto de devolucion invalido' }, 400);
  const ins = await env.DB.prepare(
    `INSERT INTO gastos (monto_centavos, fecha, comercio, categoria_id, metodo_pago_id, devolucion_de, creado_por)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(-monto, hoyMX(), `Devolución: ${g.comercio || ''}`.slice(0, 80), g.categoria_id, g.metodo_pago_id, id, auth.email).run();
  await bitacora(env, ins.meta.last_row_id, 'devolucion', `de gasto ${id}`, auth.email);
  return json({ ok: true, id: ins.meta.last_row_id });
}

async function imagen(env, id) {
  const g = await env.DB.prepare('SELECT imagen_key FROM gastos WHERE id=?').bind(id).first();
  if (!g?.imagen_key) return json({ error: 'sin imagen' }, 404);
  const o = await env.TICKETS.get(g.imagen_key);
  if (!o) return json({ error: 'sin imagen' }, 404);
  return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
}

async function presupuesto(env, id, body, auth) {
  const v = body.presupuesto_centavos;
  if (v !== null && (!Number.isInteger(v) || v < 0 || v > 1e10)) return json({ error: 'monto invalido' }, 400);
  const r = await env.DB.prepare('UPDATE categorias SET presupuesto_centavos=? WHERE id=?').bind(v, id).run();
  if (!r.meta.changes) return json({ error: 'no existe' }, 404);
  await bitacora(env, null, 'presupuesto', `categoria ${id} -> ${v}`, auth.email);
  return json({ ok: true });
}
