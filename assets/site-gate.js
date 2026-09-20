// TEMPORAL: clave de acceso al sitio mientras está en mantenimiento — quitar
// este archivo y su referencia (scripts/site-gate.html) cuando el sitio ya
// pueda verse sin clave.
(function () {
  var KEY = 'mf_site_gate_ok';
  var PASSWORD = 'fiesta2026';
  try {
    if (localStorage.getItem(KEY) === '1') {
      document.getElementById('siteGateOverlay').remove();
      return;
    }
  } catch (e) {}
  var form = document.getElementById('siteGateForm');
  var input = document.getElementById('siteGateInput');
  var err = document.getElementById('siteGateError');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (input.value === PASSWORD) {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      document.getElementById('siteGateOverlay').remove();
    } else {
      err.style.display = 'block';
      input.value = '';
      input.focus();
    }
  });
})();
