import bcrypt from 'bcrypt';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  host: 'aws-0-us-west-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.fibjlqgznlpptlfzuwvl',
  password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
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