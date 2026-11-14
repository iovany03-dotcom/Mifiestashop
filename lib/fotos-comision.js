// Calendario de las fotos de tienda para la comisión del personal.
//
// La comisión se paga cada quincena (el día 15 de cada mes). Un día ANTES del pago, a cada persona
// del equipo le aparece en el panel el aviso para adjuntar las fotos de su tienda. Si la quincena
// cae en domingo, el pago se adelanta al sábado, así que el aviso sale el viernes.
//
// Ventana para subir: desde el día del aviso hasta el día del pago (inclusive), hora de CDMX.
const DIAS_QUINCENA = [15];          // agregar el último día del mes aquí si también se paga
const ZONA = 'America/Mexico_City';

// Fecha de hoy en CDMX como 'YYYY-MM-DD'.
function hoyMx(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

const iso = d => d.toISOString().slice(0, 10);
const fecha = s => new Date(`${s}T12:00:00Z`);
const sumarDias = (s, n) => { const d = fecha(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// Quincena (YYYY-MM-DD) -> { periodo, pago, aviso }.
function calendarioDe(periodo) {
  const domingo = fecha(periodo).getUTCDay() === 0;
  const pago = domingo ? sumarDias(periodo, -1) : periodo;
  return { periodo, pago, aviso: sumarDias(pago, -1) };
}

function quincenasDelMes(anio, mes) {
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return DIAS_QUINCENA.map(d => `${anio}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`);
}

// La quincena cuya ventana (aviso..pago) contiene hoy, o null.
function ventanaAbierta(hoy = hoyMx()) {
  const [a, m] = hoy.split('-').map(Number);
  for (const p of quincenasDelMes(a, m)) {
    const c = calendarioDe(p);
    if (hoy >= c.aviso && hoy <= c.pago) return c;
  }
  return null;
}

// La siguiente quincena cuyo pago es hoy o después (para mostrar "próximo aviso").
function proxima(hoy = hoyMx()) {
  let [a, m] = hoy.split('-').map(Number);
  for (let i = 0; i < 3; i++) {
    for (const p of quincenasDelMes(a, m)) { const c = calendarioDe(p); if (c.pago >= hoy) return c; }
    m++; if (m > 12) { m = 1; a++; }
  }
  return null;
}

const SUCURSALES = { rumania: 'CDMX Rumania', puebla: 'Puebla', queretaro: 'Querétaro' };
// personal_equipo.bodega_asignada ('CDMX Rumania', 'Puebla', 'Todas'…) -> clave o null (puede elegir).
function sucursalDeBodega(b) {
  const t = String(b || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (t.includes('rumania')) return 'rumania';
  if (t.includes('puebla')) return 'puebla';
  if (t.includes('queretaro')) return 'queretaro';
  return null;
}

module.exports = { hoyMx, calendarioDe, ventanaAbierta, proxima, sucursalDeBodega, SUCURSALES, DIAS_QUINCENA };
