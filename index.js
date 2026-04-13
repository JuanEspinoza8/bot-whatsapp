const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
require('dotenv').config();
const http = require('http');
const pino = require('pino');

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
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        // 1. EL DISFRAZ: Le hacemos creer a WhatsApp que somos una PC con Linux
        browser: ["Ubuntu", "Chrome", "120.0.0"], 
        // 2. AHORRO: Le decimos que no descargue el historial viejo para no saturar la RAM
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('¡Escaneá este QR rápido desde tu WhatsApp!');
        }

        if (connection === 'close') {
            const reconectar = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            // 3. LA LUPA: Ahora vemos exactamente por qué falla
            console.log('❌ Conexión cerrada. Error real:', lastDisconnect.error?.message || lastDisconnect.error);
            
            if (reconectar) {
                console.log('⏳ Intentando reconectar en 3 segundos...');
                setTimeout(iniciarBot, 3000); // Pausa de 3 segundos para no hacer spam
            }
        } else if (connection === 'open') {
            console.log('✅ ¡Bot conectado exitosamente! Ya podés mandarle gastos.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        let rawText = m.message.conversation || m.message.extendedTextMessage?.text || "";
        if (!rawText) return;

        const texto = limpiarTexto(rawText);
        const idChat = m.key.remoteJid;
        const telefonoRemitente = m.key.participant || m.key.remoteJid;

        const responder = async (textoRespuesta) => {
            await sock.sendMessage(idChat, { text: textoRespuesta }, { quoted: m });
        };

        // --- TUS COMANDOS ---
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