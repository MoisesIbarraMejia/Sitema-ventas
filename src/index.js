import express from 'express';
import dotenv from 'dotenv';
import { procesarMensajeConIA } from './agent.js';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7860;

// Endpoint Webhook Principal
app.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: "Falta el campo 'message' en el body." });
    }

    console.log(`[POST recibido]: ${message}`);

    // Enviamos el mensaje al agente de Groq + Supabase
    const resultadoIA = await procesarMensajeConIA(message);

    return res.status(200).json({
      success: true,
      agent_response: resultadoIA
    });

  } catch (error) {
    console.error('[Error en Webhook]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Express operando en el puerto ${PORT}`);
});