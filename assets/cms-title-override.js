// El título de esta página se puede editar desde el admin (Páginas CMS) sin
// necesidad de un nuevo deploy — se guarda en Supabase (cms_titulos_override)
// y esta página lo aplica sola al cargar, si existe uno para su id.
(function () {
  const pageId = document.body.getAttribute('data-cms-id');
  if (!pageId || !/^\d+$/.test(pageId)) return;
  const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
  fetch(`${SUPABASE_URL}/rest/v1/cms_titulos_override?page_id=eq.${pageId}&select=titulo`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  })
    .then(r => (r.ok ? r.json() : []))
    .then(rows => {
      const titulo = Array.isArray(rows) && rows[0] && rows[0].titulo;
      if (!titulo) return;
      document.title = titulo + ' | Mi Fiestashop';
      const h1 = document.querySelector('h1');
      if (h1) h1.textContent = titulo;
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) ogTitle.setAttribute('content', titulo);
    })
    .catch(() => {});
})();
