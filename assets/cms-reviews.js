// Las reseñas de "Así celebran nuestros clientes" venían fijas en el HTML
// generado en el build. Ahora, si hay reseñas activas capturadas en el
// admin (Reseñas de Clientes — la misma fuente que alimenta el carrusel
// del inicio), esta página las usa en su lugar sin esperar un nuevo
// deploy; si la consulta falla o no hay ninguna activa, se queda con las
// reseñas originales del HTML estático.
(function () {
  const grid = document.getElementById('cms-reviews-grid');
  if (!grid) return;
  const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  fetch(`${SUPABASE_URL}/rest/v1/resenas_clientes?select=nombre_cliente,texto,foto_url&activo=eq.true&order=orden.desc,created_at.desc`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  })
    .then(r => (r.ok ? r.json() : []))
    .then(rows => {
      if (!Array.isArray(rows) || !rows.length) return;
      grid.innerHTML = rows.map(r => `<figure class="review-card"><figcaption class="review-author"><span class="review-avatar" aria-hidden="true">${r.foto_url ? `<img src="${esc(r.foto_url)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8.5" r="3.5" fill="currentColor"/><path d="M4.5 20c0-4.2 3.4-7 7.5-7s7.5 2.8 7.5 7" fill="currentColor"/></svg>`}</span><span><strong>${esc(r.nombre_cliente)}</strong><span class="review-source">Opinión compartida con Mi Fiesta Shop</span></span></figcaption><blockquote>${esc(r.texto)}</blockquote></figure>`).join('');
    })
    .catch(() => {});
})();
