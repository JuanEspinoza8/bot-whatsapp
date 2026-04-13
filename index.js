const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const http = require('http');
const pino = require('pino'); // Librería para que la consola no se llene de texto basura

// --- CONFIGURACIÓN DE SUPABASE SEGURA ---
const supabaseUrl = process.env.SUPABASE_URL; 
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
// ----------------------------------------

const limpiarTexto = (texto) => {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
};

const formatearFecha = (fechaStr) => {
    const partes = fechaStr.split('/');
    if (partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
};

// --- FUNCIÓN PRINCIPAL DEL BOT CON BAILEYS ---
async function iniciarBot() {
    // Guarda la sesión localmente para no pedir el QR todo el tiempo
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Imprime el QR en la consola de Render
        logger: pino({ level: 'silent' }), // Apaga los logs internos para ver bien el QR
        browser: ["Bot Familiar", "Chrome", "1.0.0"]
    });

    // Guarda las credenciales cuando te conectás
    sock.ev.on('creds.update', saveCreds);

    // Escucha si te conectaste o desconectaste
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reconectar = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexión cerrada. ¿Reconectando?:', reconectar);
            if (reconectar) iniciarBot();
        } else if (connection === 'open') {
            console.log('✅ ¡Bot conectado exitosamente SIN usar Chrome! Memoria salvada.');
        }
    });

    // Escucha los mensajes
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        // Extraer el texto (Baileys maneja los textos de una forma un poco más compleja)
        let rawText = m.message.conversation || m.message.extendedTextMessage?.text || "";
        if (!rawText) return;

        const texto = limpiarTexto(rawText);
        
        // El ID del grupo donde se mandó el mensaje
        const idChat = m.key.remoteJid;
        // El número de la persona real que lo mandó (si es en un grupo, participant. Si es privado, remoteJid)
        const telefonoRemitente = m.key.participant || m.key.remoteJid;

        // Función ayudante para responder rápido
        const responder = async (textoRespuesta) => {
            await sock.sendMessage(idChat, { text: textoRespuesta }, { quoted: m });
        };

        // --- ACÁ EMPIEZAN TUS COMANDOS DE SIEMPRE ---

        if (texto === 'info') {
            const mensajeInfo = `🤖 *BOT FAMILIAR DE GASTOS* 🤖\n\n📝 *Anotar:* _costo 20000_\n📅 *Mes:* _total mes_\n📊 *Resumen:* _resumen mes_\n👤 *Lo tuyo:* _mis gastos mes_\n📆 *Fechas:* _total desde DD/MM/AAAA hasta DD/MM/AAAA_\n💰 *Histórico:* _total historico_`;
            await responder(mensajeInfo);
        }

        else if (texto.startsWith('costo ')) {
            let numeroCrudo = texto.replace('costo', '').replace(/[.,\s]/g, '');
            let soloNumeros = numeroCrudo.match(/^\d+/); 
            
            if (soloNumeros) {
                let monto = parseInt(soloNumeros[0]);
                const { error } = await supabase.from('gastos').insert([{ telefono: telefonoRemitente, monto: monto }]);

                if (error) {
                    await responder('❌ Hubo un error al guardar en la base de datos.');
                } else {
                    await responder(`Anotado: $${monto} ✅`);
                }
            } else {
                await responder(`Mmm, no entendí. Escribí por ejemplo: costo 20000`);
            }
        }

        else if (texto === 'total mes') {
            const fechaActual = new Date();
            const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();
            const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', primerDiaDelMes);

            if (!error) {
                const totalMes = data.reduce((acc, gasto) => acc + gasto.monto, 0);
                await responder(`📅 Gasto total de este mes: *$${totalMes}*`);
            }
        }

        else if (texto === 'mis gastos mes') {
            const fechaActual = new Date();
            const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();
            const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', primerDiaDelMes).eq('telefono', telefonoRemitente);

            if (!error) {
                const totalMio = data.reduce((acc, gasto) => acc + gasto.monto, 0);
                await responder(`👤 Este mes vos sacaste fiado: *$${totalMio}*`);
            }
        }

        else if (texto === 'resumen mes') {
            const fechaActual = new Date();
            const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();
            const { data, error } = await supabase.from('gastos').select('telefono, monto').gte('fecha', primerDiaDelMes);

            if (!error && data.length > 0) {
                const resumen = data.reduce((acc, gasto) => {
                    acc[gasto.telefono] = (acc[gasto.telefono] || 0) + gasto.monto;
                    return acc;
                }, {});

                let mensajeResumen = `📊 *RESUMEN DEL MES POR PERSONA* 📊\n\n`;
                for (const [telefono, total] of Object.entries(resumen)) {
                    let numeroLimpio = telefono.split('@')[0];
                    mensajeResumen += `📱 ${numeroLimpio}: *$${total}*\n`;
                }
                await responder(mensajeResumen);
            } else if (data && data.length === 0) {
                await responder('Todavía no hay gastos este mes.');
            }
        }

        else if (texto.startsWith('total desde ') && texto.includes(' hasta ')) {
            const regexFechas = /total desde (\d{1,2}\/\d{1,2}\/\d{4}) hasta (\d{1,2}\/\d{1,2}\/\d{4})/;
            const match = texto.match(regexFechas);

            if (match) {
                const fechaInicio = formatearFecha(match[1]);
                const fechaFin = formatearFecha(match[2]);

                if (fechaInicio && fechaFin) {
                    const fechaFinObjeto = new Date(fechaFin);
                    fechaFinObjeto.setDate(fechaFinObjeto.getDate() + 1);
                    const fechaFinReal = fechaFinObjeto.toISOString();

                    const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', `${fechaInicio}T00:00:00.000Z`).lte('fecha', fechaFinReal);

                    if (!error) {
                        const totalPeriodo = data.reduce((acc, gasto) => acc + gasto.monto, 0);
                        await responder(`📆 Gasto entre ${match[1]} y ${match[2]}: *$${totalPeriodo}*`);
                    }
                }
            }
        }

        else if (texto === 'total historico') {
            const { data, error } = await supabase.from('gastos').select('monto');
            if (!error) {
                const total = data.reduce((acc, gasto) => acc + gasto.monto, 0);
                await responder(`💸 Deuda total histórica acumulada: *$${total}*`);
            }
        }
    });
}

// --- SERVIDOR WEB FALSO PARA RENDER ---
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.write("El bot familiar funciona de 10");
    res.end();
}).listen(port, () => {
    console.log(`Servidor de coartada escuchando en el puerto ${port}`);
});
// --------------------------------------

iniciarBot();