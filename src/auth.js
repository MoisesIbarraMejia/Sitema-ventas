import bcrypt from 'bcrypt';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

export { pool };

export async function verificarUsuario(username, password) {
  const res = await pool.query(
    'SELECT * FROM public.usuarios WHERE username = $1 AND activo = true',
    [username]
  );
  if (res.rows.length === 0) return null;
  const usuario = res.rows[0];
  const ok = await bcrypt.compare(password, usuario.password_hash);
  return ok ? usuario : null;
}

export async function crearHashPassword(password) {
  return await bcrypt.hash(password, 10);
}