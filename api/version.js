// Versión desplegada del sitio (commit de Vercel). El panel la consulta cada
// pocos minutos: el admin es una sola página que se queda abierta días, y sin
// esto seguía usando la versión vieja hasta que alguien recargaba a mano.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const version = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || null;
  res.status(200).json({ version });
};
