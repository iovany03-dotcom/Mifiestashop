'use strict';
// Run on a trusted workstation with environment variables, never in the browser.
// Each completed page is durable; restart resumes after its last committed ID.
const { runFullSync } = require('../lib/sync-prestashop');

(async () => {
  const required = ['PS_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  for (const name of required) if (!process.env[name]) throw new Error(`Falta ${name}`);
  const domains = process.argv.slice(2);
  const results = await runFullSync({
    baseUrl: process.env.PS_BASE_URL || 'https://www.mifiestashop.com', apiKey: process.env.PS_API_KEY,
    supabaseUrl: process.env.SUPABASE_URL || 'https://iuoirslxjcyarvmrqyjd.supabase.co',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    timeBudgetMs: 60 * 60 * 1000,
    domains: domains.length ? domains : ['clientes', 'direcciones', 'productos', 'precios', 'disponibilidad', 'pedidos_historicos']
  });
  console.log(JSON.stringify(results, null, 2));
  if (Object.values(results).some(result => !result.ok || result.complete === false)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
