// IndexNow: avisa a Bing (y a Yandex, Seznam, Naver...) en el momento en que una página cambia,
// en vez de esperar a que la vuelvan a visitar. ChatGPT busca en buena parte sobre el índice de
// Bing. La llave es pública por diseño: va en /<llave>.txt para comprobar que el dominio es nuestro.
// https://www.indexnow.org/documentation
const LLAVE = 'db173508e989e205cf5a24af5fc3f8d9';
const HOST = 'www.mifiestashop.com';

async function avisar(urls) {
  const lista = [...new Set((urls || []).filter(u => typeof u === 'string' && u.startsWith(`https://${HOST}/`)))];
  let enviadas = 0;
  for (let i = 0; i < lista.length; i += 10000) {
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: LLAVE, keyLocation: `https://${HOST}/${LLAVE}.txt`, urlList: lista.slice(i, i + 10000) }),
      signal: AbortSignal.timeout(30000)
    });
    // 200 = recibido, 202 = recibido y la llave se validará después.
    if (r.status !== 200 && r.status !== 202) throw new Error(`IndexNow respondió HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    enviadas += lista.slice(i, i + 10000).length;
  }
  return { enviadas };
}

module.exports = { avisar, LLAVE, HOST };
