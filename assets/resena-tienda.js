// Formulario de captura de datos en tienda (correo, teléfono, tipo de
// evento) + redirección a la liga de reseña de la sucursal. Un solo script
// compartido por las 3 páginas (resena-cdmx.html, resena-puebla.html,
// resena-queretaro.html): cada página solo pone su ciudad y su liga de
// reseña en el <script data-ciudad="..." data-review-url="...">, igual que
// ya se hace con otros scripts de assets/ en las páginas de CMS.
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

// document.currentScript solo es válido en la ejecución síncrona inicial
// del script — hay que leerlo aquí afuera, no dentro del listener de abajo.
const thisScript = document.currentScript;
const ciudad = thisScript?.dataset.ciudad || '';
const reviewUrl = thisScript?.dataset.reviewUrl || '';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('leadForm');
  const btn = document.getElementById('leadSubmitBtn');
  const msg = document.getElementById('leadMsg');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const correo = document.getElementById('leadCorreo').value.trim();
    const telefono = document.getElementById('leadTelefono').value.trim();
    const tipoEvento = document.getElementById('leadTipoEvento').value;

    msg.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Enviando…';

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/leads_tienda`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify({ ciudad, correo, telefono, tipo_evento: tipoEvento })
      });
      if (!r.ok) throw new Error(`POST leads_tienda -> ${r.status}`);

      if (reviewUrl) {
        window.location.href = reviewUrl;
      } else {
        form.classList.add('hidden');
        msg.textContent = '¡Gracias! Ya guardamos tus datos.';
        msg.classList.remove('hidden');
      }
    } catch (err) {
      msg.textContent = 'No se pudo enviar. Intenta de nuevo o avísale a quien te atiende.';
      msg.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Enviar';
    }
  });
});
