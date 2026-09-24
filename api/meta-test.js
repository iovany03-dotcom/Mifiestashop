// Temporal: envía un Purchase de prueba a Meta (solo con test_event_code TEST...)
const { sendMetaEvent } = require('../lib/meta-capi.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const code = String(req.query.code || '');
  if (!/^TEST\d+$/.test(code)) {
    res.status(400).json({ error: 'code debe ser un test_event_code TEST...' });
    return;
  }
  try {
    const r = await sendMetaEvent({
      eventName: 'Purchase',
      eventId: 'prueba-servidor-' + Date.now(),
      eventSourceUrl: 'https://mifiestashop.vercel.app/',
      value: 100,
      contents: [{ id: '1', quantity: 1 }],
      customer: { name: 'Prueba Servidor', email: 'prueba@example.com', phone: '5555555555' },
      testEventCode: code,
    });
    res.status(200).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
